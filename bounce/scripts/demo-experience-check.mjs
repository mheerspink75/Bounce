// Verifies the *demo experience* rather than the demo loop: that a visitor with
// no backend is told what they are looking at, that the dashboard shows real
// values, and that the characters visibly vary between runs.
//
//   npm run serve
//   node scripts/demo-experience-check.mjs
//
// Separate from `demo-mode-check.mjs` on purpose. That script answers "does the
// simulation work with nothing behind it?"; this one answers "does a stranger
// opening the link understand what they are looking at?" — the Phase 4 and Phase 6
// requirements, which are about presentation and would otherwise go untested.
//
// The banner assertions are the important ones. A static page that quietly
// substituted a scripted character for a model would be the worst thing this
// project could ship, and nothing in the simulation layer would notice.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.DEMO_BASE ?? 'http://localhost:8080';
// Defaults to the explicit flag. Point it at Pages with DEMO_QUERY=none to load
// the bare public URL, exactly as a stranger would paste it. The sentinel exists
// because an empty environment variable cannot express "no query string": Windows
// PowerShell deletes a variable assigned '', so `?? ''` never sees an empty value
// and quietly falls back to the flag. That is exactly the kind of default that
// makes a test pass while testing nothing.
const QUERY = (() => {
  const q = process.env.DEMO_QUERY;
  if (q === undefined || q === '') return '?demo=1';
  return q === 'none' ? '' : q;
})();

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// --- the banner is shown, and says what it is ---------------------------
{
  await page.goto(`${BASE}/${QUERY}`, { waitUntil: 'load' });
  await page.waitForFunction(
    () => Boolean(window.bounce) && window.bounce.status.provider !== '—',
    null, { timeout: 30_000 },
  );

  const banner = await page.evaluate(() => {
    const el = document.getElementById('demoBanner');
    return {
      visible: document.body.classList.contains('demo-on') && getComputedStyle(el).display !== 'none',
      text: el.textContent.replace(/\s+/g, ' ').trim(),
    };
  });

  check('demo banner is visible', banner.visible);
  check('banner names the mock provider', /mock/i.test(banner.text));
  check('banner promises no installation', /no server|no api key|no installation/i.test(banner.text));
  for (const provider of ['Ollama', 'NVIDIA NIM', 'OpenRouter', 'local models', 'schema-constrained']) {
    check(`banner lists ${provider}`, banner.text.includes(provider));
  }
  check('banner explains how demo mode engaged', /forced by|github\.io|not requested/i.test(banner.text),
    await page.evaluate(() => document.getElementById('demoReason')?.textContent ?? ''));

    // The reason line is the difference between "this is a mock" and "this is a
    // model I cannot see". On Pages it must name static hosting, not the flag.
    if (BASE.includes('github.io')) {
      check('Pages auto-engages demo mode with no query string',
        /github\.io/i.test(banner.text),
        `opened as ${BASE}/ with no demo flag`);
    }
  }

// --- the dashboard shows real, non-placeholder values --------------------
{
  const metrics = await page.evaluate(() => Object.fromEntries(
    ['m-maze', 'm-char', 'm-personality', 'm-rewards', 'm-avg', 'm-intent', 'm-simtime', 'm-fps']
      .map((id) => [id, document.getElementById(id)?.textContent ?? '']),
  ));
  console.log(`\n  dashboard: ${JSON.stringify(metrics)}\n`);

  check('maze metric is populated', /x\d+/.test(metrics['m-maze']), metrics['m-maze']);
  check('character metric is populated', metrics['m-char'] !== '—' && metrics['m-char'].length > 0, metrics['m-char']);
  check('personality metric is populated', metrics['m-personality'] !== '—', metrics['m-personality']);
  check('rewards metric is populated', /^\d+$/.test(metrics['m-rewards']), metrics['m-rewards']);
  check('intent metric is populated', /^[a-z_]+/.test(metrics['m-intent']), metrics['m-intent']);
  check('simulation time is advancing', parseFloat(metrics['m-simtime']) > 0, metrics['m-simtime']);
  check('fps is reported', /\d/.test(metrics['m-fps']), metrics['m-fps']);

  // The average must stay a placeholder until a maze is actually finished, then
  // become a number. A dashboard that shows "0.0s" from the first frame is
  // reporting a division of nothing.
  check('average completion starts as a placeholder', metrics['m-avg'] === '—', metrics['m-avg']);

    // And becomes a real number once a maze is actually finished. Asserting only
    // the placeholder would pass even if the average never updated at all.
    const budgetS = Number(process.env.DEMO_BUDGET_S ?? 90);
    const deadline = Date.now() + budgetS * 1000;
    let reward = null;
    while (Date.now() < deadline && !reward) {
      await page.waitForTimeout(500);
      reward = await page.evaluate(() => window.bounce.events.find((e) => e.kind === 'reward') ?? null);
    }
    check('a maze is solved and the loop advances', Boolean(reward),
      reward ? `maze ${reward.maze}, ${reward.path} cells, t=${reward.t.toFixed(1)}s` : `none within ${budgetS}s`);

    const after = await page.evaluate(() => ({
      rewards: document.getElementById('m-rewards').textContent,
      avg: document.getElementById('m-avg').textContent,
      maze: document.getElementById('m-maze').textContent,
    }));
    console.log(`\n  after reward: ${JSON.stringify(after)}\n`);
    check('rewards counter incremented', Number(after.rewards) >= 1, after.rewards);
    check('average completion became a real number', /^\d+(\.\d+)?s$/.test(after.avg), after.avg);
    check('maze metric advanced to a new generation', !/#1$/.test(after.maze), after.maze);
  }

// --- characters visibly vary --------------------------------------------
{
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    await page.evaluate(() => window.bounce.askForCharacter());
    await page.waitForFunction(() => window.bounce.status.state !== 'loading', null, { timeout: 30_000 });
    await page.waitForTimeout(120);
    seen.push(await page.evaluate(() => ({
      name: window.bounce.sim.character.spec.name,
      color: window.bounce.sim.character.spec.color,
      radius: window.bounce.sim.character.spec.radius,
      personality: window.bounce.status.personality?.label ?? null,
    })));
  }
  console.log(`\n  characters: ${seen.map((c) => `${c.name}/${c.personality}`).join(', ')}\n`);

  check('names vary across characters', new Set(seen.map((c) => c.name)).size >= 3,
    new Set(seen.map((c) => c.name)).size + ' distinct');
  check('colours vary across characters', new Set(seen.map((c) => c.color)).size >= 3);
  check('radii vary across characters', new Set(seen.map((c) => c.radius)).size >= 3);
  check('personalities vary across characters', new Set(seen.map((c) => c.personality)).size >= 3,
    [...new Set(seen.map((c) => c.personality))].join(', '));
}

// --- the page never reaches for a network backend -----------------------
{
  // Prove it rather than infer it: any request off-origin is a failure, since a
  // working demo must not need one.
  const offOrigin = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname)) offOrigin.push(r.url());
  });
  await page.evaluate(() => window.bounce.askForCharacter());
  await page.waitForTimeout(2500);
  // Only the pinned CDN modules (three, rapier) may be off-origin.
  const unexpected = offOrigin.filter((u) => !/jsdelivr\.net/.test(u));
  check('demo makes no request outside the pinned CDN', unexpected.length === 0,
    unexpected.slice(0, 2).join(' | '));
}

await page.screenshot({ path: '../docs/demo-dashboard.png' });
check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);