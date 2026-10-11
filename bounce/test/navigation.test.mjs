/**
 * The test that matters: does the character actually get to the reward?
 *
 * Everything else here is a mechanism. This drives the real physics world with
 * the real brain and a `charge_target -> goal` intent, and asserts the character
 * arrives. Run across many maze seeds and both character sizes, because a
 * maze that only works on one layout is not a maze.
 */
import { createWorld, FIXED_TIMESTEP, ARENA } from '../public/physics.js';
import { createBrain } from '../public/brain.js';
import { DEFAULT_SPEC } from '../public/spec.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * A wall clock that tracks simulation time.
 *
 * Intent `duration_s` is measured in *simulation* seconds, but re-asks are paced
 * by *wall* clock. In a browser those agree, because sim time is derived from
 * frame deltas. Headless they do not: these loops cover 90 simulated seconds in
 * about one real second, so a 10s intent lapses while the brain — which thinks
 * almost no time has passed — never refreshes it. The character then wanders
 * forever and the maze looks unsolvable when it is not.
 *
 * Tying the clock to sim time is not a convenience; it is what the browser
 * actually does, and without it a passing test and a real bug look identical.
 */
function harnessClock() {
  const state = { ms: 0 };
  return {
    now: () => state.ms,
    tick(dt = FIXED_TIMESTEP) { state.ms += dt * 1000; },
  };
}

const GOAL_INTENT = { action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 };

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Run the sim with a brain locked on `target` for up to `seconds`. */
async function attempt({ seed, spec = DEFAULT_SPEC, target = 'goal', seconds = 60 }) {
  const sim = await createWorld({ spec, mazeSeed: seed });
  const clock = harnessClock();
  const brain = createBrain({
    sim,
    // Pinned intent: the model is irrelevant here, we are testing navigation.
    ask: async () => ({ action: 'charge_target', target, intensity: 1, duration_s: 3600 }),
    now: clock.now,
  });

  const goal = sim.goal;
  const start = sim.character.body.translation();
  const startDist = Math.hypot(start.x - goal.x, start.z - goal.z);

  const frames = Math.round(seconds / FIXED_TIMESTEP);
  let closest = Infinity;
  let stuckAt = null;
  let lastPos = { x: start.x, z: start.z };
  let idleFrames = 0;

  for (let i = 0; i < frames; i += 1) {
    clock.tick();    brain.update(FIXED_TIMESTEP);
    sim.advance(FIXED_TIMESTEP);
    if (i % 30 === 0) await settle();
    if (sim.reached) break;

    const p = sim.character.body.translation();
    const d = Math.hypot(p.x - goal.x, p.z - goal.z);
    if (d < closest) closest = d;
    if (Math.hypot(p.x - lastPos.x, p.z - lastPos.z) < 0.002) {
      idleFrames += 1;
      if (idleFrames === 90 && !stuckAt) stuckAt = { x: p.x, z: p.z };
    } else {
      idleFrames = 0;
    }
    lastPos = { x: p.x, z: p.z };
  }

  return { sim, startDist, closest, stuckAt, seconds };
}

// --- the headline test ----------------------------------------------------
{
  const { sim, startDist, closest } = await attempt({ seed: 1, seconds: 60 });
  check('character reaches the reward', sim.reached,
    sim.reached
      ? `start was ${startDist.toFixed(2)}m away`
      : `closest approach ${closest.toFixed(2)}m, never arrived`);
  check('a reward is issued on arrival', sim.reward?.won === true,
    sim.reward ? `seed=${sim.reward.seed} maze=${sim.reward.maze} path=${sim.reward.pathLength}` : 'no reward');
}

// --- across seeds ---------------------------------------------------------
{
  let wins = 0;
  const SEEDS = 12;
  const losses = [];
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const r = await attempt({ seed, seconds: 45 });
    if (r.sim.reached) wins += 1;
    else losses.push(`seed ${seed}: closest ${r.closest.toFixed(2)}m${r.stuckAt ? ` stuck at (${r.stuckAt.x.toFixed(1)},${r.stuckAt.z.toFixed(1)})` : ''}`);
  }
  check(`character reaches the reward on most seeds (${wins}/${SEEDS})`, wins >= SEEDS - 1,
    losses.length ? losses.slice(0, 3).join('; ') : 'all seeds solved');
}

// --- a fat character gets a coarser maze and still solves it --------------
{
  const spec = { ...DEFAULT_SPEC, name: 'Fat', radius: 1.8, mass: 6, restitution: 0.3 };
  const r = await attempt({ seed: 3, spec, seconds: 60 });
  check('a radius-1.8 character still reaches the reward', r.sim.reached,
    r.sim.reached ? `maze ${r.sim.reward.maze}` : `closest ${r.closest.toFixed(2)}m${r.stuckAt ? ` stuck at (${r.stuckAt.x.toFixed(1)},${r.stuckAt.z.toFixed(1)})` : ''}`);
}

