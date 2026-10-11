/**
 * Does the HUD actually answer "is the AI driving?" — and does it say why when
 * it is not?
 *
 * The screenshot that prompted this showed `provider offline`, `brain error
 * (53 asks, 0.0s avg)` and `intent wander`, which is indistinguishable from a
 * dead proxy. It was in fact the origin guard refusing every request, because the
 * page had been opened at 127.0.0.1:8080 while ALLOWED_ORIGIN said
 * localhost:8080. The character kept moving the whole time, so motion proved
 * nothing — which is the whole reason this check exists.
 *
 * Run with both servers up:
 *   node test/control-visibility.mjs
 */
import { createRequire } from 'node:module';
import { createProxy } from '../server/index.js';
import { createMockProvider } from '../server/providers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PAGE = process.env.BOUNCE_URL ?? 'http://localhost:8080/';

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Read the HUD block the user actually looks at. */
async function readHud(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('*')]
      .find((n) => n.textContent && n.textContent.includes('substeps') && n.children.length === 0);
    return el ? el.textContent : null;
  });
}

const proxy = createProxy({ provider: createMockProvider() });
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();

console.log('\ncontrol visibility\n');

// --- 1. model actually answering ------------------------------------------
await page.goto(`${PAGE}?proxy=${encodeURIComponent(proxyUrl)}`);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30_000 });
// Long enough for at least one 2s poll to land.
await page.waitForTimeout(6000);

let hud = await readHud(page);
check('HUD is readable', Boolean(hud));

check('HUD names a control source', /control\s+\S/.test(hud ?? ''),
  (hud ?? '').split('\n').find((l) => l.startsWith('control')) ?? 'no control line');

check('HUD says the model is driving when it is',
  /control\s+model/.test(hud ?? ''),
  (hud ?? '').split('\n').find((l) => l.startsWith('control')) ?? '');

check('a working run reports no error reason', !/reason\s+/.test(hud ?? ''),
  (hud ?? '').split('\n').find((l) => l.startsWith('reason')) ?? 'no reason line');

// The provider line must be live, not a startup snapshot that can go stale.
check('provider is reported as the real provider, not "offline"',
  /provider\s+(?!offline)\S/.test(hud ?? ''),
  (hud ?? '').split('\n').find((l) => l.startsWith('provider')) ?? '');

// --- 2. the exact failure from the screenshot -------------------------------
// The page origin does not match ALLOWED_ORIGIN, so the CORS preflight is refused
// and every request fails. This is what "opened at 127.0.0.1 instead of
// localhost" actually produces.
//
// The mismatch has to be arranged on the *server* side. `Origin` is a
// browser-controlled header: a page cannot forge it, and neither can Playwright's
// route interception, so a test that tries to fake it via headers silently passes
// and proves nothing.
console.log('\nrefused origin (the reported failure)\n');
const previousAllowed = process.env.ALLOWED_ORIGIN;
process.env.ALLOWED_ORIGIN = 'http://not-this-machine.invalid:8080';
const strictProxy = createProxy({ provider: createMockProvider() });
await new Promise((r) => strictProxy.listen(0, '127.0.0.1', r));
const strictUrl = `http://127.0.0.1:${strictProxy.address().port}`;
if (previousAllowed === undefined) delete process.env.ALLOWED_ORIGIN;
else process.env.ALLOWED_ORIGIN = previousAllowed;

// Sanity: the server really is refusing this origin, or the rest is theatre.
const refusal = await fetch(`${strictUrl}/api/intent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: PAGE.replace(/\/$/, '') },
  body: '{}',
});
const refusalBody = await refusal.json().catch(() => ({}));
check('the test proxy really does refuse the page origin',
  refusal.status === 403, `HTTP ${refusal.status}`);
check('the refusal names the origin and the fix',
  typeof refusalBody.detail === 'string' && refusalBody.detail.includes('ALLOWED_ORIGIN'),
  refusalBody.detail ?? refusalBody.error);

const bad = await browser.newPage();
await bad.goto(`${PAGE}?proxy=${encodeURIComponent(strictUrl)}`);
await bad.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30_000 });
await bad.waitForTimeout(6000);

const badHud = await readHud(bad);
check('a refused origin does NOT claim the model is driving',
  !/control\s+model\b/.test(badHud ?? ''),
  (badHud ?? '').split('\n').find((l) => l.startsWith('control')) ?? '');

check('a refused origin is reported as a fallback, not a model decision',
  /control\s+FALLBACK/.test(badHud ?? ''),
  (badHud ?? '').split('\n').find((l) => l.startsWith('control')) ?? '');

check('the HUD gives the reason, not just "error"',
  /reason\s+\S/.test(badHud ?? ''),
  (badHud ?? '').split('\n').find((l) => l.startsWith('reason')) ?? 'NO REASON SHOWN');

// The browser turns a CORS-rejected request into a bare "Failed to fetch" and
// never shows the proxy's 403 body, so the client has to supply the explanation.
// Both the cause and the fix must survive the HUD's truncation to be worth
// anything — a message that explains itself after the cut is no use.
check('the reason is actionable, not a bare "Failed to fetch"',
  /proxy unreachable/i.test(badHud ?? '')
  && /ALLOWED_ORIGIN/.test(badHud ?? '')
  && !/^reason\s+Failed to fetch\s*$/m.test(badHud ?? ''),
  (badHud ?? '').split('\n').find((l) => l.startsWith('reason')) ?? '');

await strictProxy.close();

// --- 3. the character must not be frozen by any of this --------------------
const moved = await page.evaluate(() => {
  const s = window.bounce.sim;
  const p0 = s.character.body.translation();
  return new Promise((resolve) => setTimeout(() => {
    const p1 = s.character.body.translation();
    resolve(Math.hypot(p1.x - p0.x, p1.z - p0.z));
  }, 2500));
});
check('the character keeps moving regardless of provider health', moved > 0.05,
  `moved ${moved.toFixed(2)}m`);

await browser.close();
proxy.close();

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
