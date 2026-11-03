import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { copyId, fileUrl, findCandidates, linkPaths, openTarget, resolvePath, splitFences } from '../hooks/markdown'

const HOME = '/Users/me'
const ROOT = '/Users/me/Documents/Personal Projects/app'
const CWD = `${ROOT}/web`
const FILES = new Set([
  '/Users/me/Documents/Personal Projects/app',
  '/Users/me/Documents/Personal Projects/app/web',
  '/Users/me/Documents/Personal Projects/app/web/page.tsx',
  '/Users/me/Documents/Personal Projects/app/README.md',
  '/Users/me/Documents/Personal Projects/app/src/auth.ts',
  '/Users/me/Documents/Personal Projects/app/docs',
  '/Users/me/.claude/settings.json',
  '/tmp/report (final).txt',
])
const exists = async (path: string) => FILES.has(path)
const link = (prose: string) => linkPaths(prose, exists, HOME, [CWD, ROOT])

test('code blocks split out of prose, closed fences only', async () => {
  const pieces = splitFences('Run this:\n\n```bash\nnpm test\n```\n\nThen:\n~~~~\na\n~~~\nb\n~~~~\n```\nstill open\n')
  expect(pieces.map(p => p.kind)).toEqual(['text', 'code', 'text', 'code', 'text'])
  expect(pieces[1]).toEqual({ kind: 'code', text: '```bash\nnpm test\n```\n', body: 'npm test' })
  // A shorter fence of the same character does not close it.
  expect(pieces[3]?.kind === 'code' && pieces[3].body).toBe('a\n~~~\nb')
  expect(pieces[4]).toEqual({ kind: 'text', text: '```\nstill open\n' })
  expect(pieces.map(p => p.text).join('')).toBe('Run this:\n\n```bash\nnpm test\n```\n\nThen:\n~~~~\na\n~~~\nb\n~~~~\n```\nstill open\n')
})

test('a block inside a list item copies without the list indent', async () => {
  const [, code] = splitFences('1. Run:\n   ```\n   git status\n     indented\n   ```\n')
  expect(code?.kind === 'code' && code.body).toBe('git status\n  indented')
})

test('paths that exist become file links, the written text kept as the label', async () => {
  expect(await link('Open `src/auth.ts:42` now.')).toBe(
    `Open [\`src/auth.ts:42\`](file:///Users/me/Documents/Personal%20Projects/app/src/auth.ts) now.`,
  )
  expect(await link('See ~/.claude/settings.json.')).toBe('See [~/.claude/settings.json](file:///Users/me/.claude/settings.json).')
  expect(await link('the `docs/` folder')).toBe('the [`docs/`](file:///Users/me/Documents/Personal%20Projects/app/docs) folder')
  expect(await link('`README.md`')).toBe('[`README.md`](file:///Users/me/Documents/Personal%20Projects/app/README.md)')
})

test('a bare path with spaces is found by joining the words after it', async () => {
  expect(await link('Edit /Users/me/Documents/Personal Projects/app/README.md, then rebuild')).toBe(
    'Edit [/Users/me/Documents/Personal Projects/app/README.md](file:///Users/me/Documents/Personal%20Projects/app/README.md), then rebuild',
  )
  expect(await link('In `/Users/me/Documents/Personal Projects/app/src/auth.ts`')).toBe(
    'In [`/Users/me/Documents/Personal Projects/app/src/auth.ts`](file:///Users/me/Documents/Personal%20Projects/app/src/auth.ts)',
  )
  expect(await link('`/tmp/report (final).txt`')).toBe('[`/tmp/report (final).txt`](file:///tmp/report%20%28final%29.txt)')
})

test('links, URLs, commands, missing paths and words with slashes stay as written', async () => {
  for (const prose of [
    '[README](https://example.com/README.md)',
    '<https://example.com/a/b>',
    'run `cat src/auth.ts | head`',
    'run `/bin/ls -la /tmp`',
    'see `src/missing.ts`',
    'and/or either/or',
  ]) {
    expect(await link(prose)).toBe(prose)
  }
})

test('URLs become links to themselves, the sentence punctuation left outside', async () => {
  expect(await link('PR: https://github.com/me/app/pull/42.')).toBe(
    'PR: [https://github.com/me/app/pull/42](https://github.com/me/app/pull/42).',
  )
  expect(await link('(see https://en.wikipedia.org/wiki/Foo_(bar))')).toBe(
    '(see [https://en.wikipedia.org/wiki/Foo_(bar)](https://en.wikipedia.org/wiki/Foo_%28bar%29))',
  )
  expect(await link('`https://localhost:3000/a`')).toBe('[`https://localhost:3000/a`](https://localhost:3000/a)')
})

