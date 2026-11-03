// The pure half of clickable: where a reply's code blocks and paths are, and
// how a path becomes a link. No `$`, so tests call it directly.

/** A run of a reply's markdown: prose, or one fenced code block (`text` the fence as written, `body` what a copy takes). */
export type Piece = { kind: 'text'; text: string } | { kind: 'code'; text: string; body: string }

const OPEN = /^( *)(`{3,}|~{3,})([^`]*)$/

/**
 * Splits markdown into prose and fenced code blocks, CommonMark's way: a fence
 * of three or more backticks or tildes, closed by a fence of the same character
 * at least as long. A block still open at the end (a reply mid-stream) stays
 * prose, so it gets no copy link until it closes.
 */
export function splitFences(markdown: string): Piece[] {
  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const pieces: Piece[] = []
  let prose = ''
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN.exec(strip(lines[i] ?? ''))
    const close = open === null ? -1 : closingLine(lines, i, open[2] ?? '')
    if (open === null || close < 0) {
      prose += lines[i]
      continue
    }
    if (prose !== '') pieces.push({ kind: 'text', text: prose })
    prose = ''
    const indent = (open[1] ?? '').length
    const inner = lines.slice(i + 1, close).map(line => dedent(strip(line), indent))
    pieces.push({ kind: 'code', text: lines.slice(i, close + 1).join(''), body: inner.join('\n') })
    i = close
  }
  if (prose !== '') pieces.push({ kind: 'text', text: prose })
  return pieces
}

function closingLine(lines: string[], from: number, fence: string): number {
  const close = new RegExp(`^ *\\${fence[0]}{${fence.length},} *$`)
  for (let j = from + 1; j < lines.length; j++) {
    if (close.test(strip(lines[j] ?? ''))) return j
  }
  return -1
}

const strip = (line: string) => line.replace(/\r?\n$/, '')
const dedent = (line: string, indent: number) => line.replace(new RegExp(`^ {0,${indent}}`), '')

/** One place in prose that may be linked: `start`/`end` in the text, what it points at, and how to write the link. */
export type Candidate = {
  start: number
  end: number
  /** A web URL, which links to itself with no lookup. */
  url?: string
  /** Paths to look up, `:line` and trailing punctuation cut off; for a bare path, longest first. */
  paths: string[]
  /** The text the link is drawn with, and where it ends, given the path that exists. */
  label: (path: string) => { label: string; end: number }
}

