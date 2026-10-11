/**
 * The thoughts panel shows the model's own words, and inserts them as text.
 *
 * Two things are being protected here, and one of them is a security property
 * rather than a feature.
 *
 * **Untrusted text.** `model_said` and `model_reasoning` are whatever the model
 * emitted. A model is free to return `<script>alert(1)</script>` or
 * `<img src=x onerror=...>`, and this project treats every model response as
 * hostile everywhere else — sanitised three times over before it reaches the
 * simulation. A panel that rendered it as markup would reintroduce the hole in the
 * one place nobody was watching, so the panel is built with `createElement` and
 * `textContent` and never with `innerHTML`. The test asserts that a response
 * containing markup appears as literal text.
 *
 * **The redaction pass.** Model output goes through the same key-shaped-string
 * redaction as every other response body, so a model that somehow echoed a
 * credential could not surface it in the panel.
 *
 * **It is worth having.** The applied intent is sanitised, so it looks tidy
 * whether or not the model behaved. A 1.5B asking for `target: null` and
 * `intensity: 5` was clamped into something perfectly valid and the character
 * silently did nothing — six mazes, four minutes, zero rewards, no error. Showing
 * the raw output beside what was applied is what makes that visible.
 *
 *   node test/thoughts-panel.test.mjs
 */
import { createRequire } from 'node:module';
import { createProxy } from '../server/index.js';
import { createMockProvider, createOpenAICompatibleProvider } from '../server/providers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PAGE = process.env.BOUNCE_URL ?? 'http://localhost:8080/';

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** A provider that says something identifiable, including markup. */
const HOSTILE = {
  name: 'hostile',
  needsKey: false,
  async complete() {
    return {
      raw: '{"action":"charge_target","target":"goal","intensity":9,"duration_s":99}'
        + '<img src=x onerror="window.__pwned=1">',
      model: 'hostile-1',
      latencyMs: 12,
      reasoningTokens: 3,
    };
  },
};

console.log('\nthoughts panel: the model\'s own words, as text\n');

const browser = await chromium.launch();

// --- reasoning, straight against the real adapter ---------------------------
// The field-reading code lives in the OpenAI-compatible adapter, so testing it
// through a hand-built provider object would skip the very code that matters —
// and did: an earlier version of this test invented a provider return shape that
// the adapter never sees, and "passed" the panel checks while the attribution
// check failed for reasons that had nothing to do with the panel.
//
// So: point the adapter at a stub HTTP server that replies with the exact wire
// shape, and assert against what comes out. This is the only version of the test
// that exercises the real path.
{
  const http = await import('node:http');

  /** A one-shot OpenAI-compatible endpoint that replies with `body`. */
  async function serving(body) {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
  }

  const answer = '{"action":"charge_target","target":"goal","intensity":0.9,"duration_s":4}';
  const scratchText = 'The reward is unreached, so head for it. Considering the route.';

  for (const field of ['reasoning', 'reasoning_content', 'thinking']) {
    for (const where of ['message', 'choice']) {
      // In both cases the *answer* is in `message.content`, as the real wire
      // format has it. What varies is only where the scratch work sits: Ollama
      // puts it on the message, some gateways hoist it onto the choice.
      const bubble = {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: answer },
        ...(where === 'message' ? { message: { role: 'assistant', content: answer, [field]: scratchText } } : { [field]: scratchText }),
      };

      const { server, url } = await serving({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: 'thinker-1',
        choices: [{ index: 0, ...bubble }],
        usage: { prompt_tokens: 90, completion_tokens: 73, total_tokens: 163 },
      });

      const provider = createOpenAICompatibleProvider({
        name: 'local',
        baseUrl: url,
        apiKey: 'local-no-key',
        model: 'thinker-1',
      });
      const out = await provider.complete({ system: 's', user: 'u', purpose: 'intent' });

      const label = `${field} on the ${where}`;
      check(`adapter reads ${label}`,
        out.reasoning === scratchText, `got ${JSON.stringify(out.reasoning)}`);
      check(`adapter attributes it to \`${field}\``,
        out.reasoningField === field, `got ${out.reasoningField}`);
      check(`adapter still takes the answer from \`content\` (${label})`,
        out.raw === answer);
      server.close();
    }
  }

  // A model with no scratch work at all must report none, not an empty string.
  {
    const { server, url } = await serving({
      model: 'plain-1',
      choices: [{ index: 0, message: { role: 'assistant', content: answer } }],
      usage: { completion_tokens: 20 },
    });
    const provider = createOpenAICompatibleProvider({ name: 'local', baseUrl: url, apiKey: 'k', model: 'plain-1' });
    const out = await provider.complete({ system: 's', user: 'u', purpose: 'intent' });
    check('a model that does not think reports no reasoning',
      out.reasoning === null && out.reasoningField === null,
      `reasoning=${JSON.stringify(out.reasoning)} field=${out.reasoningField}`);
    server.close();
  }

  // An empty string is not reasoning; treating it as such would put an empty box
  // in the panel for every non-reasoning model.
  {
    const { server, url } = await serving({
      model: 'blank-1',
      choices: [{ index: 0, message: { role: 'assistant', content: answer, reasoning: '   ' } }],
    });
    const provider = createOpenAICompatibleProvider({ name: 'local', baseUrl: url, apiKey: 'k', model: 'blank-1' });
    const out = await provider.complete({ system: 's', user: 'u', purpose: 'intent' });
    check('whitespace-only scratch work is treated as none',
      out.reasoning === null, `got ${JSON.stringify(out.reasoning)}`);
    server.close();
  }
}

