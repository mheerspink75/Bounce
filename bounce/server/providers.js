/**
 * Provider adapters.
 *
 * Every provider returns the *raw* model text. Turning that into a spec is the
 * extractor's job, not the provider's, so messy-output handling is written and
 * tested once rather than per provider.
 *
 * Provider interface:
 *   { name, needsKey, async complete({ system, user, signal }) -> { raw, model } }
 *
 * The mock provider exists so the whole step-3 path is testable with no API key
 * and no network. It deliberately returns three different response shapes —
 * clean JSON, fenced JSON, and JSON wrapped in prose — so the default no-key
 * experience already exercises the messy paths rather than hiding them.
 */
import { INTENTS } from './extract.js';
import { ProviderError } from './errors.js';
import { createOllamaProvider } from './ollama.js';

/**
 * An error whose message is safe to show a client.
 *
 * The proxy only surfaces messages from this class and redacts anything
 * key-shaped on the way out. A plain `Error` thrown from a provider is treated
 * as opaque, because an adapter bug must not be able to leak a credential into
 * an HTTP response.
 *
 * Defined in `./errors.js` and re-exported here, so the import list of every
 * existing caller keeps working while `ollama.js` can use it without a cycle.
 */
export { ProviderError } from './errors.js';

// --- mock -----------------------------------------------------------------

/** Canned "model outputs", each a different realistic response shape. */
const MOCK_RESPONSES = [
  // Clean JSON.
  `{"name":"Cobalt","radius":0.55,"color":"#3f7fd6","mass":1.0,"restitution":0.78,"roughness":0.4,"personality":"calm and deliberate"}`,

  // Fenced in a markdown block, as many models do.
  'Here is a character you might enjoy:\n\n```json\n'
  + '{"name":"Ember","radius":0.9,"color":"#e2622b","mass":1.8,"restitution":0.6,"roughness":0.7,'
  + '"personality":"warm but volatile"}\n```\n\nLet me know if you want another.',

  // Prose before and after, with a brace inside a string value — the case a
  // naive regex gets wrong.
  'Sure! {"name":"Brace{y}","radius":0.4,"color":"#7fd6a0","mass":0.6,"restitution":0.9,'
  + '"roughness":0.2,"personality":"playful {not really}"} Hope that helps!',
];

export function createMockProvider() {
  let i = 0;
  return {
    name: 'mock',
    needsKey: false,
    async complete({ purpose, world } = {}) {
      const shape = MOCK_RESPONSES[i % MOCK_RESPONSES.length];
      i += 1;

      // Keyed on `purpose`, which is what every caller actually sends.
      //
      // This was an `intent = false` flag that nothing ever set, so the mock
      // answered every intent request with a *character spec*. `sanitizeIntent`
      // then rejected the unknown action and the brain silently got `wander`,
      // every time — which is why the offline tests and the no-key demo had a
      // character that meandered and never chose anything.
      if (purpose === 'intent') {
        // Play the game rather than flailing. Without this the no-key experience
        // never completes a maze: the character wanders, the reward is never
        // collected, and the entire loop is invisible to anyone who has not set
        // up an API key — which is most people, and the default.
        //
        // Mostly-goal rather than always-goal, so the demo still looks like a
        // decision-maker and not a script.
        const goal = world?.goal;
        if (goal && !goal.reached && i % 4 !== 0) {
          return {
            raw: '{"action":"charge_target","target":"goal","intensity":1,"duration_s":8}',
            model: 'mock',
          };
        }
        return {
          raw: `{"action":"${INTENTS[i % INTENTS.length]}","target":"block_a","intensity":0.6,"duration_s":3}`,
          model: 'mock',
        };
      }
      return { raw: shape, model: 'mock' };
    },
  };
}

// --- OpenAI-compatible (NVIDIA NIM, OpenRouter, anything else) -------------

