import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, JobRow, Stuck } from '../types'

// crew-watch: a live panel of subagents and background jobs, built to catch
// a failure that once cost a long research run a night: a data collector
// retrying a 422 for hours while its subagent kept reporting "still waiting".
//
// Three signals, each raised once when it starts and cleared when it stops:
//   repeating      a loop made the same tool call and got the same answer
//                  REPEAT_LIMIT times recently. The model is told on the spot.
//   no-new-output  a background job's log has said nothing new for STALE_MS.
//                  Retry/backoff/error lines count as old news even when their
//                  numbers change. Claude is woken to deal with it.
//   silent         a running subagent has made no model call or tool call for
//                  SILENT_MS. Shown, not acted on (a long build looks the same).

const TICK_MS = 60_000
let STALE_MS = 20 * 60_000
let SILENT_MS = 20 * 60_000
let shouldWake = true
const REPEAT_WINDOW = 12
const REPEAT_LIMIT = 4
const TAIL_LINES = 60
const SEEN_CAP = 2_000

const agents = atom({ plugin: 'crew-watch', key: 'agents' } as const, {})
const jobs = atom({ plugin: 'crew-watch', key: 'jobs' } as const, {})
const isBandHidden = atom({ plugin: 'crew-watch', key: 'isBandHidden' } as const, false)
const clock = atom({ plugin: 'crew-watch', key: 'clock' } as const, 0)

// A line that reports trouble or waiting. Its numbers are stripped before it is
// compared, so "retry 3/12, sleeping 60s" and "retry 4/12, sleeping 120s" are
// the same line. Any other line counts as new whenever its text changes, so a
// progress counter ("1200/50000 rows") keeps a job alive.
const NOISY = /error|retry|retrying|backoff|back off|rate.?limit|throttl|timeout|timed out|failed|failure|\b(4\d\d|5\d\d)\b|sleeping|waiting|still running|no results/i

const hash = (text: string) => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return h.toString(36)
}

const normalize = (line: string) => {
  const trimmed = line.trim()
  return NOISY.test(trimmed) ? trimmed.replace(/\d+(\.\d+)?/g, '#') : trimmed
}

const minutes = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n))

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

// The shell a command runs, with what it only carries as text taken out:
// heredoc bodies and quoted strings. A script that writes the word "nohup"
// or a "<session>/x" path into a file is not starting a background job.
const shellOf = (command: string) =>
  command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, ' ')
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ' ')

