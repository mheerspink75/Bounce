// How much headroom does the substep cap actually have?
//
// The cap is 5, which means the simulation silently runs slower than real time
// below 12 fps — and this box renders in software at 12-15 fps, so it is right
// on that line. Raising the cap costs CPU, so measure what a physics substep
// actually costs before choosing a number.
import { createWorld, FIXED_TIMESTEP } from '../public/physics.js';
import { createBrain } from '../public/brain.js';
import { DEFAULT_SPEC } from '../public/spec.js';

const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: 1 });
const brain = createBrain({
  sim,
  ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
  now: () => 0,
});

// Warm up so JIT compilation is not counted as physics cost.
for (let i = 0; i < 600; i += 1) { brain.update(FIXED_TIMESTEP); sim.advance(FIXED_TIMESTEP); }

function timeSteps(n) {
  const started = process.hrtime.bigint();
  for (let i = 0; i < n; i += 1) sim.advance(FIXED_TIMESTEP);
  return Number(process.hrtime.bigint() - started) / 1e6;   // ms
}

const REPS = 20000;
const ms = timeSteps(REPS);
const perStep = ms / REPS;

console.log(`world: ${sim.statics.length} static bodies, maze ${sim.maze.dims}x${sim.maze.dims}`);
console.log(`${REPS} single-substep advances took ${ms.toFixed(1)}ms`);
console.log(`  -> ${perStep.toFixed(5)} ms per 1/60s substep`);
console.log(`  -> ${(1000 / perStep).toFixed(0)} substeps/second ceiling`);

console.log('\ncap    max sim time/frame   stays real-time down to');
for (const cap of [5, 8, 10, 12, 15, 20]) {
  const maxAdvance = cap * FIXED_TIMESTEP;
  const floorFps = 1 / maxAdvance;
  const cost = perStep * cap;
  console.log(
    `${String(cap).padStart(3)}    ${maxAdvance.toFixed(3)}s`.padEnd(32)
    + `${floorFps.toFixed(1).padStart(5)} fps`.padEnd(24)
    + `${cost.toFixed(2)}ms/frame (${(1000 / floorFps).toFixed(0)}ms budget)`,
  );
}

// What does a frame actually cost here? The browser renders in software, so
// this is the number the cap has to fit inside.
console.log('\nMeasured browser frame time on this box: 66-83ms (12-15 fps), software raster.');
console.log(`At 5 substeps the cap costs ${(perStep * 5).toFixed(2)}ms of that — `
  + `${((perStep * 5) / 75 * 100).toFixed(1)}% of a frame.`);
