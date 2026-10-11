// Drives the real page through the maze and screenshots arrival at the reward.
//
// Also reports the sim-time vs wall-clock gap, because that ratio is the honest
// measure of whether the simulation is keeping up on this hardware. The maze
// takes ~8s of simulated time; if the wall clock says 25s, the simulation is
// running slow and every other timing in the project is wrong.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 720 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));

await p.goto('http://localhost:8080/?seed=1', { waitUntil: 'load' });
await p.waitForFunction(() => window.__bounce?.ready === true, null, { timeout: 30000 });

console.log('maze:  ', await p.evaluate(() => {
  const m = window.bounce.sim.maze;
  return `${m.dims}x${m.dims} seed ${m.seed}, ${m.edges.size} internal walls`;
}));
console.log('goal:  ', await p.evaluate(() => JSON.stringify(window.bounce.sim.goal)));
await p.screenshot({ path: '../docs/step8-maze-start.png' });

// Push the agent at the goal, then watch it walk there.
await fetch('http://127.0.0.1:8787/api/intent/manual', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'charge_target', target: 'goal', intensity: 1, ttl_s: 180 }),
});

const startedAt = Date.now();
let reached = false;
const samples = [];

for (let i = 0; i < 90; i += 1) {
  await p.waitForTimeout(500);
  const s = await p.evaluate(() => ({
    reached: window.bounce.sim.reached,
    fps: window.bounce.stats.fps,
    substeps: window.bounce.stats.substeps,
    simTime: window.bounce.sim.simTime,
    intent: window.bounce.stats.lastIntent?.action ?? null,
  }));
  samples.push(s);
  if (s.reached) { reached = true; break; }
}

const wall = (Date.now() - startedAt) / 1000;
const last = samples.at(-1);
const fps = samples.slice(1).map((s) => s.fps).filter((v) => v > 0);
const medianFps = fps.sort((a, b) => a - b)[Math.floor(fps.length / 2)] ?? 0;
const ratio = last.simTime / wall;

console.log(`\nREWARD after ${wall.toFixed(1)}s wall clock`);
console.log(`  simulated time elapsed: ${last.simTime.toFixed(1)}s  -> sim/wall = ${(ratio * 100).toFixed(0)}%`);
console.log(`  median fps while walking: ${medianFps.toFixed(1)}  (substeps/frame ${last.substeps})`);
console.log(`  headless equivalent: ~8.1s simulated (scripts/maze-timing.mjs)`);
console.log(`  intent at arrival: ${last.intent}`);

// The two failure modes look identical in a screenshot. Separate them.
if (ratio < 0.9) {
  console.log('  -> simulation is running SLOW: fewer sim seconds than wall seconds.');
  console.log('     Frame rate or the substep cap is limiting; character behaviour is not the cause.');
} else {
  const overhead = last.simTime - 8.1;
  console.log(`  -> simulation is in REAL TIME. The character took ${overhead.toFixed(1)}s of`);
  console.log('     simulated time beyond the headless figure, so this is behaviour, not speed.');
}

const pos = await p.evaluate(() => window.bounce.sim.character.body.translation());
console.log(`  final position: (${pos.x.toFixed(2)}, ${pos.z.toFixed(2)})`);
console.log('  reward:', await p.evaluate(() => JSON.stringify(window.bounce.sim.reward)));

// The timeline is the diagnosis. "4x slower than headless" has several possible
// causes and a screenshot cannot separate them.
console.log('\n  event timeline (sim seconds):');
const events = await p.evaluate(() => window.bounce.events);
for (const e of events) {
  if (e.kind === 'intent') console.log(`    t=${String(e.t).padStart(6)}  intent  ${e.action}${e.target ? ` -> ${e.target}` : ''}`);
  else if (e.kind === 'override') console.log(`    t=${String(e.t).padStart(6)}  OVERRIDE  ${e.action}`);
  else if (e.kind === 'applySpec') console.log(`    t=${String(e.t).padStart(6)}  SPEC    ${e.name} r=${e.radius} mazeRebuilt=${e.mazeRebuilt}`);
  else if (e.kind === 'reward') console.log(`    t=${String(e.t).padStart(6)}  REWARD  maze ${e.maze}, path ${e.path}`);
}
const specs = events.filter((e) => e.kind === 'applySpec').length;
console.log(`  ${specs} character spec(s) applied, ${events.filter((e) => e.kind === 'reward').length} reward(s)`);

console.log('  errors:', errs.length ? errs.slice(0, 2).join(' | ') : 'none');

await p.screenshot({ path: '../docs/step8-maze-reward.png' });
await fetch('http://127.0.0.1:8787/api/intent/manual', { method: 'DELETE' });
await b.close();
process.exit(reached && errs.length === 0 ? 0 : 1);