// Skipped whole, so nothing inside is touched: links and images, and
// autolinks, which draw as links already. A bare URL becomes an explicit link,
// so a long one the terminal wraps still opens whole. Then the two ways a path
// is written: a code span, or a bare token with a slash in it.
const SCAN = new RegExp(
  [
    String.raw`(?<link>!?\[[^\]\n]*\]\([^)\n]*\))`,
    String.raw`(?<auto><[^>\s]+>)`,
    String.raw`(?<url>\bhttps?:\/\/[^\s<>\x60]+)`,
    String.raw`(?<code>(?<ticks>\x60+)(?<inner>[^\x60\n]+?)\k<ticks>(?!\x60))`,
    String.raw`(?<bare>(?<![\w/.~\\-])(?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]*)+)`,
  ].join('|'),
  'gu',
)
const LOCATION = /(?::\d+(?:[-:]\d+)?|#L\d+(?:-L?\d+)?)$/
const TRAILING = /[.,;:!?'")\]]+$/
const MAX_JOINS = 3

/** The places in a run of prose that may name a path, in order. */
export function findCandidates(prose: string): Candidate[] {
  const found: Candidate[] = []
  for (const m of prose.matchAll(SCAN)) {
    const g = m.groups ?? {}
    const start = m.index ?? 0
    if (g.url !== undefined) {
      const url = trimUrl(g.url)
      const end = start + url.length
      found.push({ start, end, url, paths: [], label: () => ({ label: url, end }) })
    } else if (g.code !== undefined) {
      const inner = (g.inner ?? '').trim()
      const end = start + m[0].length
      const target = openTarget(inner)
      if (target !== null) {
        found.push({ start, end, ...target, label: () => ({ label: m[0], end }) })
      }
    } else if (g.bare !== undefined) {
      found.push(bare(prose, start, g.bare))
    }
  }
  return found
}

/**
 * What a code span or a one-line code block points at when it is nothing but
 * a URL or a path: a command, or prose, is neither.
 */
export function openTarget(text: string): { url: string; paths: [] } | { paths: [string] } | null {
  const one = text.trim()
  if (one === '' || one.includes('\n')) return null
  if (/^https?:\/\/[^\s<>\x60]+$/.test(one)) return { url: one, paths: [] }
  const path = one.replace(LOCATION, '')
  const isAbsolute = /^(~\/|\.{1,2}\/|\/)/.test(path)
  const looksLikePath = isAbsolute ? !/\s(-|\||&|>|;)/.test(path) : !/\s/.test(path) && /\/|\.\w+$/.test(path)
  return looksLikePath && path !== '' && !path.includes('://') ? { paths: [path] } : null
}

/** A URL without the punctuation a sentence put after it; a closing parenthesis stays when the URL opened one. */
function trimUrl(url: string): string {
  let out = url
  for (;;) {
    const next = out.replace(/[.,;:!?'"]+$/, '')
    const isUnmatched = next.endsWith(')') && (next.match(/\(/g) ?? []).length < (next.match(/\)/g) ?? []).length
    const cut = isUnmatched ? next.slice(0, -1) : next
    if (cut === out) return out
    out = cut
  }
}

/** A web URL safe inside a markdown link's parentheses. */
export function webUrl(url: string): string {
  return url.replace(/[()]/g, c => (c === '(' ? '%28' : '%29'))
}

/**
 * A bare token with a slash. A path with a space in it (`Personal Projects`)
 * reads as several tokens, so the token joined with up to three words after it
 * is tried too, longest first: the longest that exists wins.
 */
function bare(prose: string, start: number, token: string): Candidate {
  const spans = [token]
  let rest = prose.slice(start + token.length)
  let joined = token
  for (let n = 0; n < MAX_JOINS; n++) {
    const next = /^ ([^\s`<>()[\]{}|]+)/.exec(rest)
    if (next === null) break
    joined += next[0]
    rest = rest.slice(next[0].length)
    spans.push(joined)
  }
  const shapes = spans.reverse().map(span => {
    const text = span.replace(TRAILING, '')
    return { text, path: text.replace(LOCATION, '') }
  })
  return {
    start,
    end: start + token.length,
    paths: shapes.map(s => s.path),
    label: path => {
      const shape = shapes.find(s => s.path === path) ?? { text: token }
      return { label: shape.text, end: start + shape.text.length }
    },
  }
}

/** Where a written path lands: `~/` under home, a relative one under the session's folder, `.` and `..` worked out. */
export function resolvePath(path: string, home: string, cwd: string): string {
  const full = path.startsWith('~/') ? `${home}/${path.slice(2)}` : path.startsWith('/') ? path : `${cwd}/${path}`
  const parts: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** A file URL for an absolute path, each segment percent-encoded (spaces, and parentheses that would end a markdown link). */
export function fileUrl(absolute: string): string {
  const encoded = absolute
    .split('/')
    .map(part => encodeURIComponent(part).replace(/[()']/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')
  return `file://${encoded}`
}

/** Looks a path up from each folder in turn (the session's, then its project root): the first that exists, as an absolute path. */
export async function findPath(
  path: string,
  exists: (absolute: string) => Promise<boolean>,
  home: string,
  bases: readonly string[],
): Promise<string | null> {
  for (const base of path.startsWith('/') || path.startsWith('~/') ? bases.slice(0, 1) : bases) {
    const absolute = resolvePath(path, home, base)
    if (await exists(absolute)) return absolute
  }
  return null
}

/** Where a candidate's link goes: its URL, or the first of its paths that exists; null when none does. */
export async function target(
  c: Pick<Candidate, 'url' | 'paths'>,
  exists: (absolute: string) => Promise<boolean>,
  home: string,
  bases: readonly string[],
): Promise<{ href: string; path: string } | null> {
  if (c.url !== undefined) return { href: webUrl(c.url), path: '' }
  for (const path of c.paths) {
    const absolute = await findPath(path, exists, home, bases)
    if (absolute !== null) return { href: fileUrl(absolute), path }
  }
  return null
}

/**
 * Rewrites each URL, and each path that exists, into a markdown link, keeping
 * what was written as the link's text. `exists` answers for absolute paths,
 * looked up from each of `bases`; overlapping candidates keep the first.
 */
export async function linkPaths(
  prose: string,
  exists: (absolute: string) => Promise<boolean>,
  home: string,
  bases: readonly string[],
): Promise<string> {
  const candidates = findCandidates(prose)
  const hits = await Promise.all(candidates.map(async c => ({ c, to: await target(c, exists, home, bases) })))
  let out = ''
  let at = 0
  for (const { c, to } of hits) {
    if (to === null || c.start < at) continue
    const { label, end } = c.label(to.path)
    out += `${prose.slice(at, c.start)}[${label}](${to.href})`
    at = end
  }
  return out + prose.slice(at)
}

/** A short id for a code block's text (cyrb53, base 36): the same text always gets the same id, so a redraw writes nothing new. */
export function copyId(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
