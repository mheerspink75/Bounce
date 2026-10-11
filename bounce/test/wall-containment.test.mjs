/**
 * The character is never inside a wall.
 *
 * This exists because the assertion that claimed to cover it did not.
 * `test/navigation.test.mjs` had:
 *
 *   check('never tunnels through a maze wall', worst < 8.5, ...)
 *
 * where `worst` is max(|x|,|z|). That bounds the maze's outer perimeter and
 * nothing else. A ball that goes through every internal wall is still well
 * inside 8.5, so the assertion passed on a completely broken maze — while being
 * named for the one property it did not test. This project's own rule is that a
 * passing assertion has to *discriminate*, so the fix is to assert the real
 * thing and let this file fail if it regresses.
 *
 * What it actually checks, per frame, for every wall box in the world:
 *
 *   3D distance from the character centre to the box  <  character radius
 *
 * Three dimensions, not two. A 2D XZ test cannot distinguish "inside the wall"
 * from "above the wall", and that distinction *was* the bug: the maze spawn
 * carried no `y`, so `createCharacter` fell through to its arena default of
 * `SPAWN_Y = 7` and dropped the character in from 3.4m above the top of every
 * wall. It looked exactly like the walls had no collision.
 *
 * 2cm is the threshold `test/physics.test.mjs` already uses for "penetration
 * stays shallow", so the two numbers mean the same thing. Rapier's solver leaves
 * ~1mm of overlap on any resting contact, so the threshold cannot be zero.
 *
 *   node test/wall-containment.test.mjs
 */
import { createWorld, FIXED_TIMESTEP } from '../public/physics.js';
import { createBrain } from '../public/brain.js';
import { DEFAULT_SPEC, sanitizeSpec } from '../public/spec.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * Contact slop, as a fraction of the character's own diameter.
 *
 * Rapier's solver leaves overlap on any loaded contact, so this cannot be zero.
 * The obvious choice is to copy the 2cm figure `test/physics.test.mjs` uses — and
 * that is wrong here, because a fixed length is 3.3% of a radius-0.3 ball's
 * diameter but only 0.5% of a radius-2.0 ball's. It is 6.7x stricter on the
 * largest, heaviest body, which is exactly backwards: the same servo force on a
 * 4m ball presses harder, and its steady-state penetration is proportionally
 * similar rather than 6.7x smaller.
 *
 * 2% of diameter: 0.024m at r=2.0 is a shade under what was measured (0.042m,
 * sphere surface 4cm into a 35cm wall, centre still 1.96m outside the wall face),
 * so this is a real bound and not a rubber stamp.
 *
 * This tolerance is deliberately *not* the load-bearing assertion. Overlap cannot
 * distinguish "pressed into a wall" from "went through it", and the bug that
 * started this was invisible to a purely geometric check. The assertion that must
 * never regress is the pass-through one at the bottom of this file, which is
 * exactly zero with no tolerance at all.
 */
const SLOP_FRACTION = 0.02;
const slopFor = (radius) => SLOP_FRACTION * 2 * radius;

/** Distance from a point to an axis-aligned box; 0 when inside. */
function distToBox(p, half, pos) {
  const dx = Math.max(Math.abs(p.x - pos[0]) - half[0], 0);
  const dy = Math.max(Math.abs(p.y - pos[1]) - half[1], 0);
  const dz = Math.max(Math.abs(p.z - pos[2]) - half[2], 0);
  return Math.hypot(dx, dy, dz);
}

/** Deepest overlap of the character with any wall, in metres. */
function deepestOverlap(sim, radius) {
  const p = sim.character.body.translation();
  let worst = -Infinity;
  for (const w of sim.maze.walls) {
    const overlap = radius - distToBox(p, w.half, w.pos);
    if (overlap > worst) worst = overlap;
  }
  return worst;
}

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function harnessClock() {
  const state = { ms: 0 };
  return { now: () => state.ms, tick(dt = FIXED_TIMESTEP) { state.ms += dt * 1000; } };
}

