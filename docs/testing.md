# Testing

433 assertions across three suites, plus diagnostic scripts for when a number
looks wrong.

- [Suites](#suites)
- [Running them](#running-them)
- [Live model checks](#live-model-checks)
- [Demo mode](#demo-mode)
- [Benchmarks](#benchmarks)
- [Diagnostic scripts](#diagnostic-scripts)
- [Test philosophy](#test-philosophy)

---

## Suites

| Suite | Count | Needs |
| --- | --- | --- |
| `npm test` (headless) | **232** | Node only. No browser, no network, no key. |
| — of which maze | 55 | generation, routing, reward loop |
| — of which timestep | 16 | the simulation keeps real time at low fps |
| `npm test` (server) | **59** | proxy, providers, extraction, sanitising |
| `npm run test:browser` | **142** | WebGL in a real browser; **both servers up** |
| **Total** | **433** | |

`npm test` needs only Node and exits 0 or 1 — no skipping, no network, no API
key. That matters because it is what runs in CI.

**`npm run test:browser` needs both servers up** (`:8080` static, `:8787`
proxy). It skips cleanly if Playwright is absent — which is a trap: see
[A test that skips with exit 0 is not a test that passed](#a-test-that-skips-with-exit-0-is-not-a-test-that-passed).

---

## Running them

```bash
npm test               # 232 headless + 59 server. No browser, no network, no key.
npm run test:maze      # 55 of those: maze generation, routing, and the reward loop
npm run test:timestep  # 16 of those: the simulation keeps real time at low fps
npm run test:browser   # 142 browser + WebGL assertions (needs both servers up)
npm run test:loop      # drives 2 full mazes unaided in the real page (needs both)
npm run test:demo      # static-only: solves a maze with no backend and no model
```

---

## Live model checks

These drive a real browser against a real provider. They are slower and are not
part of `npm test`, because they need hardware and a key.

```bash
npm run serve          # static server on :8080
npm run start          # LLM proxy on :8787
npm run check:ollama   # real qwen3:4b drives the ball; prints intents + errors
```

`scripts/live-ollama-check.mjs` reports every intent the model issued, the
distance travelled and any page errors. `scripts/live-browser-check.mjs` is the
same idea against a hosted provider.

`scripts/goal-prompt-check.mjs` answers the narrow question: **does a real model
pick the goal when told about it?** It reports `5/5` at ~0.6s against a local 7B.

---

## Demo mode

`npm run test:demo` is the check that backs the hosted-demo claim. It loads the
page with `?demo=1`, asserts the HUD reports `provider: demo`, asserts a
character arrives, and then asserts **a maze is actually solved** within a 60s
budget, with zero page errors. Writing `docs/demo-mode.png` is a side effect.

It is deliberately not a render check. "The page loaded" is not the claim; "the
thing works with no backend" is.

---

## Benchmarks

```bash
npm run bench:local                    # qwen3:4b vs qwen3:1.7b, through the proxy
npm run bench:local -- --models a,b    # a specific set
npm run bench:local -- --runs 10       # more samples
```

`scripts/bench-local.mjs` builds a **real proxy** per model on an ephemeral port
and calls through it, so JSON extraction and sanitising are *inside* the
measurement. Benchmarking the provider directly would measure something this
project does not do.

It reports intent latency, character generation time, **goal-selection rate** and
how often the sanitiser had to intervene. That last pair is why it exists: a 3x
faster model scored 0/5 on goal selection with zero sanitiser interventions —
valid JSON doing nothing. See [local-models.md](local-models.md#choosing-a-model).

---

## Diagnostic scripts

For when a number looks wrong:

```bash
node scripts/maze-timing.mjs         # seconds to the reward, no rendering
node scripts/substep-budget.mjs      # what a physics substep actually costs
node scripts/diagnose-maze.mjs 5     # ASCII map + what the navigator aimed at, seed 5
node scripts/maze-browser-check.mjs  # drives the real page, prints the event timeline
node scripts/loop-check.mjs 4        # the whole loop, 4 mazes, unaided
node scripts/goal-prompt-check.mjs   # does a real model pick the goal?
node scripts/wall-penetration.mjs 8 grow   # is the character ever inside a wall?
node scripts/reseed-check.mjs        # does a new seed actually produce a new maze?
node test/navigator.test.mjs         # routing, as pure logic, no physics
```

**Narrow the layer before theorising.** `navigator.test.mjs` is pure logic with
no physics at all, so it settles routing questions immediately.
`maze-browser-check.mjs` is the most useful when a number looks wrong: it reports
simulated time against wall clock and prints every intent change, character swap
and reward — which separates "the simulation is slow" from "the character is
misbehaving", two problems that look identical in a screenshot.

`wall-penetration` answers the question the perimeter assertion could not: it
measures 3D overlap per frame *and* watches for the character reaching a cell it
could not have walked to. `grow` resizes the character mid-run the way the loop
does, which is the case most likely to embed it in geometry.

---

## Test philosophy

The rules here were all learned from tests that were green while the product was
broken. Details in [debugging-lessons.md](debugging-lessons.md) and
[gotchas.md](gotchas.md).

1. **An assertion must be able to fail.** Verify a new test by reverting its fix
   and confirming it fails. `test/visual-sync.test.mjs` was checked this way (5
   of 6 assertions fail without the fix).
2. **Assert the property, not the symptom.** `worst < 8.5` bounded the outer
   perimeter and was named for tunnelling, which it did not test.
3. **Prefer topological assertions.** "The cell changed to an adjacent cell" has
   no tolerance and cannot be fudged. "Overlap is under 2cm" can be tuned green
   without fixing anything.
4. **Ask how close a passing test came to failing.** A 4mm margin is not a pass.
5. **Test the weakest supported model, not the strongest available.** A 7B scored
   10/10 on all three schema variants; the 1.5B scored 0/10, 0/10, 8/10.
6. **Tie test clocks to simulation time.** A headless loop covers 90 simulated
   seconds in about one real second, so a 10s intent lapses and the brain never
   refreshes it. A test that pins `now: () => 0` will make a working maze look
   unsolvable.
7. **Make the failure reachable.** `anti-stall.test.mjs` stubs `sim.advance` so the
   body never moves, rather than waiting for a 1-in-90-seconds stall.
8. **A skip must look different from a pass.**