// --- the proxy actually sends them -----------------------------------------
{
  const proxy = createProxy({ provider: HOSTILE });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${proxy.address().port}`;

  const res = await fetch(`${base}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targets: ['goal'], goal: { id: 'goal', distance_m: 5, path_cells: 3, maze: '5x5', reached: false } }),
  });
  const body = await res.json();

  check('the response carries what the model said', typeof body.model_said === 'string'
    && body.model_said.includes('charge_target'));
  check('it flags that the sanitiser changed the answer', body.sanitised === true,
    `intensity 9 and duration 99 should both have been clamped`);
  check('the clamped values are what got applied',
    body.intent.intensity === 1 && body.intent.duration_s === 10,
    `intensity=${body.intent.intensity} duration_s=${body.intent.duration_s}`);
  check('the applied intent still navigates', body.intent.target === 'goal');

  // Redaction: a key-shaped string in model output must not survive.
  const leaky = {
    name: 'leaky',
    needsKey: false,
    async complete() {
      return { raw: '{"action":"wander","target":"nvapi-abcdefgh12345678","intensity":0.5,"duration_s":3}', model: 'leaky', latencyMs: 1 };
    },
  };
  const p2 = createProxy({ provider: leaky });
  await new Promise((r) => p2.listen(0, '127.0.0.1', r));
  const r2 = await fetch(`http://127.0.0.1:${p2.address().port}/api/intent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const b2 = await r2.json();
  const serialised = JSON.stringify(b2);
  check('a key-shaped string in model output is redacted before it leaves the proxy',
    !serialised.includes('nvapi-abcdefgh12345678')
    && serialised.includes('[redacted]'),
    'the key appears nowhere in the response body');
  check('redaction covers the applied target too, not just the panel text',
    !String(b2.intent.target ?? '').includes('nvapi-abcdefgh12345678'),
    `intent.target = ${JSON.stringify(b2.intent.target)}`);
  // The point of redacting rather than rejecting: the response is still a
  // well-formed intent, so the brain gets a string it cannot resolve and wanders,
  // exactly as it would for any unknown id. No throw, no missing field.
  check('a redacted target is still a well-formed intent',
    typeof b2.intent.target === 'string'
    && typeof b2.intent.action === 'string'
    && Number.isFinite(b2.intent.intensity)
    && Number.isFinite(b2.intent.duration_s),
    `action=${b2.intent.action} target=${JSON.stringify(b2.intent.target)}`);

  // And the brain really does survive an unresolvable target.
  const { createWorld } = await import('../public/physics.js');
  const { createBrain } = await import('../public/brain.js');
  const { sanitizeSpec, DEFAULT_SPEC } = await import('../public/spec.js');
  const sim = await createWorld({ spec: sanitizeSpec(DEFAULT_SPEC), mazeSeed: 1 });
  let t = 0;
  const clock = { now: () => t * 1000 };
  const brain = createBrain({
    sim,
    ask: async () => ({ action: 'charge_target', target: '[redacted]', intensity: 1, duration_s: 3 }),
    now: clock.now,
  });
  const a = sim.character.body.translation();
  for (let i = 0; i < 180; i += 1) { t += 1 / 60; brain.update(1 / 60); sim.advance(1 / 60); }
  const b = sim.character.body.translation();
  check('the brain keeps moving with an unresolvable target',
    Math.hypot(b.x - a.x, b.z - a.z) > 0.05,
    `moved ${Math.hypot(b.x - a.x, b.z - a.z).toFixed(2)}m`);
  p2.close();
  proxy.close();
}

// --- and the page renders it as text, not markup ---------------------------
{
  const proxy = createProxy({ provider: HOSTILE });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${PAGE}?proxy=${encodeURIComponent(proxyUrl)}`);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30_000 });

  check('the panel starts closed, so it never covers the maze',
    await page.evaluate(() => !document.body.classList.contains('thoughts-open')));

  // Open it the way a user would.
  await page.click('#thoughtsToggle');
  await page.waitForTimeout(500);
  check('the toggle opens the panel',
    await page.evaluate(() => document.body.classList.contains('thoughts-open')));

  // Let the brain poll once, so there is something to show.
  await page.waitForTimeout(4000);

  const state = await page.evaluate(() => {
    const el = document.getElementById('thoughts');
    return {
      entries: el.querySelectorAll('.t-entry').length,
      // Did the hostile markup become an element, or text?
      injectedImages: el.querySelectorAll('img').length,
      pwned: Boolean(window.__pwned),
      text: el.textContent,
    };
  });

  check('the panel shows the model output', state.entries > 0, `${state.entries} entries`);
  check('markup in model output is NOT turned into elements',
    state.injectedImages === 0, `${state.injectedImages} <img> elements created`);
  check('markup in model output is shown literally instead',
    state.text.includes('<img src=x'), 'the tag is visible as text');
  check('the injected handler never ran', state.pwned === false);
  check('no uncaught page errors', pageErrors.length === 0, pageErrors[0] ?? '');
  check('a clamped answer is flagged in the panel',
    state.text.includes('sanitiser changed this'));

  // --- and it reaches the page, in its own block, as text ------------------
  {
    const thinker = {
      name: 'thinker',
      needsKey: false,
      async complete() {
        return {
          raw: '{"action":"charge_target","target":"goal","intensity":0.9,"duration_s":4}',
          reasoning: 'The reward is unreached, so head for it. Considering the route.',
          reasoningField: 'reasoning',
          model: 'thinker-1',
          latencyMs: 40,
          reasoningTokens: 128,
        };
      },
    };
    const tp = createProxy({ provider: thinker });
    await new Promise((r) => tp.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${tp.address().port}`;

    const tRes = await fetch(`${url}/api/intent`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets: ['goal'], goal: { id: 'goal', distance_m: 5, path_cells: 3, maze: '5x5', reached: false } }),
    });
    const tBody = await tRes.json();
    check('the proxy forwards reasoning to the page',
      tBody.model_reasoning === 'The reward is unreached, so head for it. Considering the route.');
    check('...and which field it came from', tBody.reasoning_field === 'reasoning');

    const pg = await browser.newPage({ viewport: { width: 1400, height: 800 } });
    await pg.goto(`${PAGE}?proxy=${encodeURIComponent(url)}`);
    await pg.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30_000 });
    await pg.click('#thoughtsToggle');
    await pg.waitForTimeout(4500);
    const shown = await pg.evaluate(() => {
      const el = document.getElementById('thoughts');
      const r = el.querySelector('.t-reason');
      return {
        hasBlock: Boolean(r),
        isPre: r?.tagName === 'PRE',
        text: r?.textContent ?? '',
        nestedElements: r ? r.querySelectorAll('*').length : -1,
        tag: r?.querySelector('.t-tag')?.textContent ?? '',
        // The answer must be its own block, distinct from the reasoning.
        answerBlocks: el.querySelectorAll('.t-said').length,
      };
    });
    check('reasoning is shown in the panel as its own block',
      shown.hasBlock && shown.isPre && shown.text.includes('The reward is unreached'),
      shown.text.slice(0, 60));
    check('...labelled with the field it came from',
      shown.tag.includes('reasoning'), `tag: ${shown.tag}`);
    check('...containing no nested elements (text, not markup)',
      shown.nestedElements === 1,
      `${shown.nestedElements} child element(s), expected just the label`);
    check('...and the answer is a separate block from the reasoning',
      shown.answerBlocks >= 1,
      `${shown.answerBlocks} answer block(s)`);
    await pg.close();
    tp.close();
  }

  // It should sit on the right and not overlap the HUD.
  const boxes = await page.evaluate(() => {
    const h = document.getElementById('hud').getBoundingClientRect();
    const t = document.getElementById('thoughts').getBoundingClientRect();
    return { hudRight: h.right, panelLeft: t.left, panelRight: t.right, vw: innerWidth };
  });
  check('the panel sits clear of the HUD',
    boxes.panelLeft >= boxes.hudRight, `hud ends ${boxes.hudRight}, panel starts ${boxes.panelLeft}`);
  check('the panel is inside the viewport',
    boxes.panelRight <= boxes.vw, `panel ends ${boxes.panelRight}, viewport ${boxes.vw}`);

  proxy.close();
}

await browser.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
