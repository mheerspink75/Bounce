// Characterises NIM free-tier latency with spaced calls, to distinguish
// "slow model" from "queueing under load". Run:
//   node --env-file=.env scripts/latency-probe.mjs
import { writeFileSync } from 'node:fs';

const KEY = process.env.NIM_API_KEY;
if (!KEY) {
  console.error('no NIM_API_KEY — run: node --env-file=.env scripts/latency-probe.mjs');
  process.exit(1);
}

const ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = process.env.PROBE_MODEL ?? 'deepseek-ai/deepseek-v4.1-flash';
const GAP_S = Number(process.env.PROBE_GAP ?? 45);
const RUNS = Number(process.env.PROBE_RUNS ?? 3);

async function probe(label) {
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with one JSON object: {"ok":true}' }],
        max_tokens: 50,
      }),
      signal: AbortSignal.timeout(150_000),
    });
    const ms = Date.now() - t0;
    if (!res.ok) return { label, ms, status: res.status };

    const data = await res.json();
    return {
      label,
      ms,
      status: res.status,
      reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      completionTokens: data?.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    return { label, ms: Date.now() - t0, status: err.name === 'TimeoutError' ? 'timeout' : err.message };
  }
}

console.log(`model: ${MODEL}`);
console.log(`gap between calls: ${GAP_S}s\n`);

const results = [];
for (let i = 0; i < RUNS; i += 1) {
  const r = await probe(`run ${i + 1}`);
  results.push(r);
  console.log(
    `run ${i + 1}: ${(r.ms / 1000).toFixed(1)}s  status=${r.status}`
    + (r.reasoningTokens !== undefined ? `  reasoning=${r.reasoningTokens}t completion=${r.completionTokens}t` : ''),
  );
  if (i < RUNS - 1) {
    process.stdout.write(`  waiting ${GAP_S}s…\n`);
    await new Promise((res) => setTimeout(res, GAP_S * 1000));
  }
}

const times = results.map((r) => r.ms).sort((a, b) => a - b);
console.log(`\nmin ${(times[0] / 1000).toFixed(1)}s   median ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)}s   max ${(times.at(-1) / 1000).toFixed(1)}s`);
console.log(results.every((r) => r.status === 200)
  ? '\nAll calls succeeded. Latency is variable, not failing.'
  : '\nSome calls failed — see statuses above.');

writeFileSync(new URL('../latency-probe.json', import.meta.url), JSON.stringify({ model: MODEL, results }, null, 2));