/**
 * Both NVIDIA NIM and OpenRouter expose an OpenAI-compatible
 * `POST {baseUrl}/chat/completions`. They differ only in base URL, headers, and
 * model id, so one adapter covers both.
 */
export function createOpenAICompatibleProvider({
  name,
  baseUrl,
  apiKey,
  model,
  intentModel,
  extraHeaders = {},
  timeoutMs = 30_000,
  intentTimeoutMs,
  // Local runtimes can enforce a JSON schema at the token level; hosted APIs
  // generally cannot, and asking them to just produces a 400.
  supportsSchema = false,
}) {
  if (!baseUrl || !apiKey) {
    throw new Error(`provider "${name}" needs baseUrl${name === 'local' ? '' : ' and apiKey'}`);
  }

  return {
    name,
    needsKey: name !== 'local' && name !== 'ollama',

    /**
     * `purpose` selects the model and timeout. The two jobs have opposite
     * requirements and should not be forced to share one setting:
     *
     *   'character' — once per session, a slow answer is fine
     *   'intent'    — continuous control, so latency is the whole cost
     *
     * Measured on the NIM free tier 2026-09-26: the same model answered in
     * 14-58s (median 37s) with 45s between calls. That is fine for a character
     * you ask for once, and useless for a 2s control loop.
     */
    async complete({ system, user, purpose = 'character', jsonSchema, signal }) {
      const useIntent = purpose === 'intent';
      const chosen = (useIntent && intentModel) || model;
      const limit = (useIntent && intentTimeoutMs) || timeoutMs;

      // Compose the caller's signal with our own timeout, so a hung provider
      // cannot hold the request open indefinitely.
      const timeout = AbortSignal.timeout(limit);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      const body = {
        model: chosen,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.9,
        // Intents are a tiny object; a character spec needs more room. Not the
        // main cost, but free.
        max_tokens: useIntent ? 120 : 400,
      };

      // Schema-constrained decoding. Where the provider supports it this makes
      // malformed output structurally impossible rather than merely unlikely,
      // which is what allows a small local model to be usable at all. Providers
      // that ignore it simply fall back to prompt-only behaviour plus the
      // sanitiser, so sending it is always safe.
      if (jsonSchema && supportsSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: purpose, strict: true, schema: jsonSchema },
        };
      }

      const startedAt = Date.now();
      let res;
      try {
        res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          signal: combined,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            ...extraHeaders,
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        // Never let a raw fetch error carry provider detail (or the key) out.
        const reason = err?.name === 'TimeoutError' || combined.aborted
          ? `request timed out after ${Math.round(limit / 1000)}s`
          : 'network error contacting provider';
        throw new ProviderError(`${name}: ${reason}`);
      }

      if (!res.ok) {
        // Status only. The body may echo request headers or other detail.
        throw new ProviderError(`${name}: HTTP ${res.status}`);
      }

      let data;
      try {
        data = await res.json();
      } catch {
        throw new ProviderError(`${name}: response was not JSON`);
      }

      // Reasoning models put the answer in `content` and their scratch work in
      // `reasoning_content`. We want `content` — reading the wrong one is how a
      // model appears to emit prose instead of JSON.
      const message = data?.choices?.[0]?.message;
      const raw = message?.content;
      if (typeof raw !== 'string' || !raw.trim()) {
        throw new ProviderError(`${name}: response contained no content`);
      }

      // Scratch work, under whichever name this provider uses for it.
      //
      // There is no standard field, and reading the wrong one is the failure mode
      // that matters: a reasoning model then appears to emit prose instead of
      // JSON, or the panel shows an empty box while the model was demonstrably
      // thinking. Measured against Ollama serving gpt-oss:20b, the field is
      // `reasoning` (verified populated). `reasoning_content` is the name DeepSeek
      // and some hosted APIs use, and `thinking` is Ollama's own native API.
      // Read all three and take the first that has content, rather than betting on
      // one spelling and showing nothing on the others.
      //
      // Read from `message` *and* the choice itself. Ollama puts `reasoning` on
      // the message; some gateways hoist it to the choice. Checking one level
      // costs a line and saves an adapter that silently reports no reasoning.
      const REASONING_FIELDS = ['reasoning', 'reasoning_content', 'thinking'];
      const choice = data?.choices?.[0];
      const reasoningField = REASONING_FIELDS.find((k) => {
        const v = message?.[k] ?? choice?.[k];
        return typeof v === 'string' && v.trim();
      });
      const reasoning = reasoningField
        ? (message?.[reasoningField] ?? choice?.[reasoningField])
        : null;

      return {
        raw,
        reasoning: reasoning ?? null,
        // Which spelling answered, so the panel can say so. `null` for a model
        // that does not publish scratch work at all, which is most of them.
        reasoningField: reasoningField ?? null,
        model: data?.model ?? chosen,
        latencyMs: Date.now() - startedAt,
        // Ollama reports reasoning tokens under `completion_tokens_details`;
        // other providers put them at the top level. Sum whichever is present
        // rather than reading one and reporting 0 for everything else.
        reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens
          ?? data?.usage?.reasoning_tokens
          ?? 0,
      };
    },
  };
}