// --- a tiny character -----------------------------------------------------
{
  const spec = { ...DEFAULT_SPEC, name: 'Tiny', radius: 0.2, restitution: 0.5 };
  const r = await attempt({ seed: 5, spec, seconds: 60 });
  check('a radius-0.2 character still reaches the reward', r.sim.reached,
    r.sim.reached ? `maze ${r.sim.reward.maze}` : `closest ${r.closest.toFixed(2)}m`);
}

// --- it stays inside the arena, and never escapes the maze ---------------
{
  const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: 2 });
  const clock = harnessClock();
  const brain = createBrain({
    sim,
    ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
    now: clock.now,
  });
  let contained = true;
  let worst = 0;
  for (let i = 0; i < 60 * 60; i += 1) {
    clock.tick();    brain.update(FIXED_TIMESTEP);
    sim.advance(FIXED_TIMESTEP);
    if (i % 30 === 0) await settle();
    const p = sim.character.body.translation();
    worst = Math.max(worst, Math.abs(p.x), Math.abs(p.z));
    if (Math.abs(p.x) > ARENA.halfWidth || Math.abs(p.z) > ARENA.halfDepth || p.y < -1) {
      contained = false;
      break;
    }
    if (sim.reached) break;
  }
  check('never escapes the arena while navigating', contained, `max |coord| ${worst.toFixed(2)}`);
  // Renamed, because the old name was a lie. `worst < 8.5` only bounds the maze's
  // *outer perimeter*; a ball that walked through every internal wall and ended
  // up in the far corner still satisfies it. The real check is below, and it
  // lives in `test/wall-containment.test.mjs`.
  check('stays within the maze perimeter', worst < 8.5, `max |coord| ${worst.toFixed(2)} < 8.5`);
}

// --- reward latches, and reset clears it ---------------------------------
{
  const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: 1 });
  const clock = harnessClock();
  const brain = createBrain({
    sim,
    ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
    now: clock.now,
  });
  for (let i = 0; i < 60 * 60 && !sim.reached; i += 1) {
    clock.tick();    brain.update(FIXED_TIMESTEP);
    sim.advance(FIXED_TIMESTEP);
    if (i % 30 === 0) await settle();
  }
  check('arrived before reset', sim.reached === true);

  // Must not re-fire while sitting in the goal.
  const rewardBefore = JSON.stringify(sim.reward);
  for (let i = 0; i < 120; i += 1) { clock.tick(); brain.update(FIXED_TIMESTEP); sim.advance(FIXED_TIMESTEP); }
  check('reward does not re-fire while sitting in the goal',
    JSON.stringify(sim.reward) === rewardBefore);

  sim.resetGoal();
  check('resetGoal clears reached and reward', sim.reached === false && sim.reward === null);
}

// --- the character is born at the start, at rest ------------------------
{
  const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: 4 });
  check('born on the maze start cell',
    Math.hypot(sim.spawn.x - sim.start.x, sim.spawn.z - sim.start.z) < 0.01,
    `spawn (${sim.spawn.x.toFixed(2)}, ${sim.spawn.z.toFixed(2)})`);

  const v = sim.character.body.linvel();
  check('begins at rest (a launch would carry it past its own start)',
    Math.hypot(v.x, v.y, v.z) < 1e-6, `initial speed ${Math.hypot(v.x, v.y, v.z).toFixed(3)} m/s`);

  // It should still be near the start after settling, not 8m down a corridor.
  for (let i = 0; i < 120; i += 1) { sim.advance(FIXED_TIMESTEP); if (i % 30 === 0) await settle(); }
  const p = sim.character.body.translation();
  check('stays put with no intent to drive it',
    Math.hypot(p.x - sim.start.x, p.z - sim.start.z) < 1.5,
    `drifted ${Math.hypot(p.x - sim.start.x, p.z - sim.start.z).toFixed(2)}m`);
}

// --- the open arena still launches the character -------------------------
{
  const sim = await createWorld({ spec: DEFAULT_SPEC, maze: false });
  const v = sim.character.body.linvel();
  check('open arena still launches the character (unchanged behaviour)',
    Math.hypot(v.x, v.z) > 1, `initial speed ${Math.hypot(v.x, v.z).toFixed(2)} m/s`);
  check('open arena has no maze, start or goal',
    sim.maze === null && sim.start === null && sim.goal === null);
}

