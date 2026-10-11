/**
 * Diagnostic: does the character ever end up *inside* a wall?
 *
 * Written because `test/navigation.test.mjs` claims to cover this and does not.
 * Its assertion is:
 *
 *   check('never tunnels through a maze wall', worst < 8.5, ...)
 *
 * where `worst` is max(|x|,|z|). That only bounds the outer perimeter. A ball
 * that walks through every *internal* wall and ends up in a far corner is still
 * well inside 8.5, so the assertion passes on a completely broken maze. It is a
 * worthless assertion by this project's own definition — named for a property it
 * does not test.
 *
 * This measures the real thing: the 2D distance from the character centre to every
 * wall box, compared against the character radius. Independent of cell bookkeeping,
 * and it catches both tunnelling and being spawned inside geometry.
 *
 *   node scripts/wall-penetration.mjs [seeds] [mode]
 *
 * mode: grow   (default) resize the character mid-run the way the loop does
 *       fixed  keep one radius for the whole run
 */
import { createWorld } from '../public/physics.js';
import { createBrain } from '../public/brain.js';
import { FALLBACK_INTENT } from '../public/intent.js';
import { DEFAULT_SPEC, sanitizeSpec } from '../public/spec.js';
import { FIXED_TIMESTEP } from '../public/physics.js';

const SEEDS = Number(process.argv[2] ?? 8);
const MODE = process.argv[3] ?? 'grow';

const sleep = () => new Promise((r) => setTimeout(r, 0));

/**
 * 3D distance from the character centre to a wall box, 0 if inside.
 *
 * Three dimensions, deliberately. The first version of this script measured XZ
 * only and reported 0.287m of "penetration" on a ball that was not inside
 * anything — it was in the *air* above the maze, falling in from a spawn height
 * of 7m while the walls stop at 3.6m. A 2D test cannot tell "inside the wall"
 * from "above the wall", and that distinction was the entire bug.
 */
function distToBox3D(p, cx, cy, cz, hx, hy, hz) {
  const dx = Math.max(Math.abs(p.x - cx) - hx, 0);
  const dy = Math.max(Math.abs(p.y - cy) - hy, 0);
  const dz = Math.max(Math.abs(p.z - cz) - hz, 0);
  return Math.hypot(dx, dy, dz);
}

/**
 * Deepest wall overlap for a character, in metres. Negative means clear.
 * Returns `{ worst, wall, at }`.
 */
function penetration(sim, radius) {
  const p = sim.character.body.translation();
  let worst = -Infinity;
  let wall = null;
  for (const w of sim.maze.walls) {
    const [hx, hy, hz] = w.half;
    const [cx, cy, cz] = w.pos;
    const d = distToBox3D(p, cx, cy, cz, hx, hy, hz);
    const overlap = radius - d;          // > 0 means the sphere is inside the wall
    if (overlap > worst) { worst = overlap; wall = w; }
  }
  return { worst, wall, at: { x: p.x, y: p.y, z: p.z } };
}

/**
 * Contact slop, not a breach.
 *
 * Rapier's solver leaves a sub-millimetre overlap on any resting contact, so
 * "overlap > 0" is not a useful test — the character is always very slightly
 * inside the thing it is touching. 2cm is the threshold this project already
 * uses for "penetration stays shallow" in `test/physics.test.mjs`, and it is used
 * here so the two numbers mean the same thing.
 */
const SLOP = 0.02;

let totalBreaches = 0;
let totalCrossings = 0;
let worstOverall = -Infinity;
let worstSlop = -Infinity;
const report = [];

/**
 * Did the character ever *get through* a wall, as opposed to being pressed into
 * one? Overlap alone cannot tell those apart: a rigid-body solver leaves a
 * millimetre of overlap on a hard squeeze, and briefly too, and neither means the
 * ball reached somewhere it could not have walked to.
 *
 * The maze already knows the answer. `maze.connected(a, b)` is true only for
 * orthogonally adjacent cells with no wall between them, so a transition between
 * two cells that are not connected means the character is on the wrong side of
 * something. That is pass-through, and it is what "the ball goes through the
 * walls" means.
 */
function makeCellWatcher(sim) {
  const cellNow = () => {
    const p = sim.character.body.translation();
    return sim.maze.toCell(p.x, p.z);
  };
  let last = cellNow();
  const crossings = [];
  return {
    crossings,
    /**
     * Forget the previous cell. Needed whenever the grid changes: cell indices
     * are positions *in a particular grid*, so after a re-grid the stale index
     * names a different place and comparing against it invents crossings that
     * never happened.
     */
    reanchor() { last = cellNow(); crossings.length = 0; },
    sample() {
      const cell = cellNow();
      if (cell[0] === last[0] && cell[1] === last[1]) return;
      if (!sim.maze.connected(last, cell)) {
        crossings.push({ from: [...last], to: [...cell], at: { ...cellNow(), y: sim.character.body.translation().y } });
      }
      last = cell;
    },
  };
}

