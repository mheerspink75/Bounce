# Seven bugs worth remembering

Every one of these was found by the maze, and every one is the kind that a
passing test suite hides. Most were also reported more than once before being
diagnosed.

- [1. `findPath` ignored the walls](#1-findpath-ignored-the-walls)
- [2. A position controller cannot brake](#2-a-position-controller-cannot-brake)
- [3. The character could leave the maze without touching a wall](#3-the-character-could-leave-the-maze-without-touching-a-wall)
- [4. The walls were drawn in the wrong place](#4-the-walls-were-drawn-in-the-wrong-place)
- [5. The character could not be seen](#5-the-character-could-not-be-seen)
- [6. The character could wedge itself and stop](#6-the-character-could-wedge-itself-and-stop)
- [7. There was no invisible wall — the reward was a coin flip](#7-there-was-no-invisible-wall--the-reward-was-a-coin-flip)
- [The pattern](#the-pattern)

---

## 1. `findPath` ignored the walls

It checked only whether the *destination cell* was open — correct for the first
representation, where walls were whole cells, and silently wrong after the switch
to walls on cell boundaries, where every cell is open. BFS then routed straight
through them, and the character followed a perfectly plausible route into a wall.

The existing assertion — "every cell on the path is open" — was *trivially true*
and would never have caught it. The assertion that matters is **"the path never
crosses a wall"**.

> **When a representation changes, re-check that the assertions still
> discriminate** — try to make the bug pass the test.

## 2. A position controller cannot brake

Steering with force-toward-a-point means that when the aim swings 90° at a
corner, the character keeps its old momentum, overshoots, hits the far wall and
bounces back.

Measured: a character reached the end of the first corridor in 1s, then spent
**59 seconds** oscillating between two cells. Lowering the speed cap did not help.
Replacing it with a **velocity servo** — steer toward a *desired velocity*, so the
servo actively brakes as the target direction changes — fixed it.

The general lesson: the first three attempted fixes (cached routes with
invalidation, a lower speed cap, a wall-clearance margin) all made things *worse*,
and each was a guess.

What found both bugs was **bisecting the system** — a pure-logic test of the
navigator with no physics at all, which proved routing was correct before any of
the control questions were even asked.

> **Throwing away work when fixing a bug makes it worse.** Three reasonable
> changes, each layered on top of a real bug, and the failure rate went up each
> time.

## 3. The character could leave the maze without touching a wall

Reported as "the walls have no collision". They do — they always have. The
character was being *dropped in from above them*.

`toWorld()` returns `{x, z}`; it cannot know the character's radius. `createWorld`
built its maze spawn by spreading that, so the spawn object had **no `y` at
all**, and `createCharacter` fell through to its open-arena default of
`SPAWN_Y = 7`. The maze walls span y = −1.2 … 3.6, so every run began 3.4m above
the top of every wall and fell in. A hard enough landing sent it over them.

**A second bug was hiding behind the first.** `spawnAt` was captured once at
startup, so every later maze inherited the *first* maze's start cell and — worse
— the *first* radius as its height. Growing the character spawned the new, fatter
body with a stale `y`: a radius-2.0 ball at y=0.6 has its underside 1.4m inside
the floor, and Rapier's answer to that is to eject it. Measured **0.37m of
overlap** — clean through a 0.35m wall.

This one fires in normal operation, because the loop resizes the character every
generation.

**The assertion that should have caught it did not.** `navigation.test.mjs` had

```js
check('never tunnels through a maze wall', worst < 8.5, ...)
```

where `worst` is `max(|x|, |z|)`. That bounds the maze's *outer perimeter*. A ball
that walks through every internal wall and lands in the far corner satisfies it
completely. The assertion was named for the one property it did not test — a
worthless assertion by this project's own definition, sitting in the file whose
entire job is proving the maze works.

### Overlap is not pass-through

A loaded contact always leaves some penetration. A 2.0-radius ball shoved into a
corner overlaps by ~4cm while its centre is still **1.96m outside** the wall face.
Asserting on overlap alone cannot tell "pressed into a wall" from "went through
it", and tuning the tolerance until it went green would have hidden the bug
rather than fixed it.

So the load-bearing assertion is **topological**: track which cell the character
is in, and require that every change is between cells `maze.connected()` says are
adjacent. No tolerance, cannot be fudged. Measured over 100s × 6 seeds with the
character resizing underneath it: **0 crossings.**

One trap in building that check: cell indices are positions *in a particular
grid*, so a re-grid makes the previous index name a different place. Without
re-anchoring on a grid change it invents six crossings that never happened — which
is exactly what it did on the first run.

### A tolerance borrowed from another test is not automatically right

`test/physics.test.mjs` uses 2cm of penetration for the arena floor, so 2cm was
the obvious number to reuse. It is 3.3% of a radius-0.3 ball's diameter and 0.5%
of a radius-2.0 ball's — **6.7x stricter on the largest, heaviest body**, which is
backwards, since the same servo force presses a 4m ball harder. Wall containment
now scales the tolerance with the body. The pass-through assertion stays at
exactly zero regardless, which is the point of having both.

## 4. The walls were drawn in the wrong place

The same report, after the physics was fixed — which is what made this one worth
chasing rather than dismissing. Two of the three bugs above are *real* physics
faults, so the obvious conclusion was that a third must be too. It was not.

The scene builds its wall meshes once, from `sim.statics`, at startup. The maze
advances on every reward, and `installMaze` splices the old wall entries out of
`statics` and pushes new ones in — **but nothing rebuilt the meshes**. So from the
first reward onward:

- **drawn** walls: the first maze, forever
- **colliders**: the current maze

The character navigated the real maze and therefore appeared to walk straight
through walls that were merely *drawn* where the old maze had been. After a
re-grid to a 3×3 layout it was walking around a 20-wall maze that no longer
existed, drawn on screen as 8 walls it could pass through.

The lesson is about *where a bug can live*. Every wall test here is headless, and
a headless test cannot see this: the fault is entirely in the disagreement between
what is simulated and what is drawn.

`sim.staticsVersion` is the fix — it increments whenever the static geometry is
replaced, and the render loop rebuilds the meshes when it changes, disposing the
old geometry and material first. The maze advances every ~12s, so leaking a pair
per generation is a slow GPU memory climb.

`test/visual-sync.test.mjs` compares the scene graph against `sim.statics` across
maze advances and a re-grid, and it was verified to **fail** with the fix reverted
(5 of 6 assertions) — because a test that passes either way is the thing this
whole document is about.

## 5. The character could not be seen

Same report, fourth time. By this point three genuine faults had been found and
fixed under it, which made a fourth fault the obvious assumption — and it was
wrong, twice over.

The ball was inside a legal corridor the whole time. Every measurement agreed: no
cell crossings, no wall overlap (0.0008m), apex 2.0m against a 3.6m wall top,
nearest wall 0.92m away, colliders matching meshes exactly. What it had instead
was **occlusion**: raycast from the camera to the character, it was fully hidden
behind a wall in **36–60% of frames** at the old 42° default. It vanished and
reappeared, which is indistinguishable from escaping.

The walls are 2.4m tall and opaque, and that is not adjustable: a radius-2.0
character *rests* with its centre at y=2.0, and the measured maximum centre height
over 5 radii × 4 seeds is 2.036m, so walls below ~2.4 would let the largest
characters roll straight out. **Shortening them was the obvious fix and
measurement killed it.**

| look-down | hidden |
| --- | --- |
| 42° (old default) | 36–60% |
| 53° | 58% |
| 62° | 6% |
| 73° | 0–**90%**, by seed |

Seed 2 refuses to be fixed by geometry: the ball spends its time in the far half
of a corridor with the near wall between it and the camera. Only a near-top-down
view reached 0%, and that throws away the 3D the project is for.

So the guarantee is a **depth-independent locator shell** — a faint sphere at
`radius × 1.08` with `depthTest: false`, `depthWrite: false` and
`renderOrder: 999`. A separate shell rather than `depthTest: false` on the
character mesh, so the character keeps its proper shading and self-occlusion and
only the locator ignores depth. The camera moves to 73° and `OrbitControls` is
clamped to 0.10–0.30 rad, because a user who could orbit back to 42° would walk
straight into the same misreading.

`test/visibility.test.mjs` asserts the *guarantee* — that a depth-independent
marker exists, tracks the body, is sized to the live character, and does not leak
across swaps — rather than pretending the geometry can be arranged so occlusion
never happens. The raw occlusion percentage is printed, not asserted, because it
is a property of the maze layout rather than a defect.

> **A character you cannot see is indistinguishable from one that is escaping.**
> When a symptom is reported repeatedly, the cheap move is to look for a fault in
> the layer you have already been fixing, and the expensive move — the one that
> was needed here — is to check whether the symptom is even in that layer at all.

## 6. The character could wedge itself and stop

Reported as getting stuck on walls, with a screenshot showing `speed 0.00 m/s`
beside `control model` and `charge_target -> goal` — the model asking for
movement, the servo pushing, the ball not budging, and nothing anywhere saying
why.

Instrumenting the live page caught exactly one: a **5.15s** stall, seed 29, 4x4,
radius 1.0, `speed < 0.03` throughout. The next two 150-second runs caught nothing,
at the same seed and spec. **So the cause was never identified**, and this is the
one bug here whose mechanism is still unknown.

Two things were added:

- **`slide()`** removes the component of the heading that drives into a wall, so
  the tangential part survives. At the observed stall position the raw heading
  drove **0.068** into a wall, and sliding takes that to **0.000**.

  That number was first reported as **0.991** — a total deadlock — because the
  normal was chosen by nearest axis, which is wrong at a wall's *end*, where the
  correct normal is diagonal. Both came from the same script; only one was right,
  and the wrong one told a much tidier story. So this is a real improvement and it
  is cheap, but **6.8% absorbed is not a five-second stall.**

- **A watchdog** (`watchForStall`) measures that the character is not moving while
  it is being told to go somewhere, and for 0.5s steers *across* the contact
  rather than into it. This addresses the symptom, and is the right shape of fix
  precisely because the cause is unknown: an intermittent stall a user sees and a
  test cannot reproduce is not something to leave to chance, and not something to
  keep hunting for either. A stuck character is a visible failure and a
  briefly-turned one is not.

Longest observed stall across the same 150s live run: **5.15s → 0.85s**, none over
1s, average speed 2.0 m/s.

`test/anti-stall.test.mjs` makes "stuck" reachable instead of waiting for it:
`sim.advance` is stubbed so the body never moves, and the test asserts the escape
fires — **90° of deflection with the watchdog, 4° without**. That distinction
matters, because "the push changed" also passes with the watchdog disabled (a servo
wobbling satisfies it), so the first version of that test was measuring the wrong
thing.

> **A tidy story is a warning sign.** When a measurement hands you a total
> explanation of a bug you have not yet explained, that is the moment to re-derive
> it a second way.

## 7. There was no invisible wall — the reward was a coin flip

Reported as sometimes getting stuck right before the goal, like something
invisible was in the way. There was nothing in the way: the ball was *inside the
goal cell*, beside the marker, moving at 2.18 m/s, and the reward simply never
fired.

The trigger was "within `radius + 0.5` of the goal marker". Measured over 16 seeds
at three radii:

| radius | trigger | margin |
| --- | --- | --- |
| 0.5 | 1.00m | 0.012 – 0.046m |
| 0.6 | 1.10m | **0.004** – 0.046m |
| 1.0 | 1.50m | **0.000** – 0.045m |

Seed 4 at radius 1.0 fired at *exactly* the boundary. **A test that passes by 4mm
is not a test, it is a coincidence that has not failed yet.**

And nothing in the suite caught it, because the suite asserts that the maze *is*
solved, which it always was — the trigger was simply firing a hair too late. On a
real run with a real model in the loop, one different intent or one different
bounce was enough to miss.

The maze already answers "did it arrive" — it has a goal *cell*. Testing that is
both the semantically correct question and enormously more robust: a 3.16m box
instead of a 1.0m circle, so the ball is caught up to 2.23m from the marker if it
stops at the cell entrance, while staying bounded so it cannot fire from across the
maze. Measured margin after the change: **0.44 – 0.62m**, a **10x** improvement,
and the reward now reports `via: 'cell' | 'radius'` so a timeline says how it
happened.

One subtlety worth the trouble: `toCell` **clamps** to the grid, so a ball sitting
outside the perimeter is reported as being in the nearest edge cell — and the goal
is a corner cell, so the naive cell test would fire the reward from *outside* the
maze. `test/goal-arrival.test.mjs` asserts that trap exists (it does: that spot
really does report as cell `[4,4]`) and that the bounds check defeats it.

---

## The pattern

Six of these seven were found by **adding a measurement first**, after an
intuitive guess turned out to be wrong. A substep cost benchmark, a simulated
clock, an event timeline, an occlusion raycast, a topological crossing check —
each one cheap, and each one contradicting a plausible story.

> **Measure before you fix, and log before you guess.**

And **two of the last bugs were things a passing test suite was quietly getting
away with** — a 4mm margin, and an assertion that measured the wrong property.
Neither was found by a failing test. Both were found by asking what number would
have to be unlucky for the bug to appear, and going looking for a number that
close to the edge.

Generalised further, in [gotchas.md](gotchas.md):

- **A passing assertion can be a worthless one.**
- **Ask how close a passing test came to failing.**
- **A diagnostic can be wrong in the direction that makes the bug look worse.**
- **A status is not a diagnosis.**
- **An intermittent bug the user can see is not a bug to leave to chance.**
- **Checking whether the symptom is in the layer you have been staring at.**