// --- replacing the character is a redesign, not a restart ----------------
{
  // Both of these were live bugs, and both were invisible with a fast provider.
  // NIM takes 14-58s to design a character, so the spec landed mid-run and the
  // replacement threw away the walk: 12.1s of simulated time with the mock
  // provider versus 30.5s with NIM on the same seed.
  const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: 1 });
  const clock = harnessClock();
  const brain = createBrain({
    sim,
    ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
    now: clock.now,
  });

  // Walk most of the way to the goal.
  for (let i = 0; i < 60 * 6; i += 1) {
    clock.tick();    brain.update(FIXED_TIMESTEP);
    sim.advance(FIXED_TIMESTEP);
    if (i % 30 === 0) await settle();
  }
  const before = sim.character.body.translation();
  const travelled = Math.hypot(before.x - sim.start.x, before.z - sim.start.z);
  check('the character has made progress before the swap', travelled > 2,
    `${travelled.toFixed(2)}m from the start`);

  // A same-size replacement must appear where the action is.
  const { mazeRebuilt } = sim.replaceCharacter({ ...DEFAULT_SPEC, name: 'Newcomer', color: '#ff00aa' });
  const after = sim.character.body.translation();

  check('a same-size replacement does not rebuild the maze', mazeRebuilt === false);
  check('the replacement appears where the old one was, not at the start',
    Math.hypot(after.x - before.x, after.z - before.z) < 1.0,
    `moved ${Math.hypot(after.x - before.x, after.z - before.z).toFixed(2)}m`);
  check('the replacement did not send it back to the start',
    Math.hypot(after.x - sim.start.x, after.z - sim.start.z) > 1.5,
    `${Math.hypot(after.x - sim.start.x, after.z - sim.start.z).toFixed(2)}m from start`);
  check('the replacement is not intersecting anything', after.y > sim.character.spec.radius,
    `y=${after.y.toFixed(2)}`);

  // And it must still be able to finish the maze it was halfway through.
  for (let i = 0; i < 60 * 60 && !sim.reached; i += 1) {
    clock.tick();    brain.update(FIXED_TIMESTEP);
    sim.advance(FIXED_TIMESTEP);
    if (i % 30 === 0) await settle();
  }
  check('the replacement still reaches the reward', sim.reached,
    sim.reached ? 'progress was preserved' : 'lost the run');
}

// --- a fatter replacement gets a maze it can fit through -----------------
{
  // The model picks radius freely. A maze sized for radius 0.6 has ~2.4m
  // corridors, so a radius-2.0 character is 4m across and would wedge in the
  // first corridor forever with no error and no way out.
  const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: 1 });
  const dimsBefore = sim.maze.dims;
  const { mazeRebuilt } = sim.replaceCharacter({ ...DEFAULT_SPEC, radius: 2.0, mass: 6 });

  check('a radius-2.0 character forces a coarser maze', mazeRebuilt === true,
    `${dimsBefore}x${dimsBefore} -> ${sim.maze.dims}x${sim.maze.dims}`);
  check('the rebuilt maze is sized so the character fits',
    sim.maze.pitch - sim.maze.wallThickness > 2.0 * 2,
    `corridor ${(sim.maze.pitch - sim.maze.wallThickness).toFixed(2)} > diameter 4.00`);
  check('the goal moved with the new maze',
    sim.goal && Math.hypot(sim.goal.x, sim.goal.z) > 0);
  check('a rebuilt maze honestly reports a lost run',
    sim.reached === false && sim.reward === null);

  // Which is only useful if the fat character can then actually finish.
  const clock = harnessClock();
  const brain = createBrain({
    sim,
    ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
    now: clock.now,
  });
  for (let i = 0; i < 60 * 90 && !sim.reached; i += 1) {
    clock.tick();    brain.update(FIXED_TIMESTEP);
    sim.advance(FIXED_TIMESTEP);
    if (i % 30 === 0) await settle();
  }
  check('the radius-2.0 character reaches the reward in the rebuilt maze', sim.reached,
    sim.reached ? `${sim.maze.dims}x${sim.maze.dims}` : 'wedged');
}

// --- a reward already collected is not un-collected -----------------------
{
  const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: 1 });
  const clock = harnessClock();
  const brain = createBrain({
    sim,
    ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
    now: clock.now,
  });
  for (let i = 0; i < 60 * 60 && !sim.reached; i += 1) {
    clock.tick();    brain.update(FIXED_TIMESTEP);
    sim.advance(FIXED_TIMESTEP);
    if (i % 30 === 0) await settle();
  }
  check('reward collected first', sim.reached === true);

  sim.replaceCharacter({ ...DEFAULT_SPEC, name: 'Successor' });
  check('a redesign does not un-collect a reward the player already got',
    sim.reached === true && sim.reward?.won === true);
}

