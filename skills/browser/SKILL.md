---
name: browser
description: "Hand work in a web browser to the browser-operator agent (Sonnet): vendor and account setup, reading or configuring a dashboard, filling a form, anything that would otherwise be a long run of browser clicks in this session. This skill decides whether the job is worth handing over and writes the brief; the agent drives the user's signed-in Chrome or a clean browser, stops at steps only the user can take, and returns a report with screenshots. Trigger when: a task needs a vendor dashboard or account page ('set up X in the dashboard', 'create an API key on Y', 'configure the webhook', 'what does this form need'), the user pastes a form and asks what to fill in, or '/browser'. NOT for testing the user's own app (/frontend-test) and NOT for reading one public page (fetch it inline)."
---

# /browser

The session decides; the browser-operator does the clicking. A setup job that took a 30-call stretch of browser actions in the main loop becomes one helper call, and this session's context grows by the report only. The contract all helpers follow: `~/.claude/kesselrunner/docs/helpers.md`.

## 1. Inline or hand over

- **Inline**: one public page to read (fetch it), one value to look up.
- **Hand over**: anything with several steps, a sign-in, or a form. Testing the user's own app goes to `/frontend-test` instead.

## 2. Gather what the brief needs

Answer these from the conversation, the repo and the docs before you write it. Ask the user only what none of those can answer.

- **The goal** in the user's terms, and what done looks like ("a webhook to https://api.example.com/hooks/x, events A and B, signing secret saved to `.env.local` as `X_WEBHOOK_SECRET`").
- **Where**: the site, the account or team, the project inside it.
- **Which browser**: the user's signed-in Chrome when the job needs their account; a clean browser otherwise.
- **Values to enter**, exactly. Secrets never go in the brief: name where the agent puts a secret the job creates (a gitignored env file, a password manager entry) or where it takes one the user gave for this job.
- **Limits**: what never to touch (other projects, billing, existing records), and the pages the user's rules put off limits.
- **Owner steps you expect** (a 2FA code, a payment, accepting terms), so the agent stops there.
- **Proof wanted**: which end states to screenshot, and where to save them (a task's files folder when the user will look later, else a scratch folder).

## 3. Spawn it

The Agent tool with `subagent_type: "browser-operator"` (its file sets Sonnet), the brief as the prompt. Run it in the background when other work can go on meanwhile.

## 4. Check the proof

Read the report. Prefer a check that is not an image: list the record with the vendor's CLI or API, call the webhook, read the env file's key names. Open a screenshot only when nothing else shows the result; an image you read stays in this session's context. A report whose proof does not hold goes back once with what was wrong; the same failure twice, take the job yourself or step the agent up (`model: "opus"`).

## 5. Hand the user their steps

`Owner steps left` from the report goes to the user as one short list, each with its link and what to click. Then carry on with the rest of the task.
