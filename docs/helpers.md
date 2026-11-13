# Helpers: the contract

The session decides and does the high-level work; a helper does the legwork and hands back an answer. A helper is a named agent on Sonnet (its own `model:` line), sometimes with a skill in front of it. `/ios-sim` with ios-driver and `/frontend-test` with frontend-tester were the first; every new helper takes the same shape. The always-loaded rule points here (core `CLAUDE.md`, "Delegation").

## The helpers

| Helper | Skill | For |
|---|---|---|
| code-scout | - | A question that needs reading across many files: where X is handled, how Y reaches Z, every caller of W |
| web-researcher | - | A question outside the code that needs many searches: a vendor choice, a legal or marketing norm, what rivals do |
| prod-reader | `/prod-read` | Reading a live system during an incident: service status, recent logs, errors, read-only database queries |
| browser-operator | `/browser` | Work in a browser that is not testing your own app: vendor and account setup, a dashboard, a form |
| frontend-tester | `/frontend-test` | Testing your own web app in a browser |
| ios-driver | `/ios-sim` | Looking at or driving your own iOS app in the simulator |
| test-runner, test-updater, code-reviewer, docs-updater, deploy-watcher | - | The ship chain's workers |

## When to hand over

- **A skill scopes; an agent does.** Where the brief needs judgment (which account, what never to touch, what the manifest says), a skill writes it. Where the brief is just the question, the session calls the agent directly.
- One look-up stays inline: a single search, a single file, a single log line. A job of many steps, many reads or many pages goes to the helper.
- Reads you need for an edit stay inline. A scout finds; it does not stand in for reading the code you are about to change.

## The brief

The helper has seen none of the conversation. Give it:

1. **The goal** in the owner's terms: the question to answer or the job to finish.
2. **What is known**: what you already tried or ruled out, paths, names, links.
3. **The limits**: read-only or not, which accounts and repos, what it must never touch, when to stop.
4. **The proof wanted**: command output, `file:line` pointers, quoted source text with links, screenshots.

## The report

Every helper returns the same four parts, short (a few hundred words unless the brief asks for more):

1. **Answer**: the result, first.
2. **Proof**: the command output, `file:line` pointers, quoted text with links, screenshot paths it rests on.
3. **Not verified**: what it could not check, plainly.
4. **BLOCKED: <exact reason>** when it is stuck, in place of a result. Never a guess where a result should be.

## The caller checks

Helpers have reported success they did not reach. Before relying on a report, check its proof: open a named `file:line`, look at a screenshot, re-run one command. A report whose proof does not hold goes back once with what was wrong; the same failure twice, take the job yourself or step the helper up (`model: "opus"` on the same agent). A helper never decides by itself that a job is beyond it and guesses.

## Limits that hold inside every helper

- The owner's guards run in a helper's tool calls as in the session's (mail, DNS, production releases).
- A helper never types a secret it was not given for that job, and never prints a secret's value.
- Steps only the owner can take (a credential, a code sent to a phone, a purchase, accepting terms) come back as BLOCKED with what to do.

## Adding a helper

An agent in `agents/` with `model: sonnet`, a description that names its trigger, and a body that repeats the report shape above. Add a skill only when scoping needs judgment. Add one line to "Agents & Skills" in the core `CLAUDE.md` naming the helper and its trigger: a helper nothing names often goes unused. To run it on Codex, add `backend: codex` to its frontmatter ([delegation.md](delegation.md)).
