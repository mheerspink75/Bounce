// Verifies the zero-backend path: the page served as static files, with no proxy
// running and no model anywhere, drives the whole loop unaided.
//
//   npm run serve
//   node scripts/demo-mode-check.mjs
//
// This is the check that backs the hosted demo link. If the deployed page is
// going to be the first thing a stranger sees, "it renders" is not the bar —
// a maze should actually be solved, because that is the thing being demonstrated.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BUDGET_S = Number(process.env.DEMO_BUDGET_S ?? 60);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// Deliberately no ?proxy=, and no proxy is running. If anything still reaches a
// backend, this test is not testing what it claims to.
// Spelled out rather than `window.bounce?.status?.provider !== '—'`: with
// optional chaining a page that never booted evaluates to `undefined !== '—'`,
// which is true, so the wait returns instantly and every assertion after it
// runs against nothing. A skip that looks like a pass is worse than a failure.
await page.goto('http://localhost:8080/?demo=1', { waitUntil: 'load' });
await page.waitForFunction(
  () => Boolean(window.bounce) && window.bounce.status.provider !== '—',
  null,
  { timeout: 30_000 },
);

const provider = await page.evaluate(() => window.bounce.status.provider);
console.log(`provider reported by the page: ${provider}`);

await page.evaluate(() => window.bounce.askForCharacter());
await page.waitForFunction(() => window.bounce.status.state !== 'loading', null, { timeout: 30_000 });
const spec = await page.evaluate(() => window.bounce.sim.character.spec);
console.log(`character: ${JSON.stringify(spec)}`);

// Watch for a reward. Nothing steers this run but the demo brain.
let reward = null;
const deadline = Date.now() + BUDGET_S * 1000;
while (Date.now() < deadline && !reward) {
  await page.waitForTimeout(500);
  reward = await page.evaluate(() => window.bounce.events.find((e) => e.kind === 'reward') ?? null);
}

if (reward) {
  console.log(`\nREWARD  maze ${reward.maze}, path ${reward.path} cells, at t=${reward.t.toFixed(1)}s simulated`);
} else {
  console.log(`\nno reward within ${BUDGET_S}s`);
}

await page.screenshot({ path: '../docs/demo-mode.png' });
console.log('errors:', errors.length ? errors.slice(0, 2).join(' | ') : 'none');

const ok = provider === 'demo' && Boolean(spec?.name) && Boolean(reward) && errors.length === 0;
console.log(`\n${ok ? 'PASS' : 'FAIL'}  static-only demo drives the loop (provider=${provider}, reward=${Boolean(reward)})`);

await browser.close();
process.exit(ok ? 0 : 1);
