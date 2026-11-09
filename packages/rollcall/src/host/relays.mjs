// A hosted supervisor's question that relays a task's: when every question it asks names one task that asks now,
// the supervisor's request carries `relays: { ref, question }`, and answering either answers both (host/server.mjs).
import * as store from "../store.mjs";


/**
 * The task question the supervisor's own question relays, when every question it asks names a task (its header
 * starts with the task's name, as the supervisor tags a worker's question) and that task asks something now:
 * { ref, question } (the task's ref and its question id), else null. A front end shows the task's card for it.
 */
export function relaysOf(h, input, { find } = {}) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  if (!qs.length) return null;
  try {
    const lookup = find ?? defaultFind;
    const hits = qs.map((x) => lookup(h, x));
    if (hits.some((x) => !x) || new Set(hits.map((x) => x.ref)).size !== 1) return null;
    return hits[0];
  } catch { return null; }
}

let finder = null;
const defaultFind = (h, q) => (finder ? finder(h, q) : null);
/** Wires the lookup relaysOf uses (supervisor.mjs and answer.mjs load late: they import half of rollcall). */
export async function loadFinder() {
  const [{ taskOfQuestion }, { questionId }] = await Promise.all([import("../supervisor.mjs"), import("../answer.mjs")]);
  finder = (h, q) => {
    const tid = taskOfQuestion(q);
    const t = tid && store.readTask(h, tid);
    const qid = t && questionId(t);
    return qid ? { ref: `${h}:${t.id}`, question: qid } : null;
  };
}
