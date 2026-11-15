// The owner's answer to a worker's question: a pick in the terminal Falcon's picker (hooks.mjs picks()), as the
// line the worker reads, or words they typed in the worker's own window. The first answer wins: once the owner
// answered in the worker's window, the supervisor's picker for that question closes (watch.mjs) and a late pick
// from it is dropped (picks()), so the owner answers each question once.
import * as store from "./store.mjs";

/**
 * A pick as its worker reads it: its question's header, then the answer. Words of the owner's own under
 * "Other" say so: a bare "2" once read as option 2 ($1.50) when the owner meant 2 dollars.
 */
export function pickLine(x, answer, name) {
  const tagged = String(x.header ?? "").trim();
  const header = (tagged.startsWith(name) ? tagged.slice(name.length).trim() : tagged) || store.clip(store.oneLine(x.question), 60);
  const said = ownWords(x, answer);
  return { own: !!said, said, line: said ? `${header} (the owner's own words, not one of your options): ${answer}` : `${header}: ${answer}` };
}

/**
 * What the owner wrote in an answer, "" when it is only the options the worker offered. Those are the worker's
 * words, and only the owner's may go on the record `task relay` reads. A multi-select joins its picks with ", ",
 * which a label can hold too, so the longest labels come out first.
 */
export function ownWords(x, answer) {
  const labels = (x.options ?? []).map((o) => o.label);
  if (!x.multiSelect) return labels.includes(answer) ? "" : answer;
  let rest = `, ${answer}, `;
  for (const label of [...labels].sort((a, b) => b.length - a.length)) rest = rest.replace(`, ${label}, `, ", ");
  return rest.replace(/^, |, $/g, "");
}

/** Several answers for one task go as one prompt, numbered in their order. */
export const joinLines = (picked) => (picked.length === 1 ? picked[0].line : picked.map((a, i) => `${i + 1}. ${a.line}`).join("\n"));

/**
 * The owner's words typed in task `t`'s own window that closed its question at or after `since` (when a picker
 * asking it opened in the supervisor), unless the task has asked again since: that word ({ at, text, closed }), or
 * null. The first answer wins: a picker still asking such a question is stale, and a pick from it goes nowhere.
 */
export function answeredInWindow(t, since) {
  const w = t?.words?.findLast((x) => x.via === "worker" && x.closed && x.at >= since);
  if (!w) return null;
  const askedAgain = t.state === "needs-you" && (t.ask?.at ?? t.stateAt ?? 0) > w.at;
  return askedAgain ? null : w;
}
