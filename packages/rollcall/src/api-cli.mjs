// `rollcall api <verb>`: the front-end interface on the command line (api.mjs). Every verb prints JSON; a refusal
// prints { ok: false, error: { code, message } } and exits 1 (2 for a usage error), so a front end reads one shape.
import { readFileSync } from "node:fs";
import { ACTIONS, COMING, runAction } from "./api-actions.mjs";
import { INTERFACE, USAGE, VERSION, attachInfo, snapshot } from "./api.mjs";
import { stream } from "./api-stream.mjs";
import { taskEnv } from "./supervisor.mjs";

const VERBS = ["version", "snapshot", "stream", "do", "attach"];

/** `ctx`: the CLI's { say, whoAmI }. Returns the exit code. */
export async function apiCommand(args, ctx) {
  const json = (o) => ctx.say(JSON.stringify(o, null, 2));
  try {
    return await run(args, ctx, json);
  } catch (e) {
    // A front end reads one shape, never a stack trace.
    json({ ok: false, error: { code: "failed", message: String(e?.message ?? e) } });
    return 1;
  }
}

async function run(args, ctx, json) {
  const [verb, ...rest] = args;
  const error = (code, message, exit = 1) => { json({ ok: false, error: { code, message } }); return exit; };
  const opt = (name) => { const i = rest.indexOf(name); if (i < 0) return undefined; const v = rest[i + 1]; rest.splice(i, 2); return v; };
  const has = (name) => { const i = rest.indexOf(name); if (i >= 0) rest.splice(i, 1); return i >= 0; };
  switch (verb) {
    case "version":
      json({ ok: true, interface: INTERFACE, rollcall: VERSION, verbs: VERBS, actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, a]) => [k, a.cli])), coming: COMING });
      return 0;
    case "snapshot":
      ctx.say(JSON.stringify(snapshot({ home: opt("--home") ?? null })));
      return 0;
    case "stream":
      await stream({ home: opt("--home") ?? null, client: opt("--client") ?? null, notifies: has("--notifies") });
      return 0;
    case "attach": {
      const client = opt("--client") ?? "frontend";
      const resume = has("--resume");
      // Bringing a worker back acts for the owner, as `do task.resume` does.
      if (resume && (taskEnv() || ctx.whoAmI())) return error("refused", "attach --resume acts as the owner; an agent session uses start.mjs --resume");
      const ref = rest[0];
      if (!ref) return error("bad-payload", "usage: rollcall api attach <home>[:<task>] [--client <name>] [--resume]", 2);
      const r = attachInfo(ref, { client, resume: resume ? (t) => resumeFor(t, client) : null });
      if (!r.ok) return error(r.code, r.message);
      json(r);
      return 0;
    }
    case "do": {
      // The actions act as the owner: an agent session (a supervisor, a worker, a subagent) uses the `rollcall task`
      // commands instead, which run the same code under its own name. The hooks deny it too.
      if (taskEnv() || ctx.whoAmI()) return error("refused", "rollcall api do acts as the owner, for the apps the owner uses; an agent session uses the rollcall task commands");
      const [name, body] = rest;
      if (!name) return error("bad-payload", `usage: rollcall api do <action> [<json> | -]; actions: ${Object.keys(ACTIONS).join(", ")}`, 2);
      let payload;
      try { payload = JSON.parse(body === undefined || body === "-" ? readFileSync(0, "utf8") || "{}" : body); } catch { return error("bad-payload", "the payload is not JSON", 2); }
      const r = await runAction(name, payload, { client: payload?.client ?? "frontend" });
      json(r);
      return r.ok ? 0 : 1;
    }
    case undefined: case "help": case "--help": case "-h":
      ctx.say(`usage:\n${USAGE}`);
      return 0;
    default:
      return error("bad-payload", `unknown verb "${verb}": ${VERBS.join(", ")}`, 2);
  }
}

/** Attach with --resume: the worker comes back first, as task.resume does. */
function resumeFor(t, client) {
  const r = runAction("task.resume", { task: `${t.home}:${t.id}`, why: `the owner opened its terminal from ${client}` }, { client });
  return r.ok ? { ok: true } : { ok: false, message: r.error.message };
}