test('a relative path is looked up from the session folder, then the project root', async () => {
  expect(await link('`page.tsx`')).toBe('[`page.tsx`](file:///Users/me/Documents/Personal%20Projects/app/web/page.tsx)')
  expect(await link('`src/auth.ts`')).toBe('[`src/auth.ts`](file:///Users/me/Documents/Personal%20Projects/app/src/auth.ts)')
})

test('a code block opens only when it is nothing but a URL or a path', async () => {
  expect(openTarget('https://x.dev/a\n')).toEqual({ url: 'https://x.dev/a', paths: [] })
  expect(openTarget('/Users/me/Documents/Personal Projects/app/README.md:3')).toEqual({ paths: ['/Users/me/Documents/Personal Projects/app/README.md'] })
  expect(openTarget('open https://x.dev')).toBeNull()
  expect(openTarget('a\nb')).toBeNull()
  expect(openTarget('npm test')).toBeNull()
})

test('candidates, resolving and URLs', async () => {
  expect(findCandidates('a `x` b')).toEqual([])
  expect(resolvePath('../b/./c', HOME, '/a/x')).toBe('/a/b/c')
  expect(resolvePath('~/notes', HOME, CWD)).toBe('/Users/me/notes')
  expect(fileUrl("/Users/me/it's here/a.ts")).toBe('file:///Users/me/it%27s%20here/a.ts')
  expect(copyId('npm test')).toBe(copyId('npm test'))
  expect(copyId('npm test')).not.toBe(copyId('npm test '))
  expect(copyId('npm test')).toMatch(/^[0-9a-z]+$/)
})

/** Stands for the engine: HOME, the session's folder, the files, and its own drawing of each piece. */
function world(on: On) {
  const seen = { drawn: [] as string[], firsts: [] as boolean[], written: new Map<string, string>() }
  mock.env(on, { HOME })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.root', () => ({ value: ROOT }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', (_$, e) => ({ value: FILES.has(e.path) || seen.written.has(e.path) }))
  on('fs.write', (_$, e) => {
    seen.written.set(e.path, e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    const text = e.component === 'AssistantMessage' ? e.props.text : ''
    seen.drawn.push(text)
    if (e.component === 'AssistantMessage') seen.firsts.push(e.props.isFirstOfReply)
    return Text({ children: text })
  })
  return seen
}

const START = { cwd: CWD, surface: 'terminal', isInteractive: true } as const
const reply = (text: string) => ({ plugin: 'clickable', component: 'AssistantMessage', props: { text, isFirstOfReply: true } }) as const

test('each code block gets a copy link to its saved text, under the engine drawing it', async ($, on) => {
  const seen = world(on)
  await $.session.start(START)
  const text = 'Run:\n\n```bash\nnpm run dev -- --port 3000\n```\n\nThen open `README.md`:\n\n```\nhttp://localhost:3000\n```\n\nDone.'
  const ui = await $.ui.mount({ ...reply(text), surface: 'terminal' })

  const first = copyId('npm run dev -- --port 3000')
  const second = copyId('http://localhost:3000')
  expect(seen.written.get(`${HOME}/.claude/clickable/copy/${first}.txt`)).toBe('npm run dev -- --port 3000')
  expect(seen.written.get(`${HOME}/.claude/clickable/copy/${second}.txt`)).toBe('http://localhost:3000')
  expect((await ui.find({ type: 'Link', text: '[copy]' }))?.props.href).toBe(`kesselrunner-copy://${first}`)
  // The block that is only a URL opens too; the command does not.
  expect((await ui.find({ type: 'Link', text: '[open]' }))?.props.href).toBe('http://localhost:3000')

  // Three pieces drawn by the engine; only the first opens the reply.
  expect(seen.drawn.slice(-3)).toEqual([
    'Run:\n\n```bash\nnpm run dev -- --port 3000\n```',
    '\nThen open [`README.md`](file:///Users/me/Documents/Personal%20Projects/app/README.md):\n\n```\nhttp://localhost:3000\n```',
    '\nDone.',
  ])
  expect(seen.firsts.slice(-3)).toEqual([true, false, false])
  await ui.unmount()
})

test('prose alone is drawn once, its paths linked; elsewhere than the terminal nothing changes', async ($, on) => {
  const seen = world(on)
  await $.session.start(START)
  const ui = await $.ui.mount({ ...reply('Edit `src/auth.ts`.'), surface: 'terminal' })
  expect(seen.drawn.at(-1)).toBe('Edit [`src/auth.ts`](file:///Users/me/Documents/Personal%20Projects/app/src/auth.ts).')
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  await ui.unmount()

  const desktop = await $.ui.mount({ ...reply('Edit `src/auth.ts`.\n\n```\nls\n```'), surface: 'desktop' })
  expect(seen.drawn.at(-1)).toBe('Edit `src/auth.ts`.\n\n```\nls\n```')
  await desktop.unmount()
})
