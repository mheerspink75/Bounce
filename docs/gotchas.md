# Gotchas

Each of these cost real time to learn. Anything here that would otherwise be
rediscovered the hard way belongs in this file.

- [Validation and constrained output](#validation-and-constrained-output)
- [Tests that lie](#tests-that-lie)
- [Measurement and diagnosis](#measurement-and-diagnosis)
- [Timing and clocks](#timing-and-clocks)
- [Toolchain and environment](#toolchain-and-environment)
- [Models and providers](#models-and-providers)
- [Licensing](#licensing)

Related: [debugging-lessons.md](debugging-lessons.md) for the seven specific bugs
these lessons came from.

---

## Validation and constrained output

**A constrained field is not a correct field.** The worst bug in this project's
history produced output that was *schema-valid* and did nothing at all: an
optional `target` let a 1.5B emit `null` every time, the grammar forbade
recovering, and the maze silently never completed — 6 mazes, 4 minutes, 0
rewards, with a green test suite.

Ask what a small model does when a grammar offers it a way out. `required` closes
the exit; a non-null type on an optional field does not.

**A constrained field can be worse than no constraint.** Constrained decoding
made the failure *unrecoverable* rather than merely unlikely — the grammar had
closed off the paths back.

**Nonsense must be rejected, not clamped.** A negative `path_cells` clamped to 0
would tell the model "you are at the goal". A confident lie is worse than an
admitted unknown.

**HTTP 200 is not evidence that a constraint held.** Ollama accepts
`response_format: {type: "json_schema", …, strict: true}`, returns 200, and then
emits `intensity: 5` against `maximum: 1`.

**Never put a key in browser JavaScript.** Devtools extraction is trivial.

---

## Tests that lie

**Validate against the weakest model you intend to support, not the strongest one
you have.** A 7B scored 10/10 on all three schema variants; the 1.5B scored 0/10,
0/10, 8/10. Every test written against the capable model passed while the weak
one was inert.

**A passing assertion can be a worthless one.** "Every cell on the path is open"
proved nothing once walls lived on cell boundaries, because every cell is open.
When a representation changes, re-check that the assertions still *discriminate* —
try to make the bug pass the test.

**Ask how close a passing test came to failing.** Two bugs sat behind green
suites: a reward trigger that fired with **4mm** of margin (and 0.000m on one
seed), and an assertion that measured the wrong property. Neither was found by a
failing test. The useful question is not "does this pass" but "what would have to
go wrong for this to fail".

**A test that skips with exit 0 is not a test that passed.** `npm run
test:browser` prints `SKIP` and returns 0 when Chromium's libraries are missing,
so a green run can mean 142 assertions never executed. A skip needs to be visibly
different from a pass, or it will be reported as coverage it does not have.

**A dead flag is worse than a wrong one.** The mock provider branched on
`intent = true`, which no caller ever passed — it sent `purpose: 'intent'`. So
the mock answered every intent with a *character spec*, `sanitizeIntent` rejected
the unknown action, and the brain got `wander` every time. The suite stayed green
because `wander` is a valid action. **Grep for a parameter nobody passes.**

**Make the failure reachable.** A stall that appeared once in three 150-second
runs cannot be reproduced on demand, so the test stubs `sim.advance` and asserts
the escape fires rather than waiting for it.

---

## Measurement and diagnosis

**Measure before you fix, and log before you guess.** Three of the seven bugs were
found by adding a measurement first, after an intuitive guess turned out to be
wrong. "Slow with NIM, fast with mock" had two completely different candidate
causes, and only the timeline distinguished them.

**A diagnostic can be wrong in the direction that makes the bug look worse.** The
first version of `scripts/wall-penetration.mjs` measured distance in XZ and
ignored Y, so it reported 0.287m of "penetration" for a ball that was not inside
anything — it was in the air *above* the maze. A 2D test cannot tell "inside the
wall" from "above the wall". Both numbers were wrong in the direction of accusing
the code, which is the dangerous direction: had the first run been trusted, a
collision problem that did not exist would have been "fixed".

**A tidy story is a warning sign.** The wall deadlock measured 0.991 — the whole
force absorbed, unfixable by definition — and that number came from picking a wall
normal by nearest axis. The ball was against a wall's *end*, where the correct
normal is diagonal; recomputed properly it was 0.068. Both numbers came from the
same script and the wrong one was the one that made a compelling narrative. When a
measurement hands you a total explanation of a bug you have not yet explained,
re-derive it a second way.

**A tolerance borrowed from another test is not automatically the right
tolerance.** 2cm of penetration for the arena floor became the obvious number to
reuse for wall containment. It is 3.3% of a radius-0.3 ball's diameter and 0.5%
of a radius-2.0 ball's — 6.7x stricter on the largest, heaviest body, which is
backwards.

**A status is not a diagnosis.** The HUD said `brain error (53 asks, 0.0s avg)`
and `provider offline`, which says a request is failing and nothing about why. The
real cause was a 403 from the origin guard — one character of difference in the
page's address. `brain.state.lastError` had the reason the whole time and was
never rendered. Capture the cause, then *show* it.

**Check whether the symptom is in the layer you have been staring at.** "Passes
through the walls" was reported four times; three were physics, the fourth was the
character being invisible.

**My first two theories were both wrong, and measuring said so.** The
contradictory "vary the action between calls" line looked like the obvious culprit
for a small model ignoring the goal. Removing it changed nothing (14/16 vs 13/16 —
noise). The real cause was in the schema, in a field nobody suspected.

**Throwing away work when fixing a bug makes it worse.** A cached route plus a
staleness check, a lower speed cap, and a wall-clearance margin were each
reasonable in isolation and each made the failure rate go **up**. None of them was
the cause; all three were guesses layered on top of a real bug in `findPath`.

**Narrow the layer before theorising.** `node test/navigator.test.mjs` settles
routing questions as pure logic, with no physics at all.

---

## Timing and clocks

**Simulation time and wall-clock time are not the same clock.** Intent durations
are in *simulation* seconds; re-asks are paced by *wall* clock. In a browser they
agree. Headless they do not — a test loop covers 90 simulated seconds in about one
real second, so a 10s intent lapses and the brain never refreshes it. A test that
pins `now: () => 0` will make a working maze look unsolvable.

**Pacing requests from completion has a cost.** It correctly stops a slow provider
stacking requests, but it also means *no* requests are issued while one is in
flight — so anything that needs to get through promptly has to interrupt, not
queue.

**A rate limit and a poll interval have to be reconciled.** The intent endpoint at
2s is 30/min — the entire old shared budget, leaving nothing for the character
request each new maze needs.

**An intent's TTL is not its duration.** A manual intent sent with `ttl_s: 180` but
a default `duration_s` of 3 is obeyed for about half of its life.

---

## Toolchain and environment

**A GPU that `nvidia-smi` can see is not a GPU the stack will use.** `nvidia-smi`,
WSLg and a direct `cuInit` all reported the 1080 Ti, and ollama still ran on the
CPU, because the build it loaded was compiled for compute 7.5+ and the card is
6.1. The only line that said so was a single `skipping CUDA device` line in a
debug log. Check `ollama ps` → `PROCESSOR`.

**The Windows toolchain will happily run your Linux tests in the wrong
directory.** `npm` resolved to `/mnt/c/Program Files/nodejs`, which called
`cmd.exe`; cmd cannot `cd` to a `\\wsl.localhost\...` UNC path, so it defaulted to
`C:\Windows` and the tests failed looking for `C:\Windows\test\...`. The error
names a module, not a PATH problem, so it reads like a broken install.

**Windows maps `.js` to `text/plain`.** The browser then rejects every ES module.
`scripts/serve.py` calls `mimetypes.add_type("text/javascript", ".js")`. Without
it, nothing loads and the error names a syntax problem, not a MIME problem.

**An intermittent bug the user can see is not a bug to leave to chance.** A stall
that appeared once in three 150-second runs could not be pinned down, so the fix
targets the *state* rather than the cause: a character told to go somewhere and
not moving gets actively freed. Sometimes the honest response to "I cannot
reproduce this" is to make the outcome impossible rather than to keep hunting.

---

## Models and providers

**Reasoning models split their output.** `message.content` is the answer;
`message.reasoning_content` is scratch work. Reading the wrong field is how a
reasoning model appears to emit prose instead of JSON.

**A provider's model catalogue is not a reliable guide.** Most listed ids 404 on a
real call, and the NIM default originally configured now returns HTTP 410.

**The fastest model is often the useless one.** Measured: `qwen3:1.7b` answers in
0.24s and chooses the goal **0/5** times, with zero sanitiser intervention. Its
output was valid JSON doing nothing. `qwen3:4b` is 3x slower and works 5/5.

---

## Licensing

**MIT code does not mean shippable MIT output.** Check weights and body models
separately from the repo. Real cases from this project's research: RigNet's GPL
weights, Adobe's RigAnything (noncommercial only), SMPL/SMPL-X body models,
Hunyuan3D's licence (excludes EU/UK/South Korea, caps at 1M MAU).