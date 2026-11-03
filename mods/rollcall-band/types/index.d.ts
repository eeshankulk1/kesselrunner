export type Peer = {
  /** The session id's first 8 characters, as `rollcall send` takes it. */
  id: string
  branch: string
  /** Its claim's intent, or its first prompt when it has claimed nothing. */
  doing: string
  isWaitingOnYou: boolean
}

export type RepoLine = {
  repo: string
  branch: string
  /** The worktree's folder name; null in the repo's main checkout. */
  worktree: string | null
  claim: string | null
  /** The task this session works on, when it is a task's worker or its checkout is a task's worktree. */
  task: string | null
  /** Live sessions in the repo, this one left out. */
  peers: Peer[]
  /** Sessions rollcall still lists that are no longer live. */
  idle: number
}

export type Snapshot = {
  /** This session's repo, or null outside one, and in a supervisor (its chips are in the status line). */
  line: RepoLine | null
  /** True when rollcall expects a newer band than this one (it loaded before a sync): /reload-plugins. */
  stale?: boolean
  /** True in a supervisor: above its picker, each question's task is drawn in the task's color. */
  supervisor?: boolean
  /** A supervisor's task titles by id ("t3"), for the label drawn above its picker. */
  titles?: Record<string, string>
}

declare module 'claude-code' {
  interface PluginState {
    'rollcall-band': {
      snapshot: Snapshot | null
    }
  }
}
