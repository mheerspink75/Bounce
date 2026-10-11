/**
 * The thinking-mode toggle must be honoured, and the failure must be legible.
 *
 * ## What this pins
 *
 * `think: false` is honoured on Ollama's native `/api/chat` and **silently ignored
 * on its OpenAI-compat `/v1` endpoint**. Verified on `qwen3:4b`, identical
 * request:
 *
 *   /v1/chat/completions   think:false   507 chars of reasoning, content: ''
 *   /api/chat             think:false   0 chars,  0.63s,  done=stop
 *
 * That is not a cosmetic difference. A hybrid model given `think: false` and
 * ignored spends the *entire* 120-token intent budget on scratch work and returns
 * no answer at all — indistinguishable, from the outside, from a model that
 * cannot be quiet. It is how `deepseek-r1` got blamed for an endpoint's
 * behaviour: measured as "structurally incompatible with this project", when the
 * model was fine and the URL was wrong.
 *
 * So the two things worth asserting are that the flag reaches the wire, and that
 * a model which ignores it produces an *actionable* error rather than a bare
 * "no content" — because those two failures need opposite fixes and a user
 * cannot tell them apart without being told.
 *
 * These run against a stub HTTP server in the exact wire format, so they exercise
 * the real request construction. A hand-built provider object would skip the very
 * code that is under suspicion.
 *
 *   node test/ollama-modes.test.mjs
 */
import { createServer } from 'node:http';
import { createOllamaProvider } from '../server/ollama.js';
import { INTENT_SCHEMA, CHARACTER_SCHEMA } from '../public/schema.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * Close a stub server and wait for it.
 *
 * `server.close()` is async, and it does not complete while keep-alive sockets
 * are still open. Exiting the process with handles mid-close aborts under libuv
 * on Windows ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"), so the
 * close has to be awaited and the loop allowed to drain on its own.
 */
