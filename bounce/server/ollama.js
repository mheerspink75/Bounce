/**
 * Ollama's native `/api/chat`, which is the only place a thinking-mode toggle
 * actually works.
 *
 * ## Why this exists
 *
 * The project's intent path assumes the *first* thing a model emits is the
 * answer. That is what makes a 120-token budget possible, and it is why a ≤2B
 * model is viable at all. A reasoning model breaks it: the scratch work comes
 * first and has to be paid for in full, so a 120-token intent budget is consumed
 * entirely by thinking and the answer never arrives. Measured on
 * `deepseek-r1:1.5b`, `content` came back as an empty string with
 * `finish_reason: 'length'` — 120 tokens of reasoning, no JSON.
 *
 * The first conclusion drawn was that reasoning models are simply incompatible
 * here. That was wrong, and the reason it was wrong is this file.
 *
 * **`think: false` is silently ignored on Ollama's OpenAI-compat `/v1` endpoint,
 * and honoured on `/api/chat`.** Verified on `qwen3:4b`, where the identical
 * request gave:
 *
 *   /v1/chat/completions  think:false   507 chars of reasoning, content: ''
 *   /api/chat            think:false   0 chars of reasoning,  0.63s, done=stop
 *
 * The `/v1` result is byte-for-byte the R1 symptom, which is how a model got
 * blamed for an endpoint's behaviour. Both were measured on the same box, the
 * same day, by the same script.
 *
 * ## What the toggle does and does not solve
 *
 * It works for *hybrid* models — those with a reasoning mode that can be turned
 * off. `qwen3` is one. It does not work for models that always think: R1 emitted
 * 484 characters of scratch work through `/api/chat` with `think: false` anyway.
 * That is the whole distinction, and it is the one that matters — a model that
 * can be told not to think fits the intent budget, and one that cannot, does not
 * at any budget this project can afford.
 *
 * ## Measured, qwen3:4b, 100% GPU on a GTX 1080 Ti
 *
 *   think:false, 120 tokens,  schema   0.63s   0 chars     JSON, done=stop
 *   think:true,  1500 tokens, schema   13.6s   2708 chars   JSON, done=stop
 *
 * One model, both jobs, no second download. And at 2.5GB it fits in VRAM
 * outright, unlike the 13GB gpt-oss:20b which had to be split across GPU and
 * system RAM and paged in on every request (3m35s cold, 15.9s resident).
 *
 * ## The schema is not optional here
 *
 * `think: false` at 1500 tokens *without* a schema produced 23 seconds of prose
 * — "We are creating a 3D toy character. We need to have the following fields…"
 * — and never emitted JSON. The grammar is what makes the cheap mode honest. It is
 * the same finding as the "small models need constrained decoding" claim, seen
 * from the other side: with the schema the model answers in 0.63s, without it the
 * same model rambles until the budget runs out.
 */
import { ProviderError } from './errors.js';

/** Split the configured base URL back to the server root, dropping any `/v1`. */
function serverRoot(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * @param {object}  opts
 * @param {string}  opts.baseUrl        e.g. http://127.0.0.1:11435/v1
 * @param {string}  opts.model
 * @param {string} [opts.intentModel]   defaults to `model` — one model, two modes
 * @param {number} [opts.intentMaxTokens]  budget with thinking OFF
 * @param {number} [opts.characterMaxTokens] budget with thinking ON
 * @param {boolean}[opts.thinkOnIntent]  leave off; exposed so a model that cannot
 *                                       be silenced can be detected rather than
 *                                       silently returning empty content forever
 */
export function createOllamaProvider({
  baseUrl,
  model,
  intentModel,
  intentMaxTokens = 120,
  characterMaxTokens = 1500,
  thinkOnIntent = false,
  intentTimeoutMs = 45_000,
  timeoutMs = 300_000,
} = {}) {
  if (!baseUrl || !model) {
    throw new Error('provider "ollama" needs baseUrl and model');
  }

  const root = serverRoot(baseUrl);

  return {
    name: 'ollama',
    needsKey: false,

    async complete({ system, user, purpose = 'character', jsonSchema, signal }) {
      const useIntent = purpose === 'intent';
      const chosen = (useIntent && intentModel) || model;

      // Thinking is on for design and off for steering. The asymmetry is the whole
      // point: a character is designed once per maze and can afford to think
      // about it, while an intent is polled every 2s and cannot.
      const think = useIntent ? thinkOnIntent : true;
      const numPredict = useIntent ? intentMaxTokens : characterMaxTokens;
      const limit = (useIntent && intentTimeoutMs) || timeoutMs;

      const timeout = AbortSignal.timeout(limit);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      const body = {
        model: chosen,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        think,
        options: { num_predict: numPredict, temperature: 0.9 },
      };

      // Ollama takes the schema as a top-level `format` object, not as
      // `response_format`. The JSON-schema form is grammar-constrained at the
      // token level; the bare-string form is only prompt-level JSON mode.
      if (jsonSchema) body.format = jsonSchema;

      const startedAt = Date.now();
      let res;
      try {
        res = await fetch(`${root}/api/chat`, {
          method: 'POST',
          signal: combined,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        const reason = combined.aborted
          ? `request timed out after ${Math.round(limit / 1000)}s`
          : 'network error contacting ollama';
        throw new ProviderError(`ollama: ${reason}`);
      }

      if (!res.ok) {
        throw new ProviderError(`ollama: HTTP ${res.status}`);
      }

      let data;
      try {
        data = await res.json();
      } catch {
        throw new ProviderError('ollama: response was not JSON');
      }

      const message = data?.message ?? {};
      const raw = message?.content;

      // Distinguish the two failures that look identical from here, because they
      // have opposite fixes and the difference is the whole reason this adapter
      // exists. `done: length` with empty content means the budget was spent on
      // reasoning — either `think` was ignored, or the model cannot be silenced.
      if (typeof raw !== 'string' || !raw.trim()) {
        const thought = typeof message?.thinking === 'string' ? message.thinking.length : 0;
        if (data?.done_reason === 'length' && thought > 0) {
          throw new ProviderError(
            `ollama: spent ${numPredict} tokens on reasoning and returned no answer `
            + `(think was ${think ? 'on' : 'off'}, ${thought} chars of scratch work). `
            + 'A hybrid model ignores think:false on some endpoints, and a model that '
            + 'always thinks cannot be silenced at all — raise the budget, or use a '
            + 'model with a working thinking-mode toggle.',
          );
        }
        throw new ProviderError('ollama: response contained no content');
      }

      const thinking = typeof message?.thinking === 'string' && message.thinking.trim()
        ? message.thinking
        : null;

      return {
        raw,
        // Reported under the same name every other provider uses, so the panel
        // needs to know nothing about which endpoint produced it. `thinking` is
        // Ollama's spelling; the adapter in providers.js already normalises it.
        reasoning: thinking,
        reasoningField: thinking ? 'thinking' : null,
        model: data?.model ?? chosen,
        latencyMs: Date.now() - startedAt,
        reasoningTokens: 0,
        // Whether the model used the whole budget, which is the symptom of a
        // budget that is too small for the job rather than a slow model.
        truncated: data?.done_reason === 'length',
      };
    },
  };
}
