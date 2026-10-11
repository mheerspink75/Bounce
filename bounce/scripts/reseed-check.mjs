// R must produce a *different* maze, not silently redraw the same one.
//
// Worth a test of its own: the first version incremented a variable and then
// reloaded, which discarded the increment, so R looked like it worked (the page
// reloaded) while redrawing an identical maze.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 900, height: 650 } });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));

await p.goto('http://localhost:8080/?seed=1', { waitUntil: 'load' });
await p.waitForFunction(() => window.__bounce?.ready === true, null, { timeout: 30000 });

// A seed, a wall count and a goal are not enough to tell two mazes apart: a
// perfect 5x5 maze always has the same number of walls, and the goal is always
// an open corner, so both are identical across seeds. Compare the layout.
const snapshot = () => p.evaluate(() => {
  const m = window.bounce.sim.maze;
  return {
    seed: m.seed,
    walls: [...m.edges].sort().join(','),
    goal: window.bounce.sim.goal,
    start: window.bounce.sim.start,
    url: location.search,
  };
});

const before = await snapshot();

await p.keyboard.press('KeyR');
await p.waitForFunction(() => window.__bounce?.ready === true, null, { timeout: 30000 });

const after = await snapshot();
const identical = before.seed === after.seed && before.walls === after.walls;

console.log(`before  seed ${before.seed}  ${before.walls.split(',').length} internal walls`);
console.log(`after   seed ${after.seed}  ${after.walls.split(',').length} internal walls  url "${after.url}"`);
console.log(`goal    (${before.goal.x}, ${before.goal.z}) -> (${after.goal.x}, ${after.goal.z})`);
console.log(`start   (${before.start.x}, ${before.start.z}) -> (${after.start.x}, ${after.start.z})`);
console.log(identical ? 'FAIL  R redrew the same maze' : 'PASS  R produced a different maze');
console.log('errors:', errs.length ? errs.slice(0, 2).join(' | ') : 'none');

await p.screenshot({ path: '../docs/step8-maze-new-seed.png' });
await b.close();
process.exit(identical || errs.length ? 1 : 0);
