// Demonstrates an agent steering the character: pushes an intent to the proxy's
// manual channel, then checks the live page actually follows it.
//
//   node scripts/agent-steer-check.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PROXY = process.env.PROXY ?? 'http://127.0.0.1:8787';
const PAGE = process.env.PAGE ?? 'http://localhost:8080/';

// The target we are going to steer toward, and where it is in the world.
const TARGET_ID = 'block_b';
const TARGET_POS = { x: 3, z: 2 };

const push = (body) => fetch(`${PROXY}/api/intent/manual`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const clear = () => fetch(`${PROXY}/api/intent/manual`, { method: 'DELETE' });

await clear();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`${PAGE}?proxy=${encodeURIComponent(PROXY)}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__bounce?.ready === true, null, { timeout: 30_000 });
await page.waitForTimeout(1500);

const before = await page.evaluate(() => ({ ...window.bounce.sim.character.body.translation() }));
const beforeIntent = await page.evaluate(() => window.bounce.brain.intent.action);
console.log(`before:  action=${beforeIntent}  pos=(${before.x.toFixed(2)}, ${before.z.toFixed(2)})`);

console.log(`\nagent pushes: charge_target -> ${TARGET_ID}, intensity 1.0`);
// Long TTL so the override cannot expire mid-assertion. The earlier version used
// 25s and raced the snapshot.
await push({ action: 'charge_target', target: TARGET_ID, intensity: 1, duration_s: 10, ttl_s: 120 });

// The brain polls every ~2s. No .catch() swallow here — a version that silently
// continued on timeout could report a misleading result.
let matched = true;
try {
  await page.waitForFunction(
    (id) => window.bounce.brain.intent.action === 'charge_target'
      && window.bounce.brain.intent.target === id,
    TARGET_ID,
    { timeout: 25_000 },
  );
} catch {
  matched = false;
}

const afterIntent = await page.evaluate(() => ({ ...window.bounce.brain.intent }));
const source = await page.evaluate(() => window.bounce.brain.state.status);
console.log(`after:   action=${afterIntent.action} target=${afterIntent.target} intensity=${afterIntent.intensity} (brain ${source})`);

console.log(`\n${matched ? 'PASS' : 'FAIL'}  the live page picked up the agent's intent, not the model's`);

// Now confirm the character actually moves toward the commanded target.
const travel = await page.evaluate(async ({ x: tx, z: tz }) => {
  const body = window.bounce.sim.character.body;
  const a = body.translation();
  const d0 = Math.hypot(a.x - tx, a.z - tz);
  await new Promise((r) => setTimeout(r, 6000));
  const b = body.translation();
  return { from: { x: a.x, z: a.z }, to: { x: b.x, z: b.z }, d0, d1: Math.hypot(b.x - tx, b.z - tz) };
}, TARGET_POS);

const closed = travel.d0 - travel.d1;
console.log(`distance to ${TARGET_ID}: ${travel.d0.toFixed(2)}m -> ${travel.d1.toFixed(2)}m  (closed ${closed.toFixed(2)}m)`);
console.log(`${closed > 0.05 ? 'PASS' : 'FAIL'}  the character moved toward the commanded target`);

await page.screenshot({ path: '../docs/step7-agent-steering.png' });
console.log('\nscreenshot -> docs/step7-agent-steering.png');
console.log('uncaught errors:', errors.length === 0 ? 'none' : errors.slice(0, 2).join(' | '));

await clear();
console.log('override cleared');
await browser.close();
