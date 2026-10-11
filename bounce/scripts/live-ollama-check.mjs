// End-to-end check against the REAL local Ollama provider (not the mock).
// Browser -> proxy -> ollama -> intent -> forces -> movement.
// Requires the static server on :8080 and ollama serving the model.
//   npm run serve
//   node --env-file=.env scripts/live-ollama-check.mjs
import { createRequire } from 'node:module';
import { createProxy } from '../server/index.js';
const require = createRequire(import.meta.url);

const { chromium } = require('playwright');

const proxy = createProxy();            // reads .env -> LLM_PROVIDER=ollama
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
console.log(`proxy up on ${proxyUrl} using provider: ${process.env.LLM_PROVIDER}`);
console.log(`local model: ${process.env.LOCAL_MODEL} @ ${process.env.LOCAL_BASE_URL}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(`http://localhost:8080/?proxy=${encodeURIComponent(proxyUrl)}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.bounce?.status?.provider !== '—', null, { timeout: 30_000 });
console.log('page reports provider:', await page.evaluate(() => window.bounce.status.provider));

console.log('\nrequesting a live character from ollama (thinking ON)...');
const t0 = Date.now();
await page.evaluate(() => window.bounce.askForCharacter());
await page.waitForFunction(() => window.bounce.status.state !== 'loading', null, { timeout: 240_000 });
console.log(`character arrived in ${((Date.now() - t0) / 1000).toFixed(1)}s, state=${await page.evaluate(() => window.bounce.status.state)}`);
console.log('spec:', JSON.stringify(await page.evaluate(() => window.bounce.sim.character.spec)));
console.log('source:', await page.evaluate(() => window.bounce.status.source));

console.log('\nletting the ollama brain steer for 45s...');
const intents = [];
let moved = 0;
for (let i = 0; i < 9; i++) {
  const before = await page.evaluate(() => window.bounce.sim.character.body.translation());
  await page.waitForTimeout(5000);
  const st = await page.evaluate(() => ({
    after: window.bounce.sim.character.body.translation(),
    intent: window.bounce.brain.intent,
    raw: window.bounce.brain.state?.lastRaw ?? null,
  }));
  moved += Math.hypot(st.after.x - before.x, st.after.y - before.y, st.after.z - before.z);
  if (st.intent) intents.push(`${st.intent.action}->${st.intent.target ?? '-'}`);
  console.log(`  t+${(i + 1) * 5}s  intent=${st.intent ? `${st.intent.action}->${st.intent.target ?? '-'}` : '(none yet)'}  state=${JSON.stringify(st.intent ?? {})}`);
}

console.log(`\ntotal travelled: ${moved.toFixed(2)}m`);
console.log(`intents emitted: ${intents.length ? intents.join(', ') : '(none)'}`);
console.log('brain state:', JSON.stringify(await page.evaluate(() => ({ ...window.bounce.brain.state, intent: window.bounce.brain.intent }))));

const pos = await page.evaluate(() => window.bounce.sim.character.body.translation());
const inArena = Math.abs(pos.x) < 9 && Math.abs(pos.z) < 9 && pos.y > -0.5;
console.log(`position: x=${pos.x.toFixed(2)} y=${pos.y.toFixed(2)} z=${pos.z.toFixed(2)}  inArena=${inArena}`);
console.log('uncaught page errors:', errors.length === 0 ? 'none' : errors.slice(0, 3).join(' | '));

const ok = intents.length > 0 && moved > 0.5 && inArena && errors.length === 0;
console.log(`\n${ok ? 'PASS' : 'FAIL'}  ollama drove the ball (intents=${intents.length}, moved=${moved.toFixed(2)}m)`);

await page.screenshot({ path: '../docs/step10-windows-ollama.png' });
await browser.close();
await new Promise((r) => proxy.close(r));
process.exit(ok ? 0 : 1);