# Security notes

The proxy is the only place a key exists. The browser only ever calls
`/api/character` or `/api/intent`.

- [Threat model](#threat-model)
- [The key never reaches the page](#the-key-never-reaches-the-page)
- [Origin guard](#origin-guard)
- [A CORS rejection destroys the error message you wrote](#a-cors-rejection-destroys-the-error-message-you-wrote)
- [Rate limiting](#rate-limiting)
- [Redaction](#redaction)
- [Untrusted model output](#untrusted-model-output)
- [Environment hygiene](#environment-hygency)
- [Publishing checklist](#publishing-checklist)

---

## Threat model

Two classes of untrusted input reach this project, and both are handled the same
way — parsed defensively, bounded, and sanitised before use:

1. **Model output.** A hosted model can return anything, including prompt
   injection from its own training data, malformed JSON, or absurd numbers.
2. **The page's world report.** The page tells the server what targets exist and
   how far the goal is. That is a client, so it is not trusted either — see
   [architecture.md](architecture.md#request-flow).

Nothing here is a security-critical deployment. It is a local demo that was
published to a **public** GitHub repository, which is the bar that matters.

---

## The key never reaches the page

`api.js` is the only browser module that performs network I/O, and it can only
reach two endpoints. `LLM_API_KEY` lives in `.env`, is read by `server/` at
startup, and is never echoed in any response.

`/api/health` reports `{ provider, hasKey }` — readiness, never the key.

---

## Origin guard

A missing `Origin` is allowed (curl, tests); a *foreign* one is refused. That is
what stops a malicious page from POSTing to `localhost` and spending the key.

`ALLOWED_ORIGIN` takes a comma-separated list, because `localhost`,
`127.0.0.1` and the WSL address are all the same machine but the browser sends
whichever you typed.

**It was a single value, which made it a footgun.** Opening the page at
`127.0.0.1:8080` got every request 403'd, and the HUD said `provider offline` /
`brain error` with no reason — indistinguishable from a dead proxy. A rejection
now names the offending origin and the variable to set, and
`access-control-allow-origin` echoes the request's own origin so a multi-origin
list actually works.

---

## A CORS rejection destroys the error message you wrote

The proxy's 403 carries a full explanation and the browser never shows it,
because the *preflight* failed; `fetch` rejects with a bare `Failed to fetch`.

So the client has to supply the explanation, and it has to fit in the space the
HUD gives it — a message that explains itself after the truncation is no use.
This is why `brain.state.lastError` is rendered, and why the `control` line
answers the question directly: **a character that keeps moving looks identical
whether the model is driving it or not.**

---

## Rate limiting

Sliding window, 30 requests/minute/client — and that was not enough on its own.

The intent endpoint is polled every 2s, which is 30/min: **the entire shared
budget**, leaving nothing for the character request each new maze needs. The two
now have separate budgets (intents 120/min, characters 12/min) because they are
different kinds of traffic: one is the control loop, the other spends the key.

---

## Redaction

- **Provider errors are not echoed.** Only `ProviderError` messages are
  disclosed; any other thrown value becomes a generic `provider error`. A
  redaction pass strips key-shaped strings as a second line of defence. *A test
  proved this was a real leak, not a hypothetical one.*
- **The thoughts panel redacts, and so does the intent it displays.** Writing
  the panel surfaced a pre-existing gap: `sanitizeIntent` accepts any non-empty
  string up to 40 characters as a target, so a key-shaped value in a model's
  answer reached the page verbatim in `intent.target`.

  Not exploitable — the model never sees the key, which exists only in the proxy
  process — but the redaction pass is exactly this second line of defence, and
  `model_said` / `model_reasoning` made model-authored text a first-class output.
  Both are redacted now, and **redacting rather than rejecting is free**: the
  brain already degrades an unresolvable target to a wander.

---

## Untrusted model output

Every model response is sanitised **three times** — proxy, client, brain. The
bounds are in [architecture.md](architecture.md#bounds-that-keep-a-bad-model-from-breaking-the-simulation).

Model output reaches the page as **`textContent`, never as markup**. Every other
response is sanitised before it reaches the simulation; a panel that rendered it
as HTML would put the hole back in the one place nobody was looking.

---

## Environment hygiene

- `.env` is gitignored.
- `.env.*` backups are gitignored separately — a migration backup is still a
  secret.
- `.venv/` is gitignored.
- Six key-shaped strings **are** in the tree, and they are deliberate
  redaction-test fixtures: `sk-or-test-DUMMY-…`, `nvapi-AAAABBBBCCCCDDDDEEEE`,
  `nvapi-abcdefgh12345678`. They are inert and tested against.

---

## Publishing checklist

Before pushing to a **public** repository:

1. `git log --all -p | Select-String -Pattern 'nvapi-|sk-or-v1-|sk-[A-Za-z0-9]{20,}'`
   over every blob, not just the working tree — a secret in a deleted branch is
   still published.
2. Confirm `.env` is ignored: `git check-ignore -v .env`.
3. Confirm the fixtures above are the *only* key-shaped matches.

This was done for all 14 original commits and re-done before every push since.