import { expect, test } from 'claude-code/testing'

const failing = { stdout: 'HTTP 422 Unprocessable Entity', stderr: '', interrupted: false }

test('the 4th identical call with an identical answer is flagged to the model', async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ({ result: failing, text: failing.stdout }))

  const calls = []
  for (let i = 0; i < 4; i++) {
    calls.push(await $.tool.call({ tool: 'Bash', command: 'curl -s "https://api.example.com/search?q=widgets"' }))
  }

  for (const early of calls.slice(0, 3)) expect(early.context ?? []).toEqual([])
  const fourth = calls[3]?.context ?? []
  expect(fourth.length).toBe(1)
  expect(fourth[0]).toContain('crew-watch: this is the 4th time')
})

test('the same call with a changing answer is progress, not a loop', async ($, on) => {
  let n = 0
  on('tool.call', { tool: 'Bash' }, () => {
    n += 1
    return { result: { stdout: `${n * 100} rows`, stderr: '', interrupted: false }, text: `${n * 100} rows` }
  })

  let last
  for (let i = 0; i < 6; i++) last = await $.tool.call({ tool: 'Bash', command: 'wc -l corpus.jsonl' })
  expect(last?.context ?? []).toEqual([])
})
