# Performance analysis

Where the time actually goes, measured rather than assumed.

- [The frame budget](#the-frame-budget)
- [Physics is not the bottleneck](#physics-is-not-the-bottleneck)
- [The substep cap](#the-substep-cap)
- [Latency: two clocks](#latency-two-clocks)
- [Where the real cost is](#where-the-real-cost-is)
- [Load time](#load-time)

---

## The frame budget

A browser frame is 16.7ms at 60fps. Physics substeps are 1/60s each, so a
rendering-slow page must run *more* of them per frame to keep simulation time
matching real time — up to a cap.

That cap is the whole design tension: **too tight and the demo quietly lies.**

---

## Physics is not the bottleneck

`scripts/substep-budget.mjs`:

```
20000 single-substep advances took 697.0ms
  -> 0.03485 ms per 1/60s substep
cap 5 -> 0.17ms/frame   (0.2% of a 66-83ms frame)
cap 15 -> 0.52ms/frame  (0.6%)
```

**Physics is 0.2% of the frame** on a software renderer.

So when something is slow, it is never the solver. Measured, in order of how
often it has actually been the cause:

1. **The model.** Not the solver — the model.
2. **Serialised requests.** One Ollama slot instead of two.
3. **Rendering.** Software rasterisation in headless Chromium.

---

## The substep cap

A cap exists so a stall cannot trigger a death spiral of steps. It is also the
easiest way to make a demo lie: if the cap is too tight, the simulation quietly
runs slower than real time, and **every timing the project reports becomes wrong
while every test still passes** — the tests assert outcomes, not rates.

The old cap of 5 meant the simulation went slow below 12fps, which is exactly
where a software-rendered headless browser sits.

Worse, `MAX_SUBSTEPS × FIXED_TIMESTEP` was 0.083s while `MAX_FRAME_DT` was 0.25s,
so the two halves of the same safety mechanism **disagreed by 3x** and the frame
clamp was dead code.

The cap is now **derived** from `MAX_FRAME_DT`, so they cannot drift apart again,
and real time holds down to 4fps for 0.5ms a frame.

`test/timestep.test.mjs` pins it: 100% of real time at every rate from 60 to
4fps, no drift over 5 simulated minutes, and a 5-second stall still clamped to
0.25s.

> **Simulation time and wall-clock time are not the same clock.** Intent
> durations are in *simulation* seconds; re-asks are paced by *wall* clock. In a
> browser they agree. Headless they do not.

---

## Latency: two clocks

**Intents are held for `duration_s` of simulation time**, so a backgrounded tab
does not change the character's mind.

**Requests are paced from wall-clock completion**, so a slow provider makes the
brain ask less often instead of stacking up requests.

That second choice has a cost worth stating plainly: *no* requests are issued
while one is in flight. So anything that needs to get through promptly has to be
able to **interrupt, not queue** — which is why `brain.interrupt()` exists and
why the HUD polls `/api/health` every 200ms.

### What that cost, measured

On seed 1 with the live NIM provider, the maze took **30.5s of simulated time**:

```
t= 0.00  intent  wander
t=22.05  intent  charge_target -> goal
t=30.92  REWARD
```

22 of 30 seconds dead, waiting on a request nobody wanted. After the interrupt
path:

```
t= 0.00  intent  wander
t= 1.90  OVERRIDE  manual override appeared
t= 2.25  intent  charge_target -> goal
t=11.15  REWARD
```

**28.4s → 8.6s**, and 7.9s of that is the walk itself, which matches the 8.1s
headless figure. Override-to-intent is 0.35s.

> **A status is not a diagnosis.** The HUD said `brain error (53 asks, 0.0s avg)`
> and `provider offline`, which says a request is failing and nothing about why.
> The real cause was a 403 from the origin guard — one character of difference in
> the page's address.

---

## Where the real cost is

Measured on the current machine (Intel Arc Pro B60, 100% GPU, ~80 tok/s):

| Operation | Time | Notes |
| --- | --- | --- |
| Intent call, warm | **0.68s** | inside the brain's 2s poll |
| Intent call, cold | ~2.6s | weights loading; can be much worse |
| **Character design** | **49.1s** | thinking mode **on**, 6000 max tokens |
| Manual intent | 0.35s | override → intent |

**Character generation is 70x an intent call.** That asymmetry drives real design
decisions:

- The loop advances the maze **instantly** and lets the character catch up, rather
  than making the player watch a finished board for most of a minute.
- `OLLAMA_NUM_PARALLEL=2` is load-bearing: with the default of 1, a design
  serialised against the control loop and a 0.65s intent took **40–45s** to
  answer. Measured warm with two slots, intents stay at **0.64–0.89s** throughout
  a 47s design.
- `duration_s` for intents is capped at 10s while character generation is
  unbudgeted on the client side, because the two are not the same kind of request.

> **A rate limit and a poll interval have to be reconciled.** Intents at 2s are
> 30/min — the entire old shared budget, leaving nothing for the character
> request each new maze needs. They now have separate budgets (intents 120/min,
> characters 12/min) because they are different kinds of traffic.

---

## Load time

| Dependency | Raw | Gzipped |
| --- | --- | --- |
| `three` | 648 KB | ~150 KB |
| Rapier `-compat` (WASM inlined as base64) | 4.2 MB | **1.6 MB** |

Rapier dominates and is the biggest cost in the project. If load time matters,
the mitigations in order of effort are: serve the non-`-compat` build with a real
`.wasm` file, lazy-load after first paint, or drop to a smaller physics library.

This is also why `?demo=1` exists — a static-hosted demo needs no server
round-trip at all, so first paint is the only latency that matters there.