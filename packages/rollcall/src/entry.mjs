// rollcall's answer to one `rollcall hook <event>` call, without the process around it (stdin, the time
// budget, exit codes): bin/rollcall.mjs runs it alone, and kesselrunner's per-event hook entry
// (scripts/hooks/) runs it beside the guards in one process.

/** The hook's stdout for `event` ("pre-tool-use", "post-tool-use", ...) and its parsed payload, or null. */
export async function hookAnswer(event, payload) {
  // Most Bash calls change no checkout and delete nothing in a Claude temp folder (temp.mjs): answer
  // those after loading at most the command-line reader.
  const bash = payload?.tool_name === "Bash" && event === "pre-tool-use" ? String(payload.tool_input?.command ?? "") : null;
  const temp = bash !== null && bash.includes("/tmp/claude-") && /\b(rm|rmdir|unlink|trash|srm|rmtree|rmSync|rimraf)\b|-delete\b/.test(bash);
  const said = bash !== null && /\bsaid\.json\b|\btask\s+relay\b/.test(bash);
  const skip = bash !== null && !temp && !said && (!/\bgit\b/.test(bash) || !(await import("./shell.mjs")).gitMutations(bash, process.cwd()).length);
  return skip ? null : (await import("./hooks.mjs")).runHook(event, payload);
}

/** Whether ROLLCALL_DISABLE turns rollcall's hooks off (any value but 0, false, no, off). */
export const disabled = (env = process.env) => !!env.ROLLCALL_DISABLE && !/^(0|false|no|off)$/i.test(env.ROLLCALL_DISABLE);
