/**
 * Optional browser smoke test for step 2.
 *
 * The headless suites (physics.test.mjs, character.test.mjs) cover all the logic.
 * What they cannot cover is whether the page actually boots: ESM import-map
 * resolution from a CDN, WebGL context creation, OrbitControls, and the
 * character-mesh swap path. This closes that gap.
 *
 * Requires Playwright with a Chromium build:
 *     npm i -D playwright && npx playwright install chromium
 * Then:
 *     npm run serve &
 *     npm run test:browser
 *
 * Skips with exit 0 (not a failure) if Playwright or its browser is missing, so
 * `npm test` stays usable on a machine with no browser — which is the case on
 * the current dev box, see README §7.
 */
import { createRequire } from 'node:module';
import { createProxy } from '../server/index.js';
import { createMockProvider } from '../server/providers.js';

const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.log('SKIP  playwright not installed — run: npm i -D playwright && npx playwright install chromium');
  process.exit(0);
}

const PAGE_URL = process.env.BOUNCE_URL ?? 'http://localhost:8080/';

// Boot a real proxy on an ephemeral port so the page exercises the actual
// network path and CORS preflight, not a stubbed fetch.
const proxy = createProxy({ provider: createMockProvider() });
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  console.log(`SKIP  chromium unavailable (${err.message.split('\n')[0]})`);
  process.exit(0);
}

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const page = await browser.newPage();

// Uncaught exceptions are always a bug. Console errors are tracked separately
// because a *handled* failed fetch still logs one — that is expected browser
// behaviour, not a defect.
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(`${PAGE_URL}?proxy=${encodeURIComponent(proxyUrl)}`, { waitUntil: 'load' });

// Wait for main() to finish booting the WASM + scene.
let booted = true;
try {
  await page.waitForFunction(() => window.__bounce?.ready === true, null, { timeout: 30_000 });
} catch {
  booted = false;
}
check('page boots without errors', booted && pageErrors.length === 0,
  booted ? (pageErrors[0] ?? '') : 'timed out waiting for window.__bounce.ready');

