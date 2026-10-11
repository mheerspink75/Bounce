# Deployment

Three viable targets, and what each one can and cannot do. The deciding question
is not "where do we put the files" — it is **"does the demo need a real model
behind it?"**

- [The constraint](#the-constraint)
- [GitHub Pages — recommended](#github-pages--recommended)
- [Vercel](#vercel)
- [Netlify](#netlify)
- [Why the proxy cannot be hosted for free](#why-the-proxy-cannot-be-hosted-for-free)
- [Decision summary](#decision-summary)

---

## The constraint

Two processes normally:

| | Port | What it is |
| --- | --- | --- |
| `npm run serve` | :8080 | static files from `public/` |
| `npm start` | :8787 | the LLM proxy — **holds the API key** |

**The proxy is not optional for a real model.** It is the only place a key
exists, and the browser never sees one. So any real-model deployment needs a
long-running Node process and a key, which rules out every free static host.

That leaves two genuinely different products:

- **A hosted demo anyone can click** — no key, no backend, deterministic
  navigation. `?demo=1` exists for exactly this.
- **A real-model instance** — needs a host that runs Node *and* a provider key.

---

## GitHub Pages — recommended

For the hosted demo. **Zero backend, zero cost, zero configuration.**

### Why it works unmodified

Verified, not assumed:

| | |
| --- | --- |
| Asset paths | all **relative** — `./main.js`, not `/main.js` |
| Bare imports | resolved by the **import map** in `index.html`, not a bundler |
| `three` / Rapier | loaded from **jsDelivr CDN**, pinned versions |
| Rapier WASM | inlined as base64 in the `-compat` build — **no second request** |
| `.wasm` files in `public/` | none |
| Server-side code | none — everything is static |

That last-but-one row is the one that usually breaks these deployments. The
non-`-compat` Rapier build fetches a separate `.wasm`, which needs correct MIME
configuration on the host. The `-compat` build avoids the problem entirely.

### Setup

1. **Settings → Pages → Source: Deploy from a branch**, branch `main`, folder
   `/ (root)`. The workflow picks it up automatically:

   ```yaml
   - uses: actions/upload-pages-artifact@v3
     with:
       path: bounce/public
   ```

2. The published URL is the repo's Pages URL. Add `?demo=1`:

   ```
   https://mheerspink75.github.io/Bounce/bounce/public/?demo=1
   ```

3. **Add `demo=1` to any link you share.** Demo mode is opt-in on purpose — it
   never engages automatically when the proxy is unreachable, because "the proxy
   is down" and "the model is scripted" must stay distinguishable.

### What a visitor sees

A working simulation, a character that solves mazes, the HUD reading
`provider demo`, and a `control` line that says `demo` rather than `model`. It is
honest about itself, which is the point — the README's screenshots come from real
model runs, and the demo should not pretend otherwise.

`npm run test:demo` asserts exactly this claim locally: a maze genuinely solved,
not merely rendered, with no server running.

### Limitation

**No real model.** The proxy cannot run from a CDN, so the hosted demo is the
scripted one. Pointing a visitor at a real model needs the options below.

---

## Vercel

For a **real-model** deployment.

Vercel runs Node functions, so the proxy deploys as-is. The static page deploys
separately and calls the function's URL.

```
bounce/
  api/
    proxy.js         <- wraps createProxy() as a Vercel function
  vercel.json
```

Two real problems to solve, both mechanical:

1. **Serverless functions are stateless.** The rate limiter is an in-memory
   sliding window, so a cold function resets it. Acceptable at demo scale;
   otherwise it needs a store.
2. **Cold starts.** The first request pays the Node boot. Budget ~1–2s, and note
   that a *character design* is already 49s, so the relative cost is small.

**The key lives in Vercel's environment variables**, not in the repo. That is the
same posture as `.env` locally — the browser never receives it either way.

---

## Netlify

Equivalent to Vercel for this project, and **not my recommendation**, for one
specific reason: Netlify Functions and Vercel's Node runtime both work, but
Netlify's free tier is more aggressively rate-limited for compute functions.

If Netlify is chosen anyway, the same two issues apply — stateless rate limiting
and cold starts — plus the same rule: **the key goes in environment variables,
never in `public/`.**

---

## Why the proxy cannot be hosted for free

Worth stating plainly, because it is the fact that shapes everything above:

| Requirement | Free static host |
| --- | --- |
| Long-running Node process | **no** |
| Server-side environment variables | **no** |
| Outbound HTTPS to a model provider | **no** |
| Cost of doing it anyway | an API key in the browser, in a **public** repo |

That last row is the one that actually settles it. A free host cannot hold a key,
and a key in browser JavaScript is trivially extractable. So "free hosting with a
real model" is not a configuration problem — it is a contradiction.

The honest options for a real model are a paid function host, or **running it
locally**, which is what this project's own instructions do.

---

## Decision summary

| Target | Backend | Real model | Cost | Recommended |
| --- | --- | --- | --- | --- |
| **GitHub Pages** | none | no (scripted demo) | free | **yes, for the demo link** |
| **Vercel** | Node function | **yes** | free tier / paid | **yes, for real-model hosting** |
| **Netlify** | Functions | **yes** | free tier / paid | works; less headroom |
| **Local** | two processes | **yes** | free | **what actually happens today** |

The README's demo link should point at Pages. A real-model deployment is worth
doing once someone wants one, and Vercel is the least-effort way.