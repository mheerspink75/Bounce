// Times candidate models against the real character prompt and reports whether
// the output survives our extractor. Run with:
//   node --env-file=.env scripts/bench-models.mjs
// Prints no credentials.
import { extractJsonObject } from '../server/extract.js';
import { sanitizeSpec } from '../public/spec.js';

const KEY = process.env.NIM_API_KEY;
if (!KEY) {
  console.error('no NIM_API_KEY — run: node --env-file=.env scripts/bench-models.mjs');
  process.exit(1);
}

const ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';

const CANDIDATES = [
  'deepseek-ai/deepseek-v4.1-flash',
  'nvidia/nemotron-nano-3-30b-a3b',
  'ibm/granite-3.0-3b-a800m-instruct',
  'meta/llama2-70b',
  'google/gemma-2b',
  '01-ai/yi-large',
  'nvidia/mistral-nemo-minitron-8b-8k-instruct',
  'z-ai/glm-5.3-flash',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nv-mistralai/mistral-nemo-12b-instruct',
  'ibm/granite-3.0-8b-instruct',
  'google/gemma-3-4b-it',
];

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

console.log('model'.padEnd(42) + 'status   latency  parses  name');
console.log('-'.repeat(76));

for (const model of CANDIDATES) {
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: 'Design a character.' },
        ],
        temperature: 0.9,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(45_000),
    });

    const ms = Date.now() - t0;

    if (!res.ok) {
      console.log(`${model.padEnd(42)}HTTP ${res.status}`);
      continue;
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content ?? '';
    const parsed = extractJsonObject(raw);
    const spec = parsed ? sanitizeSpec(parsed) : null;

    console.log(
      model.padEnd(42)
      + 'ok      '
      + `${(ms / 1000).toFixed(1)}s`.padStart(6)
      + '   '
      + (parsed ? 'yes' : 'NO').padStart(5)
      + '   '
      + (spec ? spec.name : '-'),
    );
    if (!parsed) console.log(`      raw: ${JSON.stringify(raw.slice(0, 140))}`);
  } catch (err) {
    const why = err.name === 'TimeoutError' ? 'timeout' : err.message;
    console.log(`${model.padEnd(42)}ERROR    ${why}`);
  }
}
