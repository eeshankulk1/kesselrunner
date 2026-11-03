/** One check, status or deployment, as far as it has got. */
export type PrItem = {
  name: string
  state: 'ok' | 'failed' | 'running' | 'queued'
  url: string | null
}

export type PrSnapshot = {
  /** `owner/name`. */
  repo: string
  number: number
  title: string
  url: string
  phase: 'open' | 'draft' | 'merged'
  base: string
  /** GitHub's verdict on merging an open PR. */
  merge: 'clean' | 'conflicts' | 'behind' | 'blocked' | 'unstable' | 'unknown'
  /** Open: the head commit's checks. Merged: what the merge commit started. */
  checks: { ok: number; running: number; queued: number; failed: PrItem[] }
  /** Merged: the latest deployment of each environment the merge commit reached. */
  deploys: PrItem[]
  /** Merged: the merge commit, short. */
  sha: string | null
  /** Merged: when, in `$.clock.now()`'s milliseconds. */
  mergedAt: number | null
  /** Nothing is running or queued (and, merged, the merge has had time to start something). */
  isSettled: boolean
  /** Open: the base branch's own last commit is failing. */
  isBaseRed: boolean
  /**
   * Merged, in a repo whose test manifest makes production its own step, with
   * no production deployment on the merge commit: the word that starts its release.
   */
  productionWord: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'pr-band': { snapshot: PrSnapshot | null }
  }
}