if (booted) {
  check('WebGL context created', await page.evaluate(() => {
    const gl = window.__bounce.renderer.getContext();
    return Boolean(gl);
  }));

  check('canvas is actually drawing', await page.evaluate(() => {
    const c = window.__bounce.renderer.domElement;
    return c.width > 0 && c.height > 0;
  }), await page.evaluate(() => {
    const c = window.__bounce.renderer.domElement;
    return `${c.width}x${c.height}`;
  }));

  // The default world is a maze: 1 floor + internal walls + 4 perimeter. The
  // count therefore follows the grid size, so assert the structure rather than a
  // magic number that breaks whenever the sizing rules change.
  check('maze built', await page.evaluate(() => {
    const m = window.__bounce.sim.maze;
    if (!m) return false;
    const expected = 1 + m.edges.size + 4;          // floor + internal + perimeter
    return window.__bounce.sim.statics.length === expected;
  }), await page.evaluate(() => {
    const m = window.__bounce.sim.maze;
    return m
      ? `${m.dims}x${m.dims}, ${window.__bounce.sim.statics.length} bodies, expected ${1 + m.edges.size + 4}`
      : 'no maze';
  }));

  check('maze has a start and a goal, and they are far apart', await page.evaluate(() => {
    const s = window.__bounce.sim;
    if (!s.goal || !s.start) return false;
    return Math.hypot(s.goal.x - s.start.x, s.goal.z - s.start.z) > 4;
  }));

  // Compare the recorded spawn point, not the live body: the brain starts
  // steering within a second, so the character has already moved by the time
  // this runs. That made the check flaky — it passed about a third of the time.
  check('the character is born at the maze start', await page.evaluate(() => {
    const s = window.__bounce.sim;
    return Math.hypot(s.spawn.x - s.start.x, s.spawn.z - s.start.z) < 0.01;
  }), await page.evaluate(() => {
    const s = window.__bounce.sim;
    return `spawn (${s.spawn.x.toFixed(2)}, ${s.spawn.z.toFixed(2)}) start (${s.start.x.toFixed(2)}, ${s.start.z.toFixed(2)})`;
  }));

  check('character spec is sane', await page.evaluate(() => {
    const s = window.__bounce.sim.character.spec;
    return Number.isFinite(s.radius) && s.radius > 0 && /^#[0-9a-f]{6}$/.test(s.color);
  }));

  // --- manual steering reaches the page promptly -------------------------
  // The health-poll -> interrupt path only exists in the browser, so it cannot
  // be covered headlessly. This checks the wiring end to end: post an override,
  // and the page's live intent becomes it.
  //
  // The case that motivated it: with a 20s model call in flight, the brain paces
  // requests from completion and so asks for nothing, leaving a manual intent
  // queued behind a call nobody wanted. 22 of 30 seconds of a maze run were
  // spent in that dead window. The interruption itself is covered in
  // brain.test.mjs; this proves the page notices the override at all.
  await fetch(`${proxyUrl}/api/intent/manual`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'charge_target', target: 'goal', intensity: 1, ttl_s: 20 }),
  });

  const sawManual = await page.waitForFunction(
    () => window.bounce.events?.some((e) => e.kind === 'override'),
    null,
    { timeout: 8000 },
  ).then(() => true).catch(() => false);

  check('the page notices a manual override within a few seconds', sawManual,
    sawManual ? 'override event seen' : 'no override event in 8s');

  const manualTook = await page.waitForFunction(
    () => {
      const i = window.bounce.stats.lastIntent;
      return i && i.action === 'charge_target' && i.target === 'goal';
    },
    null,
    { timeout: 8000 },
  ).then(() => true).catch(() => false);

  check('the manual intent reaches the character', manualTook,
    manualTook ? 'charge_target -> goal is live' : 'never took effect');

  await fetch(`${proxyUrl}/api/intent/manual`, { method: 'DELETE' });

  // The step-2 deliverable: a spec drives the character, end to end.
  const before = await page.evaluate(() => window.__bounce.sim.character.spec.radius);
  const applied = await page.evaluate(() => window.bounce.applySpec({ radius: 1.5, color: '#f2c14e', mass: 3 }).radius);
  check('applySpec changes the physics radius', applied === 1.5 && applied !== before,
    `${before} -> ${applied}`);

  // Both assertions below count sphere meshes, and the locator shell is one — so
  // they have to exclude it by name. `characterLocator` is excluded rather than
  // "any mesh with depthTest false" so that a real regression which quietly set
  // depthTest on the character would still be caught here.
  const CHARACTER_SPHERES = `(() => window.__bounce.scene.children.filter(
    o => o.isMesh && o.geometry?.type === 'SphereGeometry' && o.name !== 'characterLocator'))()`;

  check('mesh geometry follows the new spec', await page.evaluate(() => {
    const spheres = window.__bounce.scene.children.filter(
      (o) => o.isMesh && o.geometry?.type === 'SphereGeometry' && o.name !== 'characterLocator',
    );
    return spheres.length === 1 && spheres[0].geometry?.parameters?.radius === 1.5;
  }), await page.evaluate(() => {
    const spheres = window.__bounce.scene.children.filter(
      (o) => o.isMesh && o.geometry?.type === 'SphereGeometry' && o.name !== 'characterLocator',
    );
    return `${spheres.length} character mesh(es), r=${spheres[0]?.geometry?.parameters?.radius}`;
  }));

  check('old mesh removed from scene (no leak)', await page.evaluate(
    (src) => eval(src).length === 1, CHARACTER_SPHERES,
  ), await page.evaluate((src) => `${eval(src).length} character sphere meshes`, CHARACTER_SPHERES));

  // The locator is a second mesh on purpose, so assert it separately: exactly
  // one, sized to the character that is live now.
  check('exactly one locator, sized to the current character', await page.evaluate(() => {
    const locators = window.__bounce.scene.children.filter((o) => o.name === 'characterLocator');
    if (locators.length !== 1) return false;
    const r = locators[0].geometry?.parameters?.radius ?? 0;
    const body = window.__bounce.sim.character.spec.radius;
    return Math.abs(r - body * 1.08) < 0.01;
  }), await page.evaluate(() => {
    const n = window.__bounce.scene.children.filter((o) => o.name === 'characterLocator').length;
    return `${n} locator(s), body r=${window.__bounce.sim.character.spec.radius}`;
  }));

  // Malformed input must not break the running sim.
  await page.evaluate(() => window.bounce.applySpec({ radius: 'garbage', color: 'not-a-color' }));
  check('malformed spec does not throw', pageErrors.length === 0, pageErrors[0] ?? '');

  // Let it run and confirm the character is actually moving.
  const moved = await page.evaluate(async () => {
    const body = window.__bounce.sim.character.body;
    const a = body.translation();
    await new Promise((r) => setTimeout(r, 1200));
    const b = body.translation();
    return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  });
  check('character is animating', moved > 0.05, `moved ${moved.toFixed(3)}m in 1.2s`);

  check('no page errors across the whole run', pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | '));

  // --- step 3: the real proxy path -------------------------------------
  // Waits for the page's health probe to resolve, which proves the cross-origin
  // request and preflight both worked.
  let healthSeen = true;
  try {
    await page.waitForFunction(() => window.bounce?.status?.provider !== '—', null, { timeout: 10_000 });
  } catch { healthSeen = false; }
  check('page reaches the proxy (CORS preflight works)', healthSeen,
    await page.evaluate(() => window.bounce?.status?.provider ?? 'unknown'));

  check('health reports the mock provider',
    (await page.evaluate(() => window.bounce.status.provider)) === 'mock');

  const beforeAsk = await page.evaluate(() => window.bounce.sim.character.spec.name);

  await page.evaluate(() => window.bounce.askForCharacter());
  await page.waitForFunction(() => window.bounce.status.state !== 'loading', null, { timeout: 15_000 });

  const askState = await page.evaluate(() => window.bounce.status.state);
  check('askForCharacter succeeds', askState === 'ok', `state=${askState}`);

  check('model spec reached the physics world',
    (await page.evaluate(() => window.bounce.sim.character.spec.name)) !== undefined
    && (await page.evaluate(() => window.bounce.sim.character.spec.restitution)) < 1,
    `name="${await page.evaluate(() => window.bounce.sim.character.spec.name)}"`);

  check('source is reported, not silently faked',
    (await page.evaluate(() => window.bounce.status.source)) === 'mock');

  check('the key never appears in the page', await page.evaluate((p) => {
    const html = document.documentElement.outerHTML;
    return !/nvapi-|sk-[A-Za-z0-9]{12,}|apiKey|authorization/i.test(html);
  }, proxyUrl));

  // A dead proxy must not empty the scene. Reserve a port by binding and
  // releasing it, so we get one that is guaranteed closed — Chromium blocks a
  // list of unsafe ports (including 1) before the request is even attempted,
  // which would test the browser's port policy rather than our error handling.
  const scratch = createProxy({ provider: createMockProvider() });
  await new Promise((r) => scratch.listen(0, '127.0.0.1', r));
  const deadPort = scratch.address().port;
  await new Promise((r) => scratch.close(r));

  pageErrors.length = 0;   // ignore anything from the previous page
  await page.goto(`${PAGE_URL}?proxy=${encodeURIComponent(`http://127.0.0.1:${deadPort}`)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__bounce?.ready === true, null, { timeout: 30_000 });
  await page.evaluate(() => window.bounce.askForCharacter());
  await page.waitForFunction(() => window.bounce.status.state === 'error', null, { timeout: 20_000 });

  check('a dead proxy is reported as an error state',
    (await page.evaluate(() => window.bounce.status.state)) === 'error');
  check('a failed request leaves the character intact', await page.evaluate(() => {
    const s = window.bounce.sim.character.spec;
    return Number.isFinite(s.radius) && s.radius > 0 && s.mass > 0;
  }));
  check('a failed request raises no uncaught exception', pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | '));

  // --- step 4: the brain drives the character --------------------------
  await page.goto(`${PAGE_URL}?proxy=${encodeURIComponent(proxyUrl)}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__bounce?.ready === true, null, { timeout: 30_000 });
  pageErrors.length = 0;

  // The brain should ask on its own, with no keypress.
  let asked = true;
  try {
    await page.waitForFunction(() => window.bounce.brain?.state?.requests > 0, null, { timeout: 15_000 });
  } catch { asked = false; }
  check('brain asks the model unprompted', asked,
    `requests=${await page.evaluate(() => window.bounce.brain?.state?.requests ?? 'n/a')}`);

  await page.waitForFunction(() => window.bounce.brain.state.status === 'ok', null, { timeout: 15_000 });
  check('brain receives a usable intent', await page.evaluate(() => {
    const i = window.bounce.brain.intent;
    return typeof i.action === 'string' && i.intensity >= 0 && i.intensity <= 1;
  }), await page.evaluate(() => JSON.stringify(window.bounce.brain.intent)));

  check('intent action is from the closed enum', await page.evaluate(() => {
    const allowed = ['seek', 'wander', 'charge_target', 'rest'];
    return allowed.includes(window.bounce.brain.intent.action);
  }));

  // The character should now be moving on its own, without any keypress.
  const steered = await page.evaluate(async () => {
    const body = window.bounce.sim.character.body;
    const a = body.translation();
    await new Promise((r) => setTimeout(r, 2500));
    const b = body.translation();
    return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  });
  check('brain keeps the character moving unaided', steered > 0.5,
    `moved ${steered.toFixed(2)}m in 2.5s`);

  check('the character stays inside the arena under AI control', await page.evaluate(() => {
    const p = window.bounce.sim.character.body.translation();
    return Math.abs(p.x) < 9 && Math.abs(p.z) < 9 && p.y > -0.5;
  }), await page.evaluate(() => {
    const p = window.bounce.sim.character.body.translation();
    return `x=${p.x.toFixed(2)} y=${p.y.toFixed(2)} z=${p.z.toFixed(2)}`;
  }));

  // N should silence the brain; the character must survive being left alone.
  await page.keyboard.press('KeyN');
  const afterQuiet = await page.evaluate(() => window.bounce.brain.intent.action);
  check('N quiets the brain to the fallback intent', afterQuiet === 'wander',
    `action=${afterQuiet}`);

  check('no uncaught exceptions while the brain runs', pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | '));
}

await browser.close();
await new Promise((r) => proxy.close(r));
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