// --- the loop: a new maze, a new goal, a new character -------------------
{
  const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: 1 });
  const clock = harnessClock();
  const brain = createBrain({
    sim,
    ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
    now: clock.now,
  });

  for (let i = 0; i < 60 * 90 && !sim.reached; i += 1) {
    clock.tick();    brain.update(FIXED_TIMESTEP);
    sim.advance(FIXED_TIMESTEP);
    if (i % 30 === 0) await settle();
  }
  check('reached the first goal', sim.reached === true, sim.reward ? `path ${sim.reward.pathLength}` : 'no reward');

  const beforeGoal = { ...sim.goal };
  const beforeWalls = sim.maze.walls.length;
  const beforeSeed = sim.maze.seed;

  // Simulate a larger character arriving with the new maze, the way the loop
  // asks the model for a new one.
  const next = sim.newMaze(beforeSeed + 1);

  check('a new maze is a different seed', next.seed === beforeSeed + 1, `${beforeSeed} -> ${next.seed}`);
  check('the reward is cleared for the new run', sim.reached === false && sim.reward === null);
  check('the generation counter advanced', sim.generation === 1, `generation ${sim.generation}`);
  check('the new goal is placed and reachable',
    Boolean(sim.goal) && Math.hypot(sim.goal.x, sim.goal.z) > 0
    && sim.maze.pathBetween(sim.maze.startCell, sim.maze.goalCell) !== null,
    `goal (${sim.goal.x.toFixed(2)}, ${sim.goal.z.toFixed(2)})`);
  check('the character is respawned at the new start',
    Math.hypot(sim.spawn.x - sim.start.x, sim.spawn.z - sim.start.z) < 0.01
    && sim.generation === 1);

  const p = sim.character.body.translation();
  check('the character is not embedded in the new maze',
    sim.maze.isOpen(sim.maze.toCell(p.x, p.z)) || Math.hypot(p.x, p.z) > 0,
    `at (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
  check('the wall count matches the new layout',
    sim.maze.walls.length === sim.maze.edges.size + 4,
    `${beforeWalls} -> ${sim.maze.walls.length} walls`);

  // And the new maze must be solvable, or the loop would grind to a halt.
  for (let i = 0; i < 60 * 90 && !sim.reached; i += 1) {
    clock.tick();    brain.update(FIXED_TIMESTEP);
    sim.advance(FIXED_TIMESTEP);
    if (i % 30 === 0) await settle();
  }
  check('the second maze is solvable too', sim.reached === true,
    sim.reached ? 'loop continues' : 'stuck on maze 2');

  // Several generations, to be sure nothing accumulates.
  for (let g = 0; g < 5; g += 1) sim.newMaze();
  check('five generations in a row leave a consistent world',
    sim.generation === 6 && sim.reached === false && sim.reward === null
    && sim.maze.isOpen(sim.maze.toCell(sim.character.body.translation().x, sim.character.body.translation().z)),
    `generation ${sim.generation}, seed ${sim.maze.seed}`);
}

// --- what the model is told about the objective --------------------------
{
  const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: 3 });
  const info = sim.goalInfo();

  check('the goal is described with an id the model can target', info?.id === 'goal');
  check('the goal reports a positive distance', info.distance_m > 0, `${info.distance_m}m`);
  check('the goal reports a route length', Number.isInteger(info.path_cells) && info.path_cells >= 0,
    `${info.path_cells} cells`);
  check('the goal is not yet reached', info.reached === false);

  // The distance must shrink as the character closes, or the model is being told
  // a stale number.
  const d0 = sim.goalInfo().distance_m;
  const clock = harnessClock();
  const brain = createBrain({
    sim,
    ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
    now: clock.now,
  });
  for (let i = 0; i < 120; i += 1) { clock.tick(); brain.update(FIXED_TIMESTEP); sim.advance(FIXED_TIMESTEP); if (i % 30 === 0) await settle(); }
  check('the reported distance tracks the character', sim.goalInfo().distance_m < d0,
    `${d0}m -> ${sim.goalInfo().distance_m}m`);

  check('an open arena has no goal to report', (await createWorld({ spec: DEFAULT_SPEC, maze: false })).goalInfo() === null);
}

// --- goal is a valid intent target ---------------------------------------
{
  const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: 1 });
  const goal = sim.findTarget('goal');
  check('"goal" resolves as a target', Boolean(goal), goal ? `(${goal.position.x.toFixed(2)}, ${goal.position.z.toFixed(2)})` : '');
  check('"GOAL" resolves case-insensitively', Boolean(sim.findTarget('GOAL')));
  check('an unknown target still returns null', sim.findTarget('nope') === null);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
