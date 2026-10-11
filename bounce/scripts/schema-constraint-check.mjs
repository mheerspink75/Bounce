// Does llama-server actually enforce the JSON schema?
//
// This is the whole basis for using a <=2B model: prompting a small model for
// "JSON only" fails regularly, but a token-level grammar constraint should make
// invalid output impossible. Sends the same prompt both ways and compares.
//
//   node scripts/schema-constraint-check.mjs [baseUrl]
import { CHARACTER_SCHEMA } from '../public/schema.js';
import { extractJsonObject } from '../server/extract.js';
import { sanitizeSpec } from '../public/spec.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8081/v1';
const MODEL = process.env.LOCAL_MODEL ?? 'qwen2.5-1.5b-q4.gguf';
const RUNS = Number(process.env.RUNS ?? 8);

const SYSTEM = [
  'You design characters for a small 3D physics toy that runs in a web browser.',
  '',
  'Reply with ONE JSON object and nothing else. No prose, no markdown, no code fence.',
  '',
  'Fields:',
  '  name        string, 1-60 chars, no emoji',
  '  radius      number, 0.15-2.0',
  '  color       string, hex "#rrggbb"',
  '  mass        number, 0.05-100.0',
  '  restitution number, 0.0-0.95',
  '  roughness   number, 0.0-1.0',
  '  personality string, one short sentence describing how it moves',
  '',
  'Be creative and vary the values. restitution near 0.95 means very bouncy; near 0 means dead.',
].join('\n');

async function ask({ withSchema }) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'Design a character.' },
    ],
    temperature: 0.9,
    max_tokens: 400,
  };
  if (withSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'character', strict: true, schema: CHARACTER_SCHEMA },
    };
  }

  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  return { raw: data?.choices?.[0]?.message?.content ?? '', ms };
}

async function trial(withSchema, runs) {
  let parsed = 0;
  let exact = 0;
  const times = [];
  const failures = [];

  for (let i = 0; i < runs; i += 1) {
    try {
      const { raw, ms } = await ask({ withSchema });
      times.push(ms);
      const obj = extractJsonObject(raw);
      if (obj) {
        parsed += 1;
        const s = sanitizeSpec(obj);
        // "exact" = no field had to fall back to its default, i.e. the model
        // actually produced every field rather than the sanitiser inventing it.
        const allPresent = ['name', 'radius', 'color', 'mass', 'restitution', 'roughness', 'personality']
          .every((k) => obj[k] !== undefined);
        if (allPresent) exact += 1;
      } else {
        failures.push(raw.slice(0, 90));
      }
    } catch (err) {
      failures.push(`ERROR ${err.message}`);
    }
  }

  times.sort((a, b) => a - b);
  return {
    parsed, exact, times,
    median: times.length ? times[Math.floor(times.length / 2)] : null,
    failures,
  };
}

console.log(`model:  ${MODEL}`);
console.log(`base:   ${BASE}`);
console.log(`runs:   ${RUNS} per mode\n`);

const promptOnly = await trial(false, RUNS);
const withSchema = await trial(true, RUNS);

const row = (label, r) => {
  const med = r.median === null ? '  n/a' : `${(r.median / 1000).toFixed(2)}s`;
  console.log(
    `${label.padEnd(16)} parsed ${String(r.parsed).padStart(2)}/${RUNS}`
    + `   all-fields ${String(r.exact).padStart(2)}/${RUNS}`
    + `   median ${med}`,
  );
};

console.log('--- results ---');
row('prompt only', promptOnly);
row('schema-constrained', withSchema);
console.log('');

if (promptOnly.failures.length) {
  console.log('prompt-only failures (what a small model does unaided):');
  for (const f of promptOnly.failures.slice(0, 4)) console.log(`  ${JSON.stringify(f)}`);
  console.log('');
}
if (withSchema.failures.length) {
  console.log('schema-constrained failures:');
  for (const f of withSchema.failures.slice(0, 4)) console.log(`  ${JSON.stringify(f)}`);
}

console.log(
  withSchema.parsed === RUNS
    ? '\nPASS  the schema constraint held on every run — this is what makes a <=2B model viable.'
    : `\nSCHEMA NOT FULLY HONOURED: ${RUNS - withSchema.parsed} run(s) failed.`,
);