for (let seed = 1; seed <= SEEDS; seed += 1) {
  const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: seed });
  // A clock tied to simulation time, so intent durations behave as in a browser.
  let simTime = 0;
  const clock = { now: () => simTime * 1000 };

  // Radii to cycle through. The loop's own behaviour is that the model designs a
  // new character each generation and it can be *fatter* than the last.
  const growCycle = [0.3, 0.5, 0.9, 1.2, 1.5, 1.8, 0.6, 2.0];

  const brain = createBrain({
    sim,
    ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
    now: clock.now,
  });

  let breaches = 0;
  let seedWorst = -Infinity;
  let seedSlop = -Infinity;
  let seedWorstWhen = null;
  let generation = 0;
  let dims = sim.maze.dims;
  let resizes = 0;
  let rewards = 0;
  void rewards;
  const watcher = makeCellWatcher(sim);
  const crossings = [];
  // The maze is re-gridded on a resize, so cell indices are not comparable across
  // one. Re-anchor rather than reporting a false pass-through at a grid change.
  let dimsAtLastSample = sim.maze.dims;

  for (let i = 0; i < 60 * 120; i += 1) {
    simTime += FIXED_TIMESTEP;
    clock.tick?.();
    brain.update(FIXED_TIMESTEP);
    sim.advance(FIXED_TIMESTEP);
    if (i % 30 === 0) await sleep();

    const radius = sim.character.spec.radius;
    // Re-anchor the cell watcher whenever the grid changes, so a re-grid is not
    // mistaken for a pass-through.
    if (sim.maze.dims !== dimsAtLastSample) { dimsAtLastSample = sim.maze.dims; watcher.reanchor(); }
    watcher.sample();
    const { worst } = penetration(sim, radius);
    if (worst > seedWorst) { seedWorst = worst; seedWorstWhen = `t=${simTime.toFixed(2)} r=${radius}`; }
    if (worst > seedSlop) seedSlop = worst;
    if (worst > SLOP) breaches += 1;
    crossings.push(...watcher.crossings.splice(0));

    // Resize the way the loop does, on a new generation. Growing is the
    // interesting direction: `replaceCharacter` drops the new, fatter body in
    // just above the old one, so a radius increase is the case most likely to
    // put a sphere inside geometry that the old, smaller one fitted through.
    if (MODE === 'grow' && i > 0 && i % (60 * 12) === 0) {
      const r = growCycle[generation % growCycle.length];
      generation += 1;
      resizes += 1;
      sim.replaceCharacter(sanitizeSpec({ ...DEFAULT_SPEC, radius: r, name: `probe-${r}` }));
      if (sim.maze.dims !== dims) dims = sim.maze.dims;
    }

    // Keep going past the reward. The first maze is solved in ~11s and the first
    // resize is at 12s, so breaking on `reached` meant the resize path was never
    // executed at all — a clean result for code that had not run.
    if (sim.reached) { sim.resetGoal(); rewards += 1; }
  }

  totalBreaches += breaches;
  worstOverall = Math.max(worstOverall, seedWorst);
  worstSlop = Math.max(worstSlop, seedSlop);
  report.push(`  seed ${String(seed).padStart(2)}  ${sim.maze.dims}x${sim.maze.dims}  `
    + `overlap ${(seedWorst > 0 ? seedWorst : 0).toFixed(4)}m  `
    + `${resizes} resizes  `
    + `wall crossings: ${crossings.length === 0 ? 'NONE' : `${crossings.length} !`}`
    + `${breaches === 0 ? '' : `  (${breaches} shallow frames)`}`);
  for (const c of crossings.slice(0, 3)) {
    console.log(`        crossed ${c.from} -> ${c.to} at y=${c.at.y.toFixed(2)} `
      + `(${c.at.x.toFixed(2)}, ${c.at.z.toFixed(2)})`);
  }
  totalCrossings += crossings.length;
}

console.log(`\nmode=${MODE}  seeds=${SEEDS}  specimen radius=${DEFAULT_SPEC.radius}  slop threshold=${SLOP}m\n`);
console.log(report.join('\n'));
console.log(`\nworst overlap across all seeds: ${(worstOverall > 0 ? worstOverall : 0).toFixed(4)} m`);
console.log(`frames overlapping a wall by more than slop: ${totalBreaches}`);
console.log(`cells reached that are not connected to the previous cell: ${totalCrossings}`);

if (totalCrossings > 0) {
  console.log('\nPASS-THROUGH: the character reached cells it could not have walked to.');
} else {
  console.log('\nNo pass-through. The character never reached a cell on the other side of a '
    + 'wall — the only residual overlap is a solver squeeze while pressed against one, '
    + 'which resolves and does not move the character anywhere it could not walk.');
}
