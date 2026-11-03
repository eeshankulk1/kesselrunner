// What pr-band asks GitHub and how it reads the answer. Pure: no `$` here.

import type { PrItem, PrSnapshot } from '../types'

/** How long after its merge a PR stays, once everything the merge started has settled. */
export const LINGER_MS = 30 * 60_000
/** How long a merge may stay unsettled (a deployment that never reports) before the band gives up on it. */
export const GIVE_UP_MS = 3 * 60 * 60_000
/** How long a merge gets to start its first check or deployment. */
const REGISTER_MS = 2 * 60_000

const ROLLUP = `fragment Rollup on Commit {
  oid
  statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion detailsUrl startedAt }
    ... on StatusContext { context state targetUrl createdAt }
  } } }
}`

const PR = `fragment Pr on PullRequest {
  number title url state isDraft mergeStateStatus baseRefName mergedAt
  commits(last: 1) { nodes { commit { ...Rollup } } }
  mergeCommit {
    ...Rollup
    deployments(first: 30) { nodes { environment state createdAt latestStatus { state environmentUrl logUrl } } }
  }
}`

// The manifest is the default branch's: what a merge is held to.
const REPO = `nameWithOwner
  defaultBranchRef { name target { ... on Commit { statusCheckRollup { state } } } }
  manifest: object(expression: "HEAD:.claude/test-manifest.json") { ... on Blob { text } }`

/** The PRs whose head is a branch, newest first. */
export const BY_BRANCH = `${ROLLUP}
${PR}
query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    ${REPO}
    pullRequests(headRefName: $branch, first: 5, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...Pr } }
  }
}`

/** One PR by its number. */
export const BY_NUMBER = `${ROLLUP}
${PR}
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    ${REPO}
    pullRequest(number: $number) { ...Pr }
  }
}`

type Context = {
  __typename: string
  name?: string
  status?: string
  conclusion?: string | null
  detailsUrl?: string | null
  startedAt?: string | null
  context?: string
  state?: string
  targetUrl?: string | null
  createdAt?: string | null
}
type Commit = { oid: string; statusCheckRollup: { contexts: { nodes: Context[] } } | null }
type Deployment = {
  environment: string | null
  state: string | null
  createdAt: string
  latestStatus: { state: string; environmentUrl: string | null; logUrl: string | null } | null
}
type PullRequest = {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  mergeStateStatus: string
  baseRefName: string
  mergedAt: string | null
  commits: { nodes: { commit: Commit }[] }
  mergeCommit: (Commit & { deployments: { nodes: Deployment[] } }) | null
}
export type Repository = {
  nameWithOwner: string
  defaultBranchRef: { name: string; target: { statusCheckRollup: { state: string } | null } | null } | null
  manifest: { text?: string } | null
  pullRequests?: { nodes: PullRequest[] }
  pullRequest?: PullRequest | null
}

/** The repository in what `gh api graphql` printed, or null. */
export function parse(stdout: string): Repository | null {
  try {
    const body = JSON.parse(stdout) as { data?: { repository?: Repository | null } }
    return body.data?.repository ?? null
  } catch {
    return null
  }
}

/** The PR a response is about: the one asked for by number, or the branch's open one, else its latest merged. */
function chosen(repo: Repository): PullRequest | null {
  if (repo.pullRequest) {
    return repo.pullRequest
  }
  const nodes = repo.pullRequests?.nodes ?? []
  return nodes.find(pr => pr.state === 'OPEN') ?? nodes.find(pr => pr.state === 'MERGED') ?? null
}

const CHECK_OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const DEPLOY_OK = new Set(['SUCCESS', 'ACTIVE', 'INACTIVE'])
const DEPLOY_FAILED = new Set(['FAILURE', 'ERROR'])
const DEPLOY_GONE = new Set(['ABANDONED', 'DESTROYED'])

function checkState(c: Context): PrItem['state'] {
  if (c.__typename === 'StatusContext') {
    return c.state === 'SUCCESS' ? 'ok' : c.state === 'FAILURE' || c.state === 'ERROR' ? 'failed' : 'running'
  }
  if (c.status === 'COMPLETED') {
    return CHECK_OK.has(c.conclusion ?? '') ? 'ok' : 'failed'
  }
  return c.status === 'IN_PROGRESS' ? 'running' : 'queued'
}

/** A commit's checks and statuses, the latest run of each name. */
function checksOf(commit: Commit | null | undefined): PrItem[] {
  const latest = new Map<string, { at: string; item: PrItem }>()
  for (const c of commit?.statusCheckRollup?.contexts.nodes ?? []) {
    const name = c.name ?? c.context ?? ''
    const at = c.startedAt ?? c.createdAt ?? ''
    const seen = latest.get(name)
    if (seen === undefined || at >= seen.at) {
      latest.set(name, { at, item: { name, state: checkState(c), url: c.detailsUrl ?? c.targetUrl ?? null } })
    }
  }
  return [...latest.values()].map(entry => entry.item)
}

