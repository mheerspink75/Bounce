// Benchmarks whichever provider `.env` selects — local Ollama by default — and
// prints the table that appears in the README.
//
//   node --env-file=.env scripts/bench-local.mjs
//   node --env-file=.env scripts/bench-local.mjs --models qwen3:4b,qwen3:1.7b --runs 5
//
// Everything goes through the real proxy rather than straight to the model, so
// the numbers include JSON extraction and sanitising. That matters: the failure
// this project is most often bitten by is output that is *schema-shaped* and
// still unusable, and a benchmark that called the provider directly would score
// that as a pass. `sanitised` is reported for exactly this reason.
//
// Prints no credentials and writes nothing.
import { createProxy } from '../server/index.js';
import { createProviderFromEnv } from '../server/providers.js';

// The world the page reports. `goal` present and unreached is the state where a
// model has to actually decide, so that is what success rate is measured on.
const WORLD = {
  targets: ['block_a', 'block_b', 'ramp', 'goal'],
  goal: { id: 'goal', distance_m: 17.9, path_cells: 9, maze: '5x5', reached: false },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const RUNS = Number(arg('runs', process.env.BENCH_RUNS ?? 5));
const MODELS = (arg('models', process.env.LOCAL_BENCH_MODELS ?? process.env.LOCAL_MODEL ?? ''))
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);

if (MODELS.length === 0) {
  console.error('no model to benchmark — set LOCAL_MODEL in .env or pass --models');
  process.exit(1);
}

const pct = (n, d) => (d === 0 ? '-' : `${Math.round((n / d) * 100)}%`);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** POST to the proxy and return `{ status, body }` without throwing on 4xx/5xx. */
async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  return { status: res.status, body: await res.json() };
}

console.log(`provider: ${process.env.LLM_PROVIDER ?? '(inferred)'}`);
console.log(`base url: ${process.env.LOCAL_BASE_URL ?? '-'}`);
console.log(`runs per phase: ${RUNS}\n`);

const rows = [];

for (const model of MODELS) {
  // The provider reads these at construction time, so each model gets its own.
  process.env.LOCAL_MODEL = model;
  process.env.LOCAL_INTENT_MODEL = model;

  const proxy = createProxy({ provider: createProviderFromEnv() });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const { port } = proxy.address();

  // One untimed call first. A cold start pays for loading weights into VRAM and
  // would otherwise be charged to whichever phase happened to run first.
  try { await post(port, '/api/intent', WORLD); } catch { /* reported per-run below */ }

  const intentMs = [];
  let choseGoal = 0;
  let intentOk = 0;
  let sanitisedHits = 0;

  for (let i = 0; i < RUNS; i += 1) {
    const { status, body } = await post(port, '/api/intent', WORLD);
    if (status !== 200) { console.log(`  ${model} intent run ${i + 1}: HTTP ${status} ${body?.error ?? ''}`); continue; }
    intentOk += 1;
    intentMs.push(body.latency_ms ?? 0);
    if (body.intent?.action === 'charge_target' && body.intent?.target === 'goal') choseGoal += 1;
    if (body.sanitised) sanitisedHits += 1;
  }

  const charMs = [];
  const names = [];
  let charOk = 0;

  for (let i = 0; i < Math.min(RUNS, 3); i += 1) {
    const { status, body } = await post(port, '/api/character', {});
    if (status !== 200) { console.log(`  ${model} character run ${i + 1}: HTTP ${status} ${body?.error ?? ''}`); continue; }
    charOk += 1;
    charMs.push(body.latency_ms ?? 0);
    if (body.spec?.name) names.push(body.spec.name);
  }

  await new Promise((r) => proxy.close(r));

  rows.push({
    model,
    intent: intentOk ? median(intentMs) : 0,
    character: charOk ? median(charMs) : 0,
    success: pct(choseGoal, intentOk),
    detail: `${choseGoal}/${intentOk} chose the goal, ${sanitisedHits} needed sanitising`,
    names: names.join(', ') || '-',
  });

  console.log(`done ${model}: intent median ${(rows.at(-1).intent / 1000).toFixed(2)}s, `
    + `character median ${(rows.at(-1).character / 1000).toFixed(1)}s`);
}

console.log('\n| Model | Intent latency | Character generation | Success rate |');
console.log('| --- | --- | --- | --- |');
for (const r of rows) {
  console.log(`| \`${r.model}\` | ${(r.intent / 1000).toFixed(2)}s | ${(r.character / 1000).toFixed(1)}s | ${r.success} |`);
}

console.log('\nper-model detail:');
for (const r of rows) {
  console.log(`  ${r.model}: ${r.detail}`);
  console.log(`    characters designed: ${r.names}`);
}