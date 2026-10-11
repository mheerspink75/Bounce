// The full loop, driven by the model, with no manual steering at all.
//
//   model picks an intent -> character walks -> reward -> new maze, new goal,
//   new character -> repeat
//
// Uses the mock provider so it is free and deterministic. The mock plays the
// game (it heads for the goal when it is told about one), which is what makes
// the no-key experience demonstrate the whole thing rather than a character
// meandering until someone intervenes.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const GENERATIONS = Number(process.argv[2] ?? 3);

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 720 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));

await p.goto('http://localhost:8080/?seed=1', { waitUntil: 'load' });
await p.waitForFunction(() => window.__bounce?.ready === true, null, { timeout: 30000 });

console.log(`maze: ${await p.evaluate(() => {
  const m = window.bounce.sim.maze;
  return `${m.dims}x${m.dims} seed ${m.seed}, generation ${window.bounce.sim.generation}`;
})}`);

// Deliberately do NOT post a manual intent. Nothing but the model steers.
const seen = [];
let lastGen = 0;
const deadline = Date.now() + Number(process.env.LOOP_DEADLINE_MS ?? 240_000);  // overridable: a reasoning model needs minutes, not 4

while (Date.now() < deadline) {
  await p.waitForTimeout(1000);
  const s = await p.evaluate(() => ({
    gen: window.bounce.sim.generation,
    seed: window.bounce.sim.maze?.seed,
    intent: window.bounce.stats.lastIntent,
    source: window.bounce.status.source,
    state: window.bounce.status.state,
  }));

  if (s.gen !== lastGen) {
    lastGen = s.gen;
    seen.push(s);
    console.log(`  generation ${s.gen}: seed ${s.seed}, intent ${s.intent?.action}->${s.intent?.target ?? '-'}, character "${s.source}" (${s.state})`);
    if (s.gen >= GENERATIONS) break;
  }
}

const final = await p.evaluate(() => ({
  gen: window.bounce.sim.generation,
  seed: window.bounce.sim.maze?.seed,
  url: location.search,
  events: window.bounce.events.filter((e) => ['reward', 'advance', 'applySpec'].includes(e.kind)),
}));

console.log(`\ncompleted ${final.gen} maze(s); now on seed ${final.seed} (url "${final.url}")`);
console.log('\nevent timeline:');
for (const e of final.events) {
  if (e.kind === 'reward') console.log(`  t=${String(e.t).padStart(7)}  REWARD  maze ${e.maze}, path ${e.path} cells`);
  if (e.kind === 'advance') console.log(`  t=${String(e.t).padStart(7)}  ADVANCE seed ${e.seed} ${e.maze} (previous: ${e.finished})`);
  if (e.kind === 'applySpec') console.log(`  t=${String(e.t).padStart(7)}  NEW CHARACTER  ${e.name} r=${e.radius}`);
}

const ok = final.gen >= GENERATIONS && errs.length === 0;
console.log(`\n${ok ? 'PASS' : 'FAIL'}  the model drove ${final.gen} maze(s) to completion unaided`);
console.log('errors:', errs.length ? errs.slice(0, 2).join(' | ') : 'none');

await p.screenshot({ path: '../docs/step9-loop.png' });
await b.close();
process.exit(ok ? 0 : 1);
