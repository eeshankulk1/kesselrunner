// clickable: code blocks you can copy and paths you can open, in the classic
// terminal view.
//
// In the classic view Claude Code wraps long lines itself, so a mouse copy of
// a long command brings the line breaks along, and it never hears a click: the
// terminal takes those, and opens links. So both fixes are links.
//
// - Under each fenced code block in a reply, a `[copy]` link to
//   kesselrunner-copy://<id>. The block's text is saved as <store>/<id>.txt, and
//   the kesselrunner Copy app (scripts/copy-helper, built by `kesselrunner sync`)
//   opens that scheme and puts the file on the clipboard. A block that holds
//   only a URL, or a path that exists, gets an `[open]` link beside it.
// - Each URL in a reply's prose becomes an explicit link, so one the terminal
//   wraps still opens whole. Each path that exists becomes a file:// link,
//   spaces encoded, a relative one looked up from the session's folder and
//   then its project root, so a click opens it whatever the terminal makes of
//   the text.
//
// It changes only the drawing: the stored reply, and what the model reads,
// stay as written. Each piece is still drawn by Claude Code itself.

import type { EngineInterface, Register } from 'claude-code'

import { copyId, linkPaths, openTarget, splitFences, target } from './markdown'

const STORE = '.claude/clickable/copy'
// A saved block outlives its link by this long; older ones are deleted at session start.
const KEEP_DAYS = 30
// How long a path found missing stays missing before it is looked up again.
const MISS_MS = 3_000

// Module caches: a reload starts them over, which costs a few lookups.
const present = new Set<string>()
const missing = new Map<string, number>()
const saved = new Set<string>()
let home = ''

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    home = (await $.env.get('HOME')) ?? ''
    if (home !== '') {
      $.process.run(['find', `${home}/${STORE}`, '-name', '*.txt', '-mtime', `+${KEEP_DAYS}`, '-delete']).catch(() => undefined)
    }
    return result
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.isSummary === true || home === '') {
      return next(e)
    }
    // Linking is decoration: if it fails, the reply draws as written.
    let text = ''
    const groups: { text: string; copy?: string; open?: string }[] = []
    try {
      const [cwd, root] = await Promise.all([$.session.cwd(), $.session.root()])
      const bases = cwd === root ? [cwd] : [cwd, root]
      const isThere = (path: string) => exists($, path)
      const pieces = splitFences(e.props.text)
      const texts = await Promise.all(pieces.map(p => (p.kind === 'text' ? linkPaths(p.text, isThere, home, bases) : p.text)))

      // One group per code block: the prose before it and the block, then its links.
      for (const [i, piece] of pieces.entries()) {
        text += texts[i]
        if (piece.kind === 'code' && piece.body.trim() !== '') {
          const opens = openTarget(piece.body)
          const to = opens === null ? null : await target(opens, isThere, home, bases)
          groups.push({ text, copy: piece.body, open: to?.href })
          text = ''
        }
      }
    } catch {
      return next(e)
    }
    if (groups.length === 0) {
      return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
    }
    if (text.trim() !== '') groups.push({ text })

    const { Box, Link, Text } = $.ui.resolve(e)
    const rows = []
    for (const [i, group] of groups.entries()) {
      const drawn = await next({
        ...e,
        props: { ...e.props, text: group.text.replace(/\n+$/, ''), isFirstOfReply: e.props.isFirstOfReply && i === 0 },
      })
      const id = group.copy === undefined ? null : await save($, group.copy)
      rows.push(
        <Box key={`group-${i}`} flexDirection="column">
          {drawn}
          {id === null && group.open === undefined ? null : (
            <Box paddingLeft={2}>
              <Text dimColor>
                {id === null ? null : <Link href={`kesselrunner-copy://${id}`} label="[copy]" />}
                {id !== null && group.open !== undefined ? '  ' : null}
                {group.open === undefined ? null : <Link href={group.open} label="[open]" />}
              </Text>
            </Box>
          )}
        </Box>,
      )
    }
    return <Box flexDirection="column">{rows}</Box>
  })
}

/** Whether an absolute path exists: a hit is kept, a miss for a moment (the reply may name a file it is about to write). */
async function exists($: EngineInterface, path: string): Promise<boolean> {
  if (present.has(path)) return true
  const at = missing.get(path)
  const now = Date.now()
  if (at !== undefined && now - at < MISS_MS) return false
  const isThere = await $.fs.exists(path).catch(() => false)
  if (isThere) present.add(path)
  else missing.set(path, now)
  return isThere
}

/** Saves a block's text under its id once, and answers the id; null when it could not be saved, so no link is drawn. */
async function save($: EngineInterface, body: string): Promise<string | null> {
  const id = copyId(body)
  if (saved.has(id)) return id
  try {
    const path = `${home}/${STORE}/${id}.txt`
    if (!(await $.fs.exists(path))) await $.fs.write(path, body)
    saved.add(id)
    return id
  } catch {
    return null
  }
}
