/**
 * Reaching the goal must not be a coincidence.
 *
 * Reported as "sometimes it gets stuck right before reaching the goal, it's almost
 * like there's an invisible wall". There was no wall: the ball was inside the goal
 * cell, beside the marker, with the reward never firing, so the run never advanced.
 *
 * The trigger was "within `radius + 0.5` of the goal marker". Measured over 16
 * seeds at three radii, the margin between the ball's closest approach and that
 * radius was **4mm to 46mm** — and on one seed exactly **0.000m**, firing on the
 * boundary. A test that passes by 4mm is a coincidence that has not failed yet.
 * Any perturbation flips it: a different intent from the model, one different
 * bounce, the character being resized, one more substep.
 *
 * The maze already defines what "arrived" means — it has a goal *cell*. That is
 * the semantically correct question and a far more robust one: a 3.16m box
 * instead of a 1.0m circle, so the ball is caught up to 2.23m from the marker if
 * it stops at the cell entrance, while staying bounded so it cannot fire from
 * across the maze.
 *
 * The subtle part is that `toCell` *clamps* to the grid. A ball sitting outside
 * the perimeter is therefore reported as being in the nearest edge cell, and when
 * the goal is a corner cell that would fire the reward from outside the maze.
 * That is why the bounds test is here and is asserted below rather than assumed.
 *
 *   node test/goal-arrival.test.mjs
 */
import { createWorld, FIXED_TIMESTEP } from '../public/physics.js';
import { sanitizeSpec, DEFAULT_SPEC } from '../public/spec.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const SPEC = sanitizeSpec({ ...DEFAULT_SPEC, radius: 0.5 });

/** Drop the character at a world position, at rest, and let one frame evaluate. */
async function arriveAt(x, z, seed = 22) {
  const sim = await createWorld({ spec: SPEC, mazeSeed: seed });
  sim.character.body.setTranslation({ x, y: SPEC.radius, z }, true);
  sim.character.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  sim.advance(FIXED_TIMESTEP);
  await settle();
  const g = sim.maze.toWorld(sim.maze.goalCell);
  return { reached: sim.reached, via: sim.reward?.via ?? null, dist: Math.hypot(x - g.x, z - g.z) };
}

console.log('\ngoal arrival: reaching the goal is not a coincidence\n');

// --- the whole point: inside the cell but far from the marker ---------------
{
  const sim = await createWorld({ spec: SPEC, mazeSeed: 22 });
  const m = sim.maze;
  const g = m.toWorld(m.goalCell);
  const [gx, gz] = m.goalCell;
  const pitch = m.pitch;

  // The cell entrance corner: inside the goal cell, and the furthest point in it
  // from the marker. This is the case the old trigger could not see.
  const entrance = {
    x: m.origin + gx * pitch + 0.05,
    z: m.origin + gz * pitch + 0.05,
  };
  const r = await arriveAt(entrance.x, entrance.z, 22);
  check('arriving anywhere in the goal cell counts, not just at the marker',
    r.reached === true, `reached=${r.reached} via=${r.via} at ${r.dist.toFixed(2)}m from the marker`);
  check('the old trigger alone would have missed that spot',
    r.dist > SPEC.radius + 0.5,
    `${r.dist.toFixed(2)}m > old trigger ${(SPEC.radius + 0.5).toFixed(2)}m`);
  check('it reports arriving via the cell, not the radius',
    r.via === 'cell', `via=${r.via}`);
  void g;
}

// --- the cell before the goal must NOT count -------------------------------
{
  const sim = await createWorld({ spec: SPEC, mazeSeed: 22 });
  const m = sim.maze;
  const [gx, gz] = m.goalCell;
  // A neighbouring open cell, as far from the marker as that cell allows.
  let best = null;
  for (const [dx, dz] of [[-1, 0], [0, -1], [-1, -1], [1, 0], [0, 1]]) {
    const cell = [gx + dx, gz + dz];
    if (cell[0] < 0 || cell[1] < 0 || cell[0] >= m.dims || cell[1] >= m.dims) continue;
    if (!m.isOpen(cell)) continue;
    const w = m.toWorld(cell);
    const d = Math.hypot(w.x - m.toWorld(m.goalCell).x, w.z - m.toWorld(m.goalCell).z);
    if (!best || d < best.d) best = { cell, w, d };
  }
  const r = await arriveAt(best.w.x, best.w.z, 22);
  check('standing in the cell before the goal does NOT count as arriving',
    r.reached === false, `cell ${best.cell} at ${r.dist.toFixed(2)}m, reached=${r.reached}`);
}

// --- outside the perimeter must NOT count, despite toCell clamping ---------
{
  const sim = await createWorld({ spec: SPEC, mazeSeed: 22 });
  const m = sim.maze;
  const g = m.toWorld(m.goalCell);
  // Just outside the perimeter, on the far side of the goal corner. `toCell`
  // clamps this to the goal cell, which is exactly the trap.
  const outside = {
    x: Math.sign(g.x) * (m.halfExtent + 0.4),
    z: Math.sign(g.z) * (m.halfExtent + 0.4),
  };
  const clamped = m.toCell(outside.x, outside.z);
  check('the clamp really does report that spot as the goal cell',
    clamped[0] === m.goalCell[0] && clamped[1] === m.goalCell[1],
    `toCell -> ${clamped.join(',')} (goal ${m.goalCell.join(',')})`);
  const r = await arriveAt(outside.x, outside.z, 22);
  check('but arriving outside the maze does NOT count',
    r.reached === false, `reached=${r.reached} at ${r.dist.toFixed(2)}m from the marker`);
}

// --- the radius test still works on its own --------------------------------
{
  // Dead centre on the marker, but force the cell test to be irrelevant by
  // checking the union: a ball right at the marker must always count.
  const sim = await createWorld({ spec: SPEC, mazeSeed: 22 });
  const g = sim.maze.toWorld(sim.maze.goalCell);
  const r = await arriveAt(g.x, g.z, 22);
  check('sitting on the marker counts', r.reached === true, `via=${r.via}`);
}

// --- and the maze is still solved, with room to spare ----------------------
{
  let solved = 0;
  let worstMargin = Infinity;
  const seeds = [1, 4, 5, 11, 17, 22, 23, 29];
  for (const seed of seeds) {
    const sim = await createWorld({ spec: SPEC, mazeSeed: seed });
    let t = 0;
    const clock = { now: () => t * 1000 };
    const { createBrain } = await import('../public/brain.js');
    const brain = createBrain({
      sim,
      ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 0.8, duration_s: 3 }),
      now: clock.now,
    });
    const g = sim.maze.toWorld(sim.maze.goalCell);
    let minD = Infinity;
    for (let i = 0; i < 60 * 45 && !sim.reached; i += 1) {
      t += FIXED_TIMESTEP;
      brain.update(FIXED_TIMESTEP);
      sim.advance(FIXED_TIMESTEP);
      if (i % 30 === 0) await settle();
      const p = sim.character.body.translation();
      minD = Math.min(minD, Math.hypot(p.x - g.x, p.z - g.z));
    }
    if (sim.reached) solved += 1;
    // How far inside the trigger it fired: negative means the cell test caught it
    // earlier than the old radius ever would have.
    worstMargin = Math.min(worstMargin, (SPEC.radius + 0.5) - minD);
  }
  check('every seed still solves the maze', solved === seeds.length, `${solved}/${seeds.length}`);
  check('the trigger now fires with a wide margin, not a 4mm one',
    worstMargin < -0.3,
    `worst margin ${worstMargin.toFixed(3)}m (was +0.000 to +0.046m)`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
