// Full browser -> proxy -> LOCAL model -> movement, with a short steering window
// because a 1.5B model on a 2010 CPU takes ~20-30s per call.
//   node --env-file=.env scripts/local-browser-check.mjs
import { createRequire } from 'node:module';
import { createProxy } from '../server/index.js';
const require = createRequire(import.meta.url);

const { chromium } = require('playwright');

const proxy = createProxy({
  provider: (await import('../server/providers.js')).createProviderFromEnv({
    ...process.env,
    LLM_PROVIDER: 'local',
    LOCAL_MODEL: process.env.LOCAL_MODEL ?? 'qwen2.5-1.5b-q4.gguf',
  }),
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
console.log(`local provider on ${proxyUrl}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://localhost:8080/?proxy=${encodeURIComponent(proxyUrl)}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.bounce?.status?.provider !== '—', null, { timeout: 30_000 });
console.log('provider seen by page:', await page.evaluate(() => window.bounce.status.provider));

console.log('\nasking the local model for a character…');
const t0 = Date.now();
await page.evaluate(() => window.bounce.askForCharacter());
await page.waitForFunction(() => window.bounce.status.state !== 'loading', null, { timeout: 180_000 });
console.log(`character in ${((Date.now() - t0) / 1000).toFixed(1)}s, state=${await page.evaluate(() => window.bounce.status.state)}`);
console.log('spec:  ', JSON.stringify(await page.evaluate(() => window.bounce.sim.character.spec)));
console.log('source:', await page.evaluate(() => window.bounce.status.source));

// One intent takes ~20s here, so wait long enough for at least one to land.
console.log('\nletting the local brain steer for 30s…');
const moved = await page.evaluate(async () => {
  const body = window.bounce.sim.character.body;
  const a = body.translation();
  await new Promise((r) => setTimeout(r, 30_000));
  const b = body.translation();
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
});
console.log(`travelled ${moved.toFixed(2)}m`);
console.log('brain:  ', JSON.stringify(await page.evaluate(() => ({ ...window.bounce.brain.state, intent: window.bounce.brain.intent }))));
const pos = await page.evaluate(() => window.bounce.sim.character.body.translation());
console.log('in arena:', Math.abs(pos.x) < 9 && Math.abs(pos.z) < 9 && pos.y > -0.5);

await page.screenshot({ path: '../docs/step6-local-model.png' });
console.log('screenshot -> docs/step6-local-model.png');
console.log('uncaught errors:', errors.length === 0 ? 'none' : errors.slice(0, 3).join(' | '));

await browser.close();
await new Promise((r) => proxy.close(r));
