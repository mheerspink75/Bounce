// One-off end-to-end check against the REAL provider (not the mock).
// Browser -> proxy -> NVIDIA NIM -> intent -> forces -> movement.
// Run: node --env-file=.env scripts/live-browser-check.mjs
import { createRequire } from 'node:module';
import { createProxy } from '../server/index.js';
const require = createRequire(import.meta.url);

const { chromium } = require('playwright');
if (!process.env.NIM_API_KEY) {
  console.error('no NIM_API_KEY — run: node --env-file=.env scripts/live-browser-check.mjs');
  process.exit(1);
}

const proxy = createProxy();            // no provider override -> reads .env, real model
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
console.log(`proxy up on ${proxyUrl} using the real provider`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://localhost:8080/?proxy=${encodeURIComponent(proxyUrl)}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.bounce?.status?.provider !== '—', null, { timeout: 30_000 });
console.log('provider reported by page:', await page.evaluate(() => window.bounce.status.provider));

console.log('\nrequesting a live character…');
const t0 = Date.now();
await page.evaluate(() => window.bounce.askForCharacter());
await page.waitForFunction(() => window.bounce.status.state !== 'loading', null, { timeout: 180_000 });
console.log(`character arrived in ${((Date.now() - t0) / 1000).toFixed(1)}s, state=`,
  await page.evaluate(() => window.bounce.status.state));
console.log('spec:', JSON.stringify(await page.evaluate(() => window.bounce.sim.character.spec)));
console.log('source:', await page.evaluate(() => window.bounce.status.source));

console.log('\nletting the live brain steer for 20s…');
const moved = await page.evaluate(async () => {
  const body = window.bounce.sim.character.body;
  const a = body.translation();
  await new Promise((r) => setTimeout(r, 45_000));
  const b = body.translation();
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
});
const brain = await page.evaluate(() => ({ ...window.bounce.brain.state, intent: window.bounce.brain.intent }));
console.log(`travelled ${moved.toFixed(2)}m`);
console.log('brain:', JSON.stringify(brain));

const pos = await page.evaluate(() => window.bounce.sim.character.body.translation());
console.log('position:', `x=${pos.x.toFixed(2)} y=${pos.y.toFixed(2)} z=${pos.z.toFixed(2)}`);
console.log('in arena:', Math.abs(pos.x) < 9 && Math.abs(pos.z) < 9 && pos.y > -0.5);

await page.screenshot({ path: '../docs/step5-live-model.png' });
console.log('screenshot -> docs/step5-live-model.png');
console.log('uncaught page errors:', errors.length === 0 ? 'none' : errors.slice(0, 3).join(' | '));

await browser.close();
await new Promise((r) => proxy.close(r));
