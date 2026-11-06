// The owner's answer to a worker's question, whichever front end it came from: a pick in the terminal Falcon's
// picker (hooks.mjs picks()) or an answer through the front-end interface (api.mjs, question.answer). Both build
// the same line for the worker and record it the same way, so a worker cannot tell which surface answered. The
// first answer wins: the task records who answered which question, a later answer to that question from any
// surface is refused, and an open picker in the Falcon whose questions were all answered elsewhere is closed.
import { pending, tail } from "./asked.mjs";
import { P } from "./session.mjs";
import * as store from "./store.mjs";
import { deliverWords, holderOf, label, nameOf, taskOfQuestion } from "./supervisor.mjs";
import * as tmux from "./tmux.mjs";
import { ownerSaid } from "./task.mjs";

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
 * The id of the question task `t` has open, or null: its picker question's time, else (a question without options)
 * the time it turned needs-you. A front end answers by this id, so an answer meant for an older question never
 * lands on a newer one.
 */
export function questionId(t) {
  if (t?.state !== "needs-you") return null;
  const at = t.ask?.at ?? t.stateAt ?? t.updatedAt ?? 0;
  return `${t.home}:${t.id}:${at}`;
}

/** The questions a question id stands for, as the worker asked them: its picker questions, or the one free question. */
export function openQuestions(t) {
  if (t.ask?.questions?.length) return t.ask.questions;
  return t.question ? [{ question: t.question, header: "", multiSelect: false, options: [] }] : [];
}

/**
 * Whether the question `text` of task `t` was answered already on another surface: the task records it, and its
 * open question (when it has one) no longer holds it. Returns that record ({ by, at, answer }), or null.
 */
export function answeredElsewhere(t, text) {
  const a = t?.answered;
  if (!a || !a.questions?.includes(text)) return null;
  if (openQuestions(t).some((x) => x.question === text) && t.state === "needs-you") return null;
  return a;
}

/** Notes, on `t` (under its lock), that the owner answered `questions` from `by`, with `answer` as the worker reads it. */
export function markAnswered(t, questions, by, answer, { qid = null, now = Date.now() } = {}) {
  t.answered = { at: now, by, qid, questions: questions.map((x) => x.question), answer: store.clip(store.oneLine(answer), 300) };
}

/**
 * The owner answered task `ref`'s open question from front end `client`. `qid` is the id the front end saw
 * (questionId); `answers` maps each question's text to the answer (a label, several joined with ", " for a
 * multi-select, or the owner's own words), and `answer` alone answers a single question. Settled under the task's
 * lock, so of two surfaces answering at once one wins and the other hears `already-answered`. The answer reaches
 * the worker exactly as a pick in the Falcon's picker does. Returns { ok, code?, message?, how?, answered? }.
 */
export function answerFromFrontEnd(h, id, { qid, answers = null, answer = null, client }) {
  let refused = null;
  let text = null;
  let questions = null;
  const r = store.withTasksLock(h, () => {
    const t = store.readTask(h, id);
    if (!t) { refused = { code: "not-found", message: `no task ${id} in supervisor ${h}` }; return null; }
    const open = questionId(t);
    if (!open) {
      refused = t.answered?.qid === qid
        ? { code: "already-answered", message: `${label(t)}: its question was answered already, from ${t.answered.by}`, answered: t.answered }
        : { code: "no-question", message: `${label(t)} has no open question` };
      return null;
    }
    if (qid !== open) { refused = { code: "stale-question", message: `${label(t)} asks something newer now: answer question ${open}`, current: open }; return null; }
    questions = openQuestions(t);
    const by = (x) => (answers && typeof answers[x.question] === "string" ? answers[x.question] : questions.length === 1 && typeof answer === "string" ? answer : "").trim();
    const missing = questions.filter((x) => !by(x));
    if (missing.length) { refused = { code: "bad-payload", message: `no answer for: ${missing.map((x) => store.clip(x.question, 80)).join(" / ")}` }; return null; }
    text = joinLines(questions.map((x) => pickLine(x, by(x), nameOf(t.id))));
    const typed = questions.some((x) => ownWords(x, by(x)))
      ? `${text}\nIf this asks you something, answer with \`rollcall task note ${t.id} "reply: <answer>"\`: what you write in this window reaches no one.`
      : text;
    ownerSaid(t, text, "app");
    t.words.at(-1).client = client;
    markAnswered(t, questions, client, text, { qid });
    store.writeTask(t);
    return { t, typed };
  });
  if (refused) return { ok: false, ...refused };
  if (!r) return { ok: false, code: "busy", message: "the task store is busy; try again" };
  const { t, typed } = r.out;
  const d = deliverWords(t, typed, { record: () => {}, mode: holderOf(h)?.mode ?? null });
  const closed = closeFalconPicker(h, client);
  return { ok: true, how: d.ok ? d.how : "held", why: d.why ?? null, pickerClosed: closed };
}

/**
 * The Falcon has a picker open whose every question a front end answered meanwhile: rollcall closes it (Esc in the
 * supervisor's window), and the supervisor hears why, so it does not ask again. A picker that still holds a
 * question nobody answered stays: the owner answers the rest there, and picks() drops what was answered. Returns
 * whether it closed one.
 */
export function closeFalconPicker(h, by) {
  const g = holderOf(h);
  if (!g?.transcript || !tmux.windowOf(h, h)?.alive) return false;
  const call = pending(tail(g.transcript)).sort((a, b) => b.at - a.at)[0];
  const qs = call?.name === "AskUserQuestion" && Array.isArray(call.input?.questions) ? call.input.questions : null;
  if (!qs?.length) return false;
  const tasks = new Set();
  for (const x of qs) {
    const id = taskOfQuestion(x);
    const t = id && store.readTask(h, id);
    if (!t || !answeredElsewhere(t, x.question)) return false;
    tasks.add(t.id);
  }
  if (!tmux.interrupt(h, h)) return false;
  for (const id of tasks) store.enqueueWake(h, { task: id, kind: "answered-elsewhere", by });
  return true;
}

/** What the supervisor hears for a pick on a question already answered on another surface. */
export const droppedPick = (t, a) =>
  `${P} ${label(t)}: its question was answered already from ${a.by} ("${store.clip(a.answer, 160)}"), so this pick did not go to ${nameOf(t.id)}'s worker. Nothing to do for it.`;
