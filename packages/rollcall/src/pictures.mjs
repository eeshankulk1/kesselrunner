// A picture the owner attaches to a pick in the supervisor's picker. Claude Code gives the hook only the words
// "(Image attached)"; the picture itself sits in the supervisor's transcript, as image blocks beside the tool's
// result, in an entry written around the time the hook runs. The pick goes to the worker from the hook as any pick
// does. A short process apart from it then waits for that entry, saves each picture where the task keeps what the
// owner opens, and sends the worker the saved paths, which it can read. Workers once searched Downloads for these.
// That process carries no words, so nothing that starts it can type anything as the owner's: a line of rollcall's,
// with paths it made itself, is all it sends.
import { closeSync, fstatSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enqueue } from "./delivery.mjs";
import { spawnDetached } from "./proc.mjs";
import { P, BIN } from "./session.mjs";
import * as store from "./store.mjs";
import { pump, taskEnv } from "./supervisor.mjs";

export const PICTURE = "(Image attached)";
// How far back from the end of the transcript its entry can start, pictures and all.
const TAIL = 64 * 1024 * 1024;
const waitMs = () => Number(process.env.ROLLCALL_PICTURE_WAIT_MS) || 20_000;
const EVERY_MS = 250;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
// The id names the saved pictures, so only a plain one will do.
const PLAIN_ID = /^[\w-]{1,100}$/;

/** Whether the pictures of hook payload `p` can be found. */
export const picturesFindable = (p) => !!p.transcript_path && PLAIN_ID.test(p.tool_use_id ?? "");

/** Starts the process that sends task `id` the pictures of tool call `p`. */
export function picturesLater(h, id, p) {
  spawnDetached(process.execPath, [BIN, "_pick-pictures", h, id, p.transcript_path, p.tool_use_id]);
}

/** The transcript's last stretch. */
function tail(file) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const n = Math.min(size, TAIL);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf;
  } finally { closeSync(fd); }
}

/** The image blocks beside tool call `use`'s result, or null until that entry is written. */
function imagesOf(file, use) {
  const buf = tail(file);
  if (!buf.includes(use)) return null;
  for (const line of buf.toString("utf8").split("\n").reverse()) {
    if (!line.includes(use)) continue;
    let e = null;
    try { e = JSON.parse(line); } catch { continue; }
    const blocks = e?.message?.content;
    if (e?.type !== "user" || !Array.isArray(blocks) || !blocks.some((b) => b.type === "tool_result" && b.tool_use_id === use)) continue;
    return blocks.filter((b) => b.type === "image" && b.source?.data);
  }
  return null;
}

/** Saves `images` beside the task's other files: their paths. */
function save(h, id, use, images) {
  const dir = store.filesDir(h, id);
  mkdirSync(dir, { recursive: true });
  return images.map((b, i) => {
    const path = join(dir, `picture-${use.slice(-8)}-${i + 1}.${EXT[b.source.media_type] ?? "png"}`);
    writeFileSync(path, Buffer.from(b.source.data, "base64"));
    return path;
  });
}

/** `rollcall _pick-pictures <home> <task> <transcript> <tool use id>`: the wait itself. rollcall's hook starts it; a worker never does. */
export async function pickPictures([h, id, transcript, use]) {
  if (taskEnv() || !store.HOME_NAME.test(h ?? "") || !/^t\d+$/.test(id ?? "") || !PLAIN_ID.test(use ?? "")) return 1;
  const t = store.readTask(h, id);
  if (!t) return 1;
  const until = Date.now() + waitMs();
  let images = null;
  let looked = -1;
  while (!images && Date.now() < until) {
    // The transcript is read again only when it grew: a large one is not worth reading four times a second.
    try {
      const size = statSync(transcript).size;
      if (size !== looked) { looked = size; images = imagesOf(transcript, use); }
    } catch {}
    if (!images) await new Promise((r) => setTimeout(r, EVERY_MS));
  }
  let paths = [];
  try { if (images?.length) paths = save(h, id, use, images); } catch {}
  enqueue(t, "notice", paths.length
    ? `${P} The owner's picture${paths.length === 1 ? "" : "s"} from their last answer: ${paths.join(", ")}`
    : `${P} rollcall could not save the picture from the owner's last answer: ask them for it, and do not search for it.`);
  pump(t);
  return 0;
}