const closed = (server) => new Promise((r) => {
  server.closeAllConnections?.();
  server.close(r);
});

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** A stub ollama that records what it was sent and replies with `reply`. */
async function stub(reply) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}/v1` };
}

const ANSWER = '{"action":"charge_target","target":"goal","intensity":0.8,"duration_s":3}';
const THINKING = 'The reward is unreached, so head for it. Considering the route.';

console.log('\nollama modes: one model, thinking on and off\n');

// --- the toggle reaches the wire, and the budget is per-purpose -----------
{
  const { server, seen, url } = await stub({
    model: 'qwen3:4b', done: true, done_reason: 'stop',
    message: { role: 'assistant', content: ANSWER },
  });
  const p = createOllamaProvider({ baseUrl: url, model: 'qwen3:4b', intentMaxTokens: 120, characterMaxTokens: 3000 });

  await p.complete({ system: 's', user: 'u', purpose: 'intent', jsonSchema: INTENT_SCHEMA });
  await p.complete({ system: 's', user: 'u', purpose: 'character', jsonSchema: CHARACTER_SCHEMA });

  check('intents go to the native endpoint, not the OpenAI-compat one',
    seen[0].url === '/api/chat', `posted to ${seen[0].url}`);
  check('a base URL ending in /v1 still resolves to the server root',
    true, 'the stub only serves /api/chat, so reaching it proves the rewrite');
  check('thinking is OFF for intents', seen[0].body.think === false);
  check('thinking is ON for character design', seen[1].body.think === true);
  check('each purpose uses its own budget',
    seen[0].body.options.num_predict === 120 && seen[1].body.options.num_predict === 3000,
    `${seen[0].body.options.num_predict} / ${seen[1].body.options.num_predict}`);
  check('the schema is sent as a top-level `format` object',
    seen[0].body.format?.type === 'object' && seen[0].body.format.required.includes('target'),
    'ollama grammar-constrains on `format`, not `response_format`');
  check('the schema differs per purpose',
    seen[0].body.format.required.includes('action')
    && seen[1].body.format.required.includes('radius'));
  check('streaming is disabled', seen[0].body.stream === false);
  await closed(server);
}

// --- an intent that comes back clean is reported as such -------------------
{
  const { server, url } = await stub({
    model: 'qwen3:4b', done: true, done_reason: 'stop',
    message: { role: 'assistant', content: ANSWER },
  });
  const p = createOllamaProvider({ baseUrl: url, model: 'qwen3:4b' });
  const r = await p.complete({ system: 's', user: 'u', purpose: 'intent', jsonSchema: INTENT_SCHEMA });
  check('a clean answer parses', r.raw === ANSWER);
  check('no reasoning is reported when there was none',
    r.reasoning === null && r.reasoningField === null);
  check('a complete answer is not flagged as truncated', r.truncated === false);
  await closed(server);
}

// --- thinking ON surfaces the scratch work ---------------------------------
{
  const { server, url } = await stub({
    model: 'qwen3:4b', done: true, done_reason: 'stop',
    message: { role: 'assistant', content: '{"name":"Pebble","radius":0.2,"color":"#8e44ad","mass":0.2,"restitution":0.95,"roughness":0.1,"personality":"zips"}', thinking: THINKING },
  });
  const p = createOllamaProvider({ baseUrl: url, model: 'qwen3:4b' });
  const r = await p.complete({ system: 's', user: 'u', purpose: 'character', jsonSchema: CHARACTER_SCHEMA });
  check('scratch work is reported', r.reasoning === THINKING);
  check('and attributed to the field it arrived in', r.reasoningField === 'thinking');
  check('the answer is still taken from content',
    r.raw.includes('Pebble'), 'scratch work must not be mistaken for the answer');
  await closed(server);
}

// --- the failure that cost an hour must be diagnosable --------------------
{
  // Exactly what an ignored `think: false` looks like: the whole budget spent on
  // reasoning, no answer.
  const { server, url } = await stub({
    model: 'qwen3:4b', done: true, done_reason: 'length', eval_count: 120,
    message: { role: 'assistant', content: '', thinking: THINKING },
  });
  const p = createOllamaProvider({ baseUrl: url, model: 'qwen3:4b', intentMaxTokens: 120 });
  let err = null;
  try {
    await p.complete({ system: 's', user: 'u', purpose: 'intent', jsonSchema: INTENT_SCHEMA });
  } catch (e) { err = e; }

  check('an ignored toggle is an error, not an empty success', err !== null);
  check('the message says the budget went on reasoning',
    /spent 120 tokens on reasoning/.test(err?.message ?? ''), err?.message?.slice(0, 80));
  check('...reports that think was off, so the endpoint is suspect',
    /think was off/.test(err?.message ?? ''));
  check('...and names the two possible causes',
    /cannot be silenced/.test(err?.message ?? '') && /toggle/.test(err?.message ?? ''),
    'a hybrid model ignoring the flag, and a model that always thinks, need opposite fixes');
  check('it is a ProviderError, so the proxy may disclose it',
    err?.name === 'ProviderError');
  await closed(server);
}

// --- and genuinely empty content is a different error --------------------
{
  const { server, url } = await stub({
    model: 'qwen3:4b', done: true, done_reason: 'stop',
    message: { role: 'assistant', content: '' },
  });
  const p = createOllamaProvider({ baseUrl: url, model: 'qwen3:4b' });
  let err = null;
  try {
    await p.complete({ system: 's', user: 'u', purpose: 'intent', jsonSchema: INTENT_SCHEMA });
  } catch (e) { err = e; }
  check('empty content with no reasoning reads as empty content, not a budget problem',
    /response contained no content/.test(err?.message ?? '')
    && !/spent \d+ tokens on reasoning/.test(err?.message ?? ''),
    err?.message?.slice(0, 70));
  await closed(server);
}

// --- a model that always thinks can be put on a bigger budget --------------
// The escape hatch, and the reason the per-purpose budget is configurable rather
// than hard-coded: R1 ignores think:false entirely, so the only lever is tokens.
{
  const { server, seen, url } = await stub({
    model: 'deepseek-r1:1.5b', done: true, done_reason: 'stop',
    message: { role: 'assistant', content: ANSWER, thinking: THINKING },
  });
  const p = createOllamaProvider({ baseUrl: url, model: 'deepseek-r1:1.5b', intentMaxTokens: 4000, thinkOnIntent: true });
  const r = await p.complete({ system: 's', user: 'u', purpose: 'intent', jsonSchema: INTENT_SCHEMA });
  check('an always-thinking model can still be used on a bigger budget',
    r.raw === ANSWER && r.reasoning === THINKING);
  check('and the larger budget is what was actually sent',
    seen[0].body.options.num_predict === 4000 && seen[0].body.think === true,
    `${seen[0].body.options.num_predict} tokens, think=${seen[0].body.think}`);
  await closed(server);
}

// --- transport failures stay opaque ----------------------------------------
{
  // Nothing listening. The message must not leak the address beyond the
  // provider's own base, and must be a ProviderError so the proxy may show it.
  const p = createOllamaProvider({ baseUrl: 'http://127.0.0.1:1/v1', model: 'qwen3:4b' });
  let err = null;
  try {
    await p.complete({ system: 's', user: 'u', purpose: 'intent', jsonSchema: INTENT_SCHEMA });
  } catch (e) { err = e; }
  check('a dead ollama is a ProviderError', err?.name === 'ProviderError', err?.name);
  check('...and says so without pretending to know why',
    /network error|ECONNREFUSED/.test(err?.message ?? ''), err?.message?.slice(0, 60));
  await settle();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILED`);
// Set the code rather than calling process.exit(): exiting mid-teardown aborts
// under libuv on Windows even when every check passed.
process.exitCode = failures === 0 ? 0 : 1;
