export type StuckKind = 'repeating' | 'no-new-output' | 'silent'

export type Stuck = { kind: StuckKind; since: number; detail: string }

export type Steps = { done: number; total: number; note: string }

export type AgentRow = {
  id: string
  description: string
  type: string
  model: string
  status: string
  startedAt: number
  lastActivityAt: number
  toolCalls: number
  lastTool: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  contextTokens: number
  effort: string
  steps: Steps | null
  endedAt: number
  stuck: Stuck | null
}

export type JobRow = {
  id: string
  label: string
  path: string
  startedAt: number
  size: number
  lastNovelAt: number
  lastLine: string
  isDone: boolean
  doneAt: number
  stuck: Stuck | null
}

declare module 'claude-code' {
  interface PluginState {
    'crew-watch': {
      agents: Record<string, AgentRow>
      jobs: Record<string, JobRow>
      isBandHidden: boolean
      clock: number
    }
  }
}
