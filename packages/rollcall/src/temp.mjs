// Claude Code keeps each session's temp folder at /tmp/claude-<uid>/<project>/<session-id>: its scratchpad,
// its background tasks' output. A Bash command that can delete the folder of another session that is still
// alive is denied; a session's own folder and those of ended sessions delete freely. Only commands that name
// the temp root and a deleting word get here (bin/rollcall.mjs), so every other Bash call pays one substring test.
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { deletions } from "./shell.mjs";
import { P, family, isAlive, short } from "./session.mjs";
import * as store from "./store.mjs";

export const MENTION = "/tmp/claude-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHOWN = 40; // the agent must see every folder to leave out; one machine runs far fewer sessions

/** The temp root, and the spellings a command may use for it (/tmp is /private/tmp on macOS). */
function spellings() {
  const plain = process.env.ROLLCALL_CLAUDE_TMP || `/tmp/claude-${process.getuid?.() ?? 0}`;
  let root = plain;
  try { root = realpathSync(plain); } catch {}
  return { root, names: [...new Set([root, plain])] };
}

/** The part of `path` below the temp root as [project, session, ...]; [] for the root or anything above it; null outside. */
function below(path, { names }) {
  if (path === null) return [];
  for (const n of names) {
    if (path === n || n.startsWith(path === "/" ? "/" : `${path}/`)) return [];
    if (path.startsWith(`${n}/`)) return path.slice(n.length + 1).split("/");
  }
  return null;
}

const ls = (dir) => { try { return readdirSync(dir); } catch { return []; } };

/** The deny reason when `cmd`, run from `cwd`, can delete a temp folder of a live session other than this one; else null. */
export function tempDenial(cmd, cwd, session) {
  const sp = spellings();
  const reached = new Map(); // folder -> session id
  for (const target of deletions(cmd, cwd)) {
    const rel = below(target, sp);
    if (!rel) continue;
    const projects = rel.length ? [rel[0]] : ls(sp.root);
    for (const project of projects) {
      for (const id of rel.length >= 2 ? [rel[1]] : ls(join(sp.root, project))) {
        if (UUID.test(id)) reached.set(join(sp.root, project, id), id);
      }
    }
  }
  if (!reached.size) return null;
  const me = session();
  const live = [...reached].filter(([, id]) => {
    if (id === me.id) return false;
    const g = store.readGlobal(id);
    return isAlive(g) && !family(g, me);
  });
  if (!live.length) return null;
  const more = live.length > SHOWN ? [`  ...and ${live.length - SHOWN} more`] : [];
  return [
    `${P} Delete blocked: it can reach the temp folders of sessions that are still running (their scratchpads and background task output):`,
    ...live.slice(0, SHOWN).map(([folder, id]) => `  ${short(id)}  ${folder}`),
    ...more,
    `${P} Leave those out and name each folder you delete in full: a folder whose session has ended, or your own, deletes freely. A target rollcall cannot read (a variable it cannot resolve, xargs, a glob above a session's folder) counts as all of ${sp.root}.`,
  ].join("\n");
}