// --- selection ------------------------------------------------------------

/**
 * Pick a provider from the environment.
 *
 * Falls back to mock when no key is configured, so `npm start` works out of the
 * box. Explicitly requesting a keyed provider without a key is an error rather
 * than a silent downgrade — a silent fallback would hide a broken deployment.
 */
export function createProviderFromEnv(env = process.env) {
  // Infer the provider from whichever key is present. Without this, dropping a
  // key into .env and forgetting LLM_PROVIDER would silently keep using the
  // mock provider — the most confusing possible outcome, because everything
  // appears to work and the model is never actually called.
  const declared = env.LLM_PROVIDER?.toLowerCase();
  const inferred = !declared
    ? (env.NIM_API_KEY ? 'nim' : (env.OPENROUTER_API_KEY ? 'openrouter' : 'mock'))
    : declared;

  if (inferred === 'mock') {
    // A key that is present but unread is the most likely cause of a confusing
    // "why is it still fake?" report. Say so rather than failing silently.
    if (env.NIM_API_KEY || env.OPENROUTER_API_KEY) {
      console.warn('warning: an API key is set but LLM_PROVIDER selected the mock provider.');
    }
    return createMockProvider();
  }

  // `ollama` is `local` with one important difference: it speaks Ollama's native
  // API, which is the only place `think: false` is honoured. On the
  // OpenAI-compat endpoint the flag is silently ignored, a hybrid model burns the
  // whole intent budget on scratch work, and returns empty content — which reads
  // exactly like a model that is incapable of being quiet. See server/ollama.js.
  if (inferred === 'ollama') {
    return createOllamaProvider({
      baseUrl: env.LOCAL_BASE_URL ?? 'http://127.0.0.1:11434/v1',
      model: env.LOCAL_MODEL ?? 'qwen3:4b',
      intentModel: env.LOCAL_INTENT_MODEL,
      intentMaxTokens: Number(env.LOCAL_INTENT_MAX_TOKENS) || 120,
      characterMaxTokens: Number(env.LOCAL_CHARACTER_MAX_TOKENS) || 1500,
      // Off by default. A model that cannot be silenced belongs on a larger
      // budget, not in a 2s control loop; this flag exists so that is a
      // deliberate, testable choice rather than an accident.
      thinkOnIntent: env.LOCAL_THINK_ON_INTENT === '1',
      timeoutMs: Number(env.LOCAL_TIMEOUT_MS) || 300_000,
      intentTimeoutMs: Number(env.LOCAL_INTENT_TIMEOUT_MS) || 45_000,
    });
  }

  // `local` needs no credential, so it is handled before the keyed branches.
  if (inferred === 'local') {
    return createOpenAICompatibleProvider({
      name: 'local',
      baseUrl: env.LOCAL_BASE_URL ?? 'http://127.0.0.1:8081/v1',
      // llama.cpp ignores the key, but the OpenAI request shape wants the header.
      apiKey: env.LOCAL_API_KEY ?? 'local-no-key',
      model: env.LOCAL_MODEL ?? 'local-model',
      intentModel: env.LOCAL_INTENT_MODEL,
      supportsSchema: true,
      // Local CPU inference is not instant. Generous, but still bounded.
      timeoutMs: Number(env.LOCAL_TIMEOUT_MS) || 180_000,
      intentTimeoutMs: Number(env.LOCAL_INTENT_TIMEOUT_MS) || 45_000,
    });
  }

  // Validate the name before looking for a key. Otherwise a typo'd provider
  // reports "no API key found", which sends you looking in the wrong place.
  if (inferred !== 'nim' && inferred !== 'openrouter') {
    throw new Error(
      `unknown LLM_PROVIDER "${inferred}" (expected mock, nim, openrouter, or local)`,
    );
  }

  const requested = inferred;

  const key = requested === 'nim' ? env.NIM_API_KEY : env.OPENROUTER_API_KEY;
  const baseUrl = requested === 'nim'
    ? env.NIM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1'
    : env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';

  if (!key) {
    throw new Error(
      `LLM_PROVIDER=${requested} but no API key found `
      + `(${requested === 'nim' ? 'NIM_API_KEY' : 'OPENROUTER_API_KEY'}). `
      + 'Set it in .env, or use LLM_PROVIDER=mock.',
    );
  }

  if (requested === 'nim') {
    return createOpenAICompatibleProvider({
      name: 'nim',
      baseUrl,
      apiKey: key,
      // Measured against the live free tier 2026-09-26 (scripts/bench-models.mjs,
      // scripts/latency-probe.mjs):
      //   deepseek-ai/deepseek-v4.1-flash   parses; 14-58s (median 37s)  <- default
      //   z-ai/glm-5.3-flash                parses; 18-35s
      //   nvidia/nemotron-3.5-lightning-…   7-11s but emits a reasoning trace, not JSON
      //   meta/llama-3.1-8b-instruct        HTTP 410 Gone (retired from the catalogue)
      // Most ids in /v1/models also return 404 despite being listed, so the
      // catalogue is not a reliable guide to what is actually servable.
      model: env.NIM_MODEL ?? 'deepseek-ai/deepseek-v4.1-flash',
      // Set NIM_INTENT_MODEL to a cheaper/faster model if you find one that
      // both parses and answers quickly. Same model by default.
      intentModel: env.NIM_INTENT_MODEL,
      // A 30s default was measured as too short: the median real call is 37s.
      // Character design is once-per-session so a long wait is acceptable; the
      // intent loop should get a shorter budget so it fails fast and falls back
      // to wandering rather than leaving the character waiting.
      timeoutMs: Number(env.NIM_TIMEOUT_MS) || 120_000,
      intentTimeoutMs: Number(env.NIM_INTENT_TIMEOUT_MS) || 20_000,
    });
  }

  return createOpenAICompatibleProvider({
    name: 'openrouter',
    baseUrl,
    apiKey: key,
    model: env.OPENROUTER_MODEL ?? 'meta-llama/llama-3.1-8b-instruct:free',
    intentModel: env.OPENROUTER_INTENT_MODEL,
    timeoutMs: Number(env.OPENROUTER_TIMEOUT_MS) || 60_000,
    intentTimeoutMs: Number(env.OPENROUTER_INTENT_TIMEOUT_MS) || 20_000,
    // OpenRouter asks for these to identify the app. Not credentials.
    extraHeaders: {
      'HTTP-Referer': env.ALLOWED_ORIGIN ?? 'http://localhost:8080',
      'X-Title': 'bounce',
    },
  });
}