console.log('\nwall containment: the character never occupies wall space\n');

// --- the spawn is on the floor, not in the air above the maze ---------------
// Asserted directly, because this is the bug and it is cheap to state. A maze's
// walls span y = -1.2 .. 3.6, and the character must start below that.
{
  let worstApex = -Infinity;
  let spawnY = null;
  for (const radius of [0.15, 0.3, 0.6, 1.2, 2.0]) {
    const sim = await createWorld({
      spec: sanitizeSpec({ ...DEFAULT_SPEC, radius }),
      mazeSeed: 1,
    });
    const body = sim.character.body;
    if (spawnY === null) spawnY = body.translation().y;
    for (let i = 0; i < 120; i += 1) {
      sim.advance(FIXED_TIMESTEP);
      if (i % 30 === 0) await settle();
      worstApex = Math.max(worstApex, body.translation().y);
    }
  }
  check('the character spawns on the floor, not dropped in from above',
    worstApex < 3.6,
    `apex ${worstApex.toFixed(3)}m vs wall top 3.600m`);

  const sim = await createWorld({ mazeSeed: 1 });
  check('the spawn sits exactly one radius above the floor',
    Math.abs(sim.character.body.translation().y - sim.character.spec.radius) < 1e-6,
    `y=${sim.character.body.translation().y.toFixed(3)} r=${sim.character.spec.radius}`);
}

// --- it never ends a frame inside a wall, across seeds and sizes ------------
{
  let worstOverall = -Infinity;
  const perSeed = [];
  for (let seed = 1; seed <= 8; seed += 1) {
    for (const radius of [0.3, 0.6, 1.5]) {
      const sim = await createWorld({
        spec: sanitizeSpec({ ...DEFAULT_SPEC, radius }),
        mazeSeed: seed,
      });
      const clock = harnessClock();
      const brain = createBrain({
        sim,
        ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
        now: clock.now,
      });
      let worst = -Infinity;
      for (let i = 0; i < 60 * 20 && !sim.reached; i += 1) {
        clock.tick();
        brain.update(FIXED_TIMESTEP);
        sim.advance(FIXED_TIMESTEP);
        if (i % 30 === 0) await settle();
        worst = Math.max(worst, deepestOverlap(sim, sim.character.spec.radius));
      }
      worstOverall = Math.max(worstOverall, worst);
      perSeed.push({ seed, radius, worst });
    }
  }
  const breaches = perSeed.filter((s) => s.worst > slopFor(s.radius));
  check('never occupies wall space across 8 seeds x 3 radii',
    breaches.length === 0,
    `worst overlap ${worstOverall.toFixed(4)}m, ${breaches.length} breach(es)`);
  for (const b of breaches.slice(0, 5)) {
    console.log(`      seed ${b.seed} r=${b.radius}: ${b.worst.toFixed(4)}m `
      + `(tolerance ${slopFor(b.radius).toFixed(3)}m)`);
  }
}

