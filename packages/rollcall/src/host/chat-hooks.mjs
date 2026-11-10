// What Claude Code's hooks do for a chat's session (hooks.mjs, for a session that holds its home), done for a Codex
// chat by the host: Codex runs no rollcall hooks, so codex/session.mjs calls this where it would call a worker's.
//   session-start -> the chat is ready, its watcher runs
//   prompt-submit -> a turn starts: the task news the watcher holds, and what the owner told its tasks' workers
//                    directly, go in with it
//   stop          -> the turn ended: the news it carried is handled
//   stop-failure  -> the turn failed: that news goes back in the queue
import * as store from "../store.mjs";
import { ensureWatcher } from "../supervisor.mjs";
import { ownerNews } from "../task.mjs";
import { turnEnded, turnFailed, turnReady, turnStarted } from "../watch.mjs";

/** Chat `h`'s hook for `event` of its session (`p.session_id`): what the hook would print (JSON), or null. */
export function chatHook(h, event, p = {}) {
  const session = p.session_id;
  if (!session) return null;
  const g = store.readGlobal(session) ?? { id: session };
  const now = Date.now();
  switch (event) {
    case "session-start":
      turnReady(h, g, now);
      ensureWatcher(h);
      return null;
    case "prompt-submit": {
      const lines = [...turnStarted(h, g, now), ...ownerNews(h, now)];
      return lines.length ? JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: lines.join("\n") } }) : null;
    }
    case "stop":
      turnEnded(h, g, now);
      return null;
    case "stop-failure":
      turnFailed(h, g, now);
      return null;
    default:
      return null;
  }
}
