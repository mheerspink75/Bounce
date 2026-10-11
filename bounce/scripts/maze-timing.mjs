// How long does the maze take in *simulated* time, with no rendering at all?
//
// The browser number is inflated by software rendering, so this is the honest
// figure: how long the route actually is.
import { createWorld, FIXED_TIMESTEP } from '../public/physics.js';
import { createBrain } from '../public/brain.js';
import { DEFAULT_SPEC } from '../public/spec.js';

const SEEDS = 6;
const times = [];
const paths = [];

for (let seed = 1; seed <= SEEDS; seed += 1) {
  const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: seed });
  const brain = createBrain({
    sim,
    ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
    now: () => 0,
  });

  let t = 0;
  for (let i = 0; i < 60 * 120 && !sim.reached; i += 1) {
    brain.update(FIXED_TIMESTEP);
    sim.advance(FIXED_TIMESTEP);
    t += FIXED_TIMESTEP;
    if (i % 60 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  if (sim.reached) { times.push(t); paths.push(sim.reward.pathLength); }
}

times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
console.log(`simulated seconds to reach the reward (${SEEDS} seeds, no rendering)`);
console.log(`  solved  ${times.length}/${SEEDS}`);
console.log(`  min     ${times[0].toFixed(1)}s`);
console.log(`  median  ${median.toFixed(1)}s`);
console.log(`  max     ${times.at(-1).toFixed(1)}s`);
console.log(`  path    ${Math.min(...paths)}-${Math.max(...paths)} cells`);