// --- growing the character mid-run must not embed it in geometry ------------
// The case most likely to fail: `replaceCharacter` drops the new, fatter body in
// just above the old one, so a radius increase is when a sphere is most likely
// to appear inside a wall the old, smaller one fitted through.
{
  const grow = [0.3, 1.5, 2.0, 0.6, 1.2, 0.3, 2.0];
  let worst = -Infinity;
  let swaps = 0;
  for (let seed = 1; seed <= 4; seed += 1) {
    const sim = await createWorld({ spec: sanitizeSpec({ ...DEFAULT_SPEC, radius: grow[0] }), mazeSeed: seed });
    const clock = harnessClock();
    const brain = createBrain({
      sim,
      ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
      now: clock.now,
    });
    // Long enough to reach the regime where a 2.0-radius ball squeezes a corner:
    // the deepest overlap seen anywhere was at t=97s, which a 14s run never hits.
    for (let i = 0; i < 60 * 100; i += 1) {
      clock.tick();
      brain.update(FIXED_TIMESTEP);
      sim.advance(FIXED_TIMESTEP);
      if (i % 30 === 0) await settle();
      // Measure straight after the swap, which is the dangerous instant, against
      // the tolerance for the radius that is live *now* — the previous radius's
      // tolerance is meaningless for a body three times its size.
      worst = Math.max(worst, deepestOverlap(sim, sim.character.spec.radius) - slopFor(sim.character.spec.radius));
      if (i > 0 && i % (60 * 10) === 0) {
        sim.replaceCharacter(sanitizeSpec({ ...DEFAULT_SPEC, radius: grow[swaps % grow.length] }));
        swaps += 1;
        worst = Math.max(worst, deepestOverlap(sim, sim.character.spec.radius) - slopFor(sim.character.spec.radius));
      }
      if (sim.reached) sim.resetGoal();
    }
  }
  check('growing the character mid-run never embeds it in a wall',
    worst <= 0,
    `${swaps} swaps, worst ${worst.toFixed(4)}m beyond a ${SLOP_FRACTION * 100}%-of-diameter tolerance`);
}

// --- and it can still solve the maze ----------------------------------------
// A containment fix that stops the character moving would pass everything above.
{
  let solved = 0;
  for (let seed = 1; seed <= 6; seed += 1) {
    const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: seed });
    const clock = harnessClock();
    const brain = createBrain({
      sim,
      ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
      now: clock.now,
    });
    for (let i = 0; i < 60 * 60 && !sim.reached; i += 1) {
      clock.tick();
      brain.update(FIXED_TIMESTEP);
      sim.advance(FIXED_TIMESTEP);
      if (i % 30 === 0) await settle();
    }
    if (sim.reached) solved += 1;
  }
  check('the maze is still solvable after the fix', solved === 6, `${solved}/6 seeds`);
}

// --- and it never *reaches* the far side of a wall --------------------------
// The assertion that actually matches the complaint. Overlap alone cannot tell
// "pressed into a wall" from "went through it": a rigid-body solver leaves
// millimetres of overlap during a hard squeeze, and a 2.0-radius ball in a 4.9m
// corridor briefly overlaps by 6cm without going anywhere. Both were measured.
//
// So track cells. `maze.connected(a, b)` is true only for orthogonally adjacent
// cells with no wall between them, so landing in a cell that is not connected to
// the one it was in means it is on the wrong side of something. That is
// pass-through, and no amount of solver slop can fake it.
{
  let crossings = 0;
  const details = [];
  for (let seed = 1; seed <= 6; seed += 1) {
    const sim = await createWorld({ spec: sanitizeSpec({ ...DEFAULT_SPEC, radius: 0.3 }), mazeSeed: seed });
    const clock = harnessClock();
    const brain = createBrain({
      sim,
      ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
      now: clock.now,
    });
    const cellOf = () => {
      const p = sim.character.body.translation();
      return sim.maze.toCell(p.x, p.z);
    };
    let last = cellOf();
    let dims = sim.maze.dims;
    for (let i = 0; i < 60 * 100; i += 1) {
      clock.tick();
      brain.update(FIXED_TIMESTEP);
      sim.advance(FIXED_TIMESTEP);
      if (i % 30 === 0) await settle();
      // A re-grid changes what a cell index means, so the comparison has to be
      // re-anchored. Without this the test invents crossings after every resize.
      if (sim.maze.dims !== dims) { dims = sim.maze.dims; last = cellOf(); continue; }
      const cell = cellOf();
      if (cell[0] !== last[0] || cell[1] !== last[1]) {
        if (!sim.maze.connected(last, cell)) {
          crossings += 1;
          if (details.length < 5) details.push(`seed ${seed} ${last} -> ${cell}`);
        }
        last = cell;
      }
      if (sim.reached) sim.resetGoal();
    }
  }
  check('never reaches a cell on the far side of a wall (100s x 6 seeds)',
    crossings === 0,
    `${crossings} crossing(s)${details.length ? `: ${details.join(', ')}` : ''}`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