// The file a detached shell job writes to: the last redirect in a command that
// runs nohup, setsid or ends with &. "2>&1" and /dev/null are not targets.
const detachedLogOf = (raw: string, cwd: string) => {
  const command = shellOf(raw)
  if (!/\bnohup\b|\bsetsid\b|&\s*(disown\s*)?$|&\s*\)?\s*;|&\s*echo\b/m.test(command)) return null
  const targets = [...command.matchAll(/(?:&>|>>|>)\s*["']?([^\s&;|<>"']+)/g)]
    .map(m => m[1] ?? '')
    .filter(t => t !== '' && !t.startsWith('/dev/'))
  const target = targets.at(-1)
  if (target === undefined) return null
  if (target.startsWith('/')) return target
  const cd = command.match(/^\s*cd\s+["']?([^\s&;"']+)["']?\s*&&/)
  const dir = cd?.[1]
  const base = dir === undefined ? cwd : dir.startsWith('/') ? dir : `${cwd}/${dir}`
  return `${base}/${target}`
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(block => (typeof block === 'object' && block !== null && 'text' in block ? String((block as { text: unknown }).text) : '')).join('\n')
      : ''

// Recent calls per loop ('main' or a subagent id), for the repeat check.
const recent = new Map<string, { call: string; answer: string }[]>()
// Normalized lines each job has already printed.
const seen = new Map<string, Set<string>>()
let cwd = ''

async function ensureAgent($: EngineInterface, agentId: string) {
  const known = (await read($, agents))[agentId]
  if (known !== undefined) return
  const now = Date.now()
  const info = (await $.agent.list()).find((a: { id: string }) => a.id === agentId)
  const row: AgentRow = {
    id: agentId,
    description: info?.description ?? 'subagent',
    type: info?.type ?? '',
    model: '',
    status: info?.status ?? 'running',
    startedAt: now,
    lastActivityAt: now,
    toolCalls: 0,
    lastTool: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    effort: '',
    steps: null,
    endedAt: 0,
    stuck: null,
  }
  await update($, agents, all => ({ ...all, [agentId]: all[agentId] ?? row }))
}

async function touchAgent($: EngineInterface, agentId: string, patch: (row: AgentRow) => Partial<AgentRow>) {
  await ensureAgent($, agentId)
  await update($, agents, all => {
    const row = all[agentId]
    return row === undefined ? all : { ...all, [agentId]: { ...row, ...patch(row) } }
  })
}

async function watchJob($: EngineInterface, id: string, label: string, path: string) {
  const now = Date.now()
  const row: JobRow = { id, label, path, startedAt: now, size: 0, lastNovelAt: now, lastLine: '', isDone: false, doneAt: 0, stuck: null }
  await update($, jobs, all => (all[id] === undefined ? { ...all, [id]: row } : all))
}

async function wake($: EngineInterface, text: string) {
  if (!shouldWake) return
  try {
    await $.prompt.submit({ text })
  } catch {
    // A -p run or a refused prompt: the toast and the panel still show it.
  }
}

async function checkJob($: EngineInterface, job: JobRow, now: number) {
  let size = job.size
  try {
    size = (await $.fs.stat(job.path)).size
  } catch {
    // A log that never appeared is no job: drop it rather than call it stuck.
    return now - job.startedAt > 2 * TICK_MS ? { ...job, isDone: true, doneAt: now, lastLine: 'its log file never appeared', stuck: null } : job
  }
  let { lastNovelAt, lastLine } = job
  if (size !== job.size) {
    const tail = await $.process.run(['tail', '-n', String(TAIL_LINES), job.path])
    const lines = tail.stdout.split('\n').filter((l: string) => l.trim() !== '')
    const known = seen.get(job.id) ?? new Set<string>()
    for (const line of lines) {
      const key = normalize(line)
      if (!known.has(key)) {
        known.add(key)
        lastNovelAt = now
      }
    }
    if (known.size > SEEN_CAP) seen.set(job.id, new Set([...known].slice(-SEEN_CAP / 2)))
    else seen.set(job.id, known)
    lastLine = lines.at(-1) ?? lastLine
  }

  // A detached job is over once no process holds its log open. Background
  // Bash tasks are closed by their task notification instead (below).
  let isDone = false
  if (!job.id.startsWith('task:') && size === job.size) {
    const holders = await $.process.run(['lsof', '-t', job.path]).catch(() => null)
    isDone = holders !== null && holders.stdout.trim() === ''
  }

  const quietFor = now - lastNovelAt
  let stuck: Stuck | null = null
  if (!isDone && quietFor > STALE_MS) {
    stuck = job.stuck ?? {
      kind: 'no-new-output',
      since: lastNovelAt,
      detail: size > 0 ? `last line: ${clip(lastLine, 160)}` : 'it has written nothing',
    }
  }
  return { ...job, size, lastNovelAt, lastLine, isDone, doneAt: isDone ? now : 0, stuck }
}

async function tick($: EngineInterface) {
  const now = Date.now()

  // Jobs.
  const before = await read($, jobs)
  const after: Record<string, JobRow> = {}
  for (const job of Object.values(before)) {
    after[job.id] = job.isDone ? job : await checkJob($, job, now)
  }
  await update($, jobs, all => {
    const merged = { ...all }
    for (const job of Object.values(after)) if (merged[job.id] !== undefined) merged[job.id] = job
    return merged
  })
  for (const job of Object.values(after)) {
    if (job.stuck !== null && before[job.id]?.stuck === null) {
      const quiet = minutes(now - job.lastNovelAt)
      $.ui.toast(`crew-watch: ${job.label} has said nothing new for ${quiet}`, { timeoutMs: 15_000 })
      await wake(
        $,
        `crew-watch: the background job "${job.label}" (log: ${job.path}) has printed nothing new for ${quiet}. ` +
          `Its last line: "${clip(job.lastLine, 300)}". ` +
          'Check whether it is stuck retrying the same failing request. If it is, kill the process, ' +
          'say in one line what it was trying and why it failed, and change approach. ' +
          'Do not wait on it or report that it is still running.',
      )
    }
  }

  // Agents.
  const listed = await $.agent.list().catch(() => [])
  const status = new Map<string, string>(listed.map((a: { id: string; status: string }) => [a.id, a.status]))
  const agentsBefore = await read($, agents)
  await update($, agents, all => {
    const next: Record<string, AgentRow> = {}
    for (const row of Object.values(all)) {
      const state = status.get(row.id) ?? (row.status === 'running' ? 'completed' : row.status)
      const isRunning = state === 'running'
      const isSilent = isRunning && now - row.lastActivityAt > SILENT_MS
      const stuck: Stuck | null =
        row.stuck?.kind === 'repeating' && isRunning
          ? row.stuck
          : isSilent
            ? row.stuck ?? { kind: 'silent', since: row.lastActivityAt, detail: `no model or tool call since ${row.lastTool || 'it started'}` }
            : null
      const hasEnded = !isRunning && state !== 'waiting' && state !== 'idle' && state !== 'pending'
      next[row.id] = { ...row, status: state, stuck, endedAt: hasEnded ? row.endedAt || now : 0 }
    }
    return next
  })
  const agentsAfter = await read($, agents)
  for (const row of Object.values(agentsAfter)) {
    if (row.stuck?.kind === 'silent' && agentsBefore[row.id]?.stuck === null) {
      $.ui.toast(`crew-watch: ${clip(row.description, 40)} has been silent ${minutes(now - row.lastActivityAt)}`, { timeoutMs: 15_000 })
    }
  }

  await update($, clock, () => now)
}

export const register: Register = (on, options) => {
  const stuckMinutes = Number(options.stuckMinutes ?? 20)
  STALE_MS = SILENT_MS = Math.max(1, Number.isFinite(stuckMinutes) ? stuckMinutes : 20) * 60_000
  shouldWake = options.wakeClaude !== false

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({ name: 'crew', description: 'List background jobs and anything crew-watch thinks is stuck' })
    $.clock.every(TICK_MS, () => {
      void tick($).catch(() => undefined)
    })
    return next(e)
  })

  on('command.run', { command: 'crew' }, async $ => {
    const now = Date.now()
    const stuckAgents = Object.values(await read($, agents)).filter(a => a.stuck !== null && (a.status === 'running' || a.status === 'waiting'))
    const liveJobs = Object.values(await read($, jobs)).filter(j => !j.isDone)
    const lines = [
      ...stuckAgents.map(a => `⚠ subagent "${a.description}": ${a.stuck?.kind === 'repeating' ? 'repeating itself' : 'gone quiet'}, ${a.stuck?.detail}`),
      ...liveJobs.map(j => `${j.stuck === null ? '●' : '⚠'} job ${j.label}: new output ${minutes(now - j.lastNovelAt)} ago${j.lastLine ? `, last line: ${clip(j.lastLine, 120)}` : ''}`),
    ]
    return { text: lines.length === 0 ? 'crew-watch: nothing running in the background and nothing stuck.' : `crew-watch:\n${lines.join('\n')}` }
  })

  on('tool.call', async ($, e, next) => {
    const loop = e.agentId ?? 'main'
    if (e.agentId !== undefined) {
      await touchAgent($, e.agentId, row => ({ lastTool: e.tool, toolCalls: row.toolCalls + 1, lastActivityAt: Date.now() })).catch(() => undefined)
    }

    const ran = await next(e)

    try {
      const now = Date.now()
      if (e.agentId !== undefined) await touchAgent($, e.agentId, () => ({ lastActivityAt: now }))

      // Background Bash: watch its output file until its task notification.
      if (e.tool === 'Bash' && ran.deny === undefined) {
        const outputPath = ran.text?.match(/written to: (\S+?\.output)/)?.[1]
        if (outputPath !== undefined) {
          const taskId = ran.text?.match(/with ID: (\w+)/)?.[1] ?? hash(outputPath)
          await watchJob($, `task:${taskId}`, clip(e.description ?? e.command, 60), outputPath)
        }
        const logPath = detachedLogOf(e.command, cwd)
        if (logPath !== null) await watchJob($, `log:${logPath}`, logPath.split('/').at(-1) ?? logPath, logPath)
      }

      // The repeat check. A call is the tool and its input; an answer is what
      // the model read back. The same pair REPEAT_LIMIT times means no progress.
      const { tool_use_id: _id, agentId: _agent, ...input } = e as typeof e & { agentId?: string }
      const call = hash(JSON.stringify(input))
      const answer = hash(ran.deny ?? ran.text ?? '')
      const list = [...(recent.get(loop) ?? []), { call, answer }].slice(-REPEAT_WINDOW)
      recent.set(loop, list)
      const repeats = list.filter(one => one.call === call && one.answer === answer).length
      if (repeats >= REPEAT_LIMIT && ran.deny === undefined) {
        const what = e.tool === 'Bash' ? clip(e.command, 80) : e.tool
        if (e.agentId !== undefined) {
          await touchAgent($, e.agentId, row => ({
            stuck: row.stuck?.kind === 'repeating' ? row.stuck : { kind: 'repeating', since: now, detail: `${repeats}× the same call, same answer: ${what}` },
          }))
        }
        if (repeats === REPEAT_LIMIT) {
          try {
            $.ui.toast(`crew-watch: ${e.agentId === undefined ? 'main session' : 'a subagent'} is repeating ${what}`, { timeoutMs: 15_000 })
          } catch {
            // No surface to toast on: the model is still told below.
          }
        }
        return {
          ...ran,
          context: [
            ...(ran.context ?? []),
            `crew-watch: this is the ${repeats}th time in your last ${list.length} tool calls that you ran exactly this call and got exactly this result. ` +
              'Repeating it will not change the outcome. Stop, say what is blocking you, and try a different approach or report the blocker.',
          ],
        }
      }
      if (e.agentId !== undefined && repeats < 2) {
        await touchAgent($, e.agentId, row => (row.stuck?.kind === 'repeating' ? { stuck: null } : {}))
      }
    } catch (err) {
      // Watching must never change what the tool answered.
      try {
        $.ui.log(`crew-watch: tool.call watcher failed: ${String(err)}`)
      } catch {
        // Nowhere to say it.
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId !== undefined) {
      const usage = result.usage
      const now = Date.now()
      await touchAgent($, e.agentId, row => ({
        model: usage?.model ?? e.model,
        effort: e.effort === undefined ? row.effort : String(e.effort),
        lastActivityAt: now,
        inputTokens: row.inputTokens + (usage?.input_tokens ?? 0),
        outputTokens: row.outputTokens + (usage?.output_tokens ?? 0),
        cacheReadTokens: row.cacheReadTokens + (usage?.cache_read_input_tokens ?? 0),
        cacheWriteTokens: (row.cacheWriteTokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
        // What this step sent is the agent's context right now.
        contextTokens:
          usage === null ? row.contextTokens : usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
      })).catch(() => undefined)
    }
    return result
  })

  // A background task's notification closes its job.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    try {
      const text = textOf(e.message.content)
      if (text.includes('<task-notification>')) {
        const id = text.match(/<task-id>(\w+)<\/task-id>/)?.[1]
        if (id !== undefined && /<status>(completed|failed|killed|stopped)<\/status>/.test(text)) {
          await update($, jobs, all => {
            const job = all[`task:${id}`]
            return job === undefined ? all : { ...all, [job.id]: { ...job, isDone: true, doneAt: Date.now(), stuck: null } }
          })
        }
      }
    } catch {
      // Never interfere with what the session stores.
    }
    return stored
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (await read($, isBandHidden)) return next(e)
    const allAgents = Object.values(await read($, agents))
    const allJobs = Object.values(await read($, jobs))
    const running = allAgents.filter(a => a.status === 'running' || a.status === 'waiting')
    const live = allJobs.filter(j => !j.isDone)
    if (running.length === 0 && live.length === 0) return next(e)
    const now = (await read($, clock)) || Date.now()
    const stuck = [...allAgents.filter(a => a.stuck !== null && (a.status === 'running' || a.status === 'waiting')), ...live.filter(j => j.stuck !== null)]
    const { Box, Text, Button } = $.ui.resolve(e)
    const first = stuck[0]
    const firstLabel = first === undefined ? '' : 'label' in first ? first.label : first.description

    return (
      <Box>
        <Text color={stuck.length > 0 ? 'warning' : 'subtle'}>
          {stuck.length > 0 ? '⚠ ' : ''}crew: {running.length} agent{running.length === 1 ? '' : 's'}, {live.length} job{live.length === 1 ? '' : 's'}
          {first !== undefined && first.stuck !== null ? ` · ${clip(firstLabel, 40)} stuck ${minutes(now - first.stuck.since)}` : ''}{' '}
        </Text>
        <Button key="hide" label="Hide" onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )
  })
}