/** A merge commit's deployments, the latest of each environment. */
function deploysOf(nodes: Deployment[]): PrItem[] {
  const latest = new Map<string, Deployment>()
  for (const d of nodes) {
    const name = d.environment ?? 'deployment'
    const seen = latest.get(name)
    if (seen === undefined || d.createdAt >= seen.createdAt) {
      latest.set(name, d)
    }
  }
  const items: PrItem[] = []
  for (const [name, d] of latest) {
    const state = d.latestStatus?.state ?? d.state ?? ''
    if (DEPLOY_GONE.has(state)) {
      continue
    }
    items.push({
      name,
      state: DEPLOY_OK.has(state) ? 'ok' : DEPLOY_FAILED.has(state) ? 'failed' : state === 'IN_PROGRESS' ? 'running' : 'queued',
      url: d.latestStatus?.environmentUrl || d.latestStatus?.logUrl || null,
    })
  }
  return items
}

const MERGE: Record<string, PrSnapshot['merge']> = {
  CLEAN: 'clean',
  HAS_HOOKS: 'clean',
  DIRTY: 'conflicts',
  BEHIND: 'behind',
  BLOCKED: 'blocked',
  UNSTABLE: 'unstable',
}

/** The first word that releases production, when the repo's test manifest makes it a step of its own. */
function productionWordOf(manifest: string | undefined): string | null {
  try {
    const word = JSON.parse(manifest ?? '{}')?.release?.production?.words?.[0]
    return typeof word === 'string' ? word : null
  } catch {
    return null
  }
}

/** What the band shows for a response, or null: no PR, or a closed one. */
export function summarize(repo: Repository | null, now: number): PrSnapshot | null {
  const pr = repo === null ? null : chosen(repo)
  if (repo === null || pr === null || pr.state === 'CLOSED') {
    return null
  }
  const isMerged = pr.state === 'MERGED'
  const items = checksOf(isMerged ? pr.mergeCommit : pr.commits.nodes[0]?.commit)
  const deploys = isMerged ? deploysOf(pr.mergeCommit?.deployments.nodes ?? []) : []
  const mergedAt = pr.mergedAt === null ? null : Date.parse(pr.mergedAt)
  const isPending = [...items, ...deploys].some(i => i.state === 'running' || i.state === 'queued')
  const hasStarted = items.length + deploys.length > 0 || (mergedAt !== null && now - mergedAt > REGISTER_MS)
  const baseState = repo.defaultBranchRef?.target?.statusCheckRollup?.state
  // The manifest and the red-base check are the default branch's: they say nothing about a stacked PR's base.
  const isOnDefault = repo.defaultBranchRef?.name === pr.baseRefName
  const word = isMerged && isOnDefault ? productionWordOf(repo.manifest?.text) : null

  return {
    repo: repo.nameWithOwner,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    phase: isMerged ? 'merged' : pr.isDraft ? 'draft' : 'open',
    base: pr.baseRefName,
    merge: MERGE[pr.mergeStateStatus] ?? 'unknown',
    checks: {
      ok: items.filter(i => i.state === 'ok').length,
      running: items.filter(i => i.state === 'running').length,
      queued: items.filter(i => i.state === 'queued').length,
      failed: items.filter(i => i.state === 'failed'),
    },
    deploys,
    sha: isMerged ? (pr.mergeCommit?.oid.slice(0, 7) ?? null) : null,
    mergedAt,
    isSettled: !isPending && (!isMerged || hasStarted),
    isBaseRed: !isMerged && isOnDefault && (baseState === 'FAILURE' || baseState === 'ERROR'),
    productionWord: deploys.some(d => /prod/i.test(d.name)) ? null : word,
  }
}

/** Whether a PR is still worth a line: open, or merged with something unsettled or only just settled. */
export function isLive(snap: PrSnapshot | null, now: number): snap is PrSnapshot {
  if (snap === null) {
    return false
  }
  if (snap.phase !== 'merged') {
    return true
  }
  const age = now - (snap.mergedAt ?? 0)
  return snap.isSettled ? age < LINGER_MS : age < GIVE_UP_MS
}

/** What to say when a PR moves from one reading to the next, or null. */
export function transition(before: PrSnapshot | null, after: PrSnapshot | null): string | null {
  if (before === null || after === null || before.repo !== after.repo || before.number !== after.number) {
    return null
  }
  const pr = `PR #${after.number}`
  if (before.phase !== 'merged' && after.phase === 'merged') {
    return `${pr} merged`
  }
  if (before.isSettled || !after.isSettled) {
    return null
  }
  const failed = [...after.checks.failed, ...after.deploys.filter(d => d.state === 'failed')]
  if (failed.length > 0) {
    return `${pr}: ${failed.length} failed (${failed.map(f => f.name).join(', ')})`
  }
  if (after.phase !== 'merged') {
    return `${pr}: checks green`
  }
  if (after.deploys.length > 0) {
    return `${pr}: deployed (${after.deploys.map(d => d.name).join(', ')})`
  }
  return after.checks.ok > 0 ? `${pr}: ${after.base} is green after the merge` : null
}
