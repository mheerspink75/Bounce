/**
 * The proxy: the only place an API key exists.
 *
 * The browser never sees a key. It asks this server for a character, the server
 * asks the model, and the server sanitises the result before sending anything
 * back. If this file is compromised the key is exposed; if the browser is
 * compromised, it is not.
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createProviderFromEnv, ProviderError } from './providers.js';
import { extractJsonObject } from './extract.js';
import { sanitizeIntent, FALLBACK_INTENT, INTENTS } from '../public/intent.js';
import { sanitizeSpec, DEFAULT_SPEC, LIMITS } from '../public/spec.js';
import { SCHEMAS } from '../public/schema.js';
import { TARGET_IDS } from '../public/targets.js';

const DEFAULT_ORIGIN = 'http://localhost:8080';
const DEFAULT_PORT = 8787;

const CHARACTER_SYSTEM = `You design characters for a small 3D physics toy that runs in a web browser.

Reply with ONE JSON object and nothing else. No prose, no markdown, no code fence.

Fields:
  name        string, 1-60 chars, no emoji
  radius      number, ${LIMITS.radius.min}-${LIMITS.radius.max}
  color       string, hex "#rrggbb"
  mass        number, ${LIMITS.mass.min}-${LIMITS.mass.max}
  restitution number, ${LIMITS.restitution.min}-${LIMITS.restitution.max}
  roughness   number, ${LIMITS.roughness.min}-${LIMITS.roughness.max}
  personality string, one short sentence describing how it moves

Be creative and vary the values. restitution near ${LIMITS.restitution.max} means very bouncy; near 0 means dead.`;

/**
 * @param {object}  opts
 * @param {object} [opts.provider]  defaults to one chosen from the environment
 * @param {object} [opts.limiter]   defaults to a 30-per-minute sliding window
 */
export function createProxy({
  provider = createProviderFromEnv(),
  // The two endpoints have genuinely different profiles, and one shared budget
  // does not work.
  //
  // `/api/intent` is the control loop: the brain polls it every 2s, which is
  // 30 requests a minute — the entire old budget, leaving nothing for anything
  // else. `/api/character` is once per maze generation, and it is the expensive
  // one: a full model call that spends the key.
  //
  // So: intents get headroom, characters stay tight. Measured after this split,
  // a three-maze loop stopped reporting "rate limited" on new characters.
  intentLimiter = createLimiter(120, 60_000),
  characterLimiter = createLimiter(12, 60_000),
} = {}) {
  // A *set* of origins, not one string.
  //
  // It was a single value, which made the guard a footgun rather than a defence:
  // the page, the proxy and the model were all on the same machine, and opening
  // the page at `127.0.0.1:8080` instead of `localhost:8080` got every request
  // refused with a bare "origin not allowed". The HUD showed `provider offline`
  // and `brain error` with no reason, which reads as a dead proxy rather than a
  // string comparison.
  //
  // The security property is unchanged and still the point: a *foreign* origin is
  // refused, so a page the user visits cannot POST to localhost and spend the key.
  // ALLOWED_ORIGIN accepts a comma-separated list for the addresses that are
  // genuinely the same machine.
  const allowedOrigins = new Set(
    (process.env.ALLOWED_ORIGIN ?? DEFAULT_ORIGIN)
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  );

  /** True for an origin we serve, false for a foreign one. */
  const originAllowed = (origin) => !origin || allowedOrigins.has(origin);

  /**
   * The `access-control-allow-origin` value to send back.
   *
   * It has to echo the *request's* origin, not a fixed string: with more than one
   * allowed origin, a fixed header would be wrong for all but one of them, and
   * the browser would reject the response.
   */
  const corsOrigin = (origin) => (
    (origin && allowedOrigins.has(origin) ? origin : null)
    ?? allowedOrigins.values().next().value
    ?? DEFAULT_ORIGIN
  );

  /**
   * A hand-pushed intent that takes priority over the model until it expires.
   *
   * This is what lets an agent (or a human, or a test) steer the character
   * directly. The brain in the browser is unchanged — it still polls
   * `/api/intent` — so nothing needs to know the difference. Useful here because
   * the available model providers are all far too slow to steer with
   * interactively (see README §10).
   */
  let override = null;

  return createServer(async (req, res) => {
    res.on('error', () => {});   // a dropped client must not crash the process

    const origin = req.headers.origin;
    const path = (req.url ?? '/').split('?')[0];

    // The CORS header value for this request. Computed once and threaded through,
    // because it is derived from the request's own origin.
    const cors = corsOrigin(origin);

    if (req.method === 'GET' && path === '/api/health') {
      // Reports readiness, never the key itself.
      return json(res, 200, {
        ok: true,
        provider: provider.name,
        hasKey: provider.needsKey,
        override_active: override !== null,
      }, cors);
    }

    // The page is served from a different port than the proxy, so a JSON POST
    // triggers a CORS preflight. Answer it before the origin check — the
    // preflight itself carries no credentials.
    if (req.method === 'OPTIONS') {
      res.writeHead(originAllowed(origin) ? 204 : 403, {
        'access-control-allow-origin': cors,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      });
      return res.end();
    }

    // A missing Origin header is allowed: that is curl or a test, not a
    // webpage. Browsers always send Origin on a cross-origin POST, which is
    // exactly the case this blocks — any site the user visits could otherwise
    // POST to localhost and spend the key.
    //
    // The rejection names the offending origin and the variable to set. A bare
    // "origin not allowed" is indistinguishable from a dead proxy, and this is
    // the single most common way to get here: the page, the proxy and the model
    // are all on one machine, so the only thing that can differ is which of
    // localhost / 127.0.0.1 / the WSL address the page was opened at.
    if (!originAllowed(origin)) {
      return json(res, 403, {
        error: 'origin not allowed',
        detail: `page origin ${origin} is not in ALLOWED_ORIGIN `
          + `(${[...allowedOrigins].join(', ')}). Open the page at one of those, `
          + 'or add this origin to ALLOWED_ORIGIN in bounce/.env and restart the proxy.',
      }, cors);
    }

    // The manual channel is the one route that accepts DELETE as well as POST.
    // It shares the intent budget: it is the same hot path, and it is what
    // makes a slow provider irrelevant.
    if (path === '/api/intent/manual' && (req.method === 'POST' || req.method === 'DELETE')) {
      if (!intentLimiter.take(req.socket.remoteAddress ?? 'unknown')) {
        return json(res, 429, { error: 'rate limited' }, cors);
      }
      return handleManualIntent(req, res, cors, override, (i) => { override = i; });
    }

    if (req.method !== 'POST' || !path.startsWith('/api/')) {
      return json(res, 404, { error: 'not found' }, cors);
    }

    if (path === '/api/character') {
      if (!characterLimiter.take(req.socket.remoteAddress ?? 'unknown')) {
        return json(res, 429, { error: 'rate limited' }, cors);
      }
      return handleCharacter(provider, res, cors);
    }

    if (path === '/api/intent') {
      if (!intentLimiter.take(req.socket.remoteAddress ?? 'unknown')) {
        return json(res, 429, { error: 'rate limited' }, cors);
      }
      const { ok, body } = await readJsonBody(req, res, cors);
      if (!ok) return undefined;
      return handleIntent(provider, res, cors, () => takeOverride(), body);
    }

    return json(res, 404, { error: 'not found' }, cors);
  });

  /**
   * Returns the live override with its remaining time, or null if absent/expired.
   *
   * The remaining time is returned as well as the intent because the caller has
   * to report a `duration_s` that actually spans until the next poll — see
   * `handleIntent`.
   */
  function takeOverride() {
    if (!override) return null;
    if (override.expiresAt <= Date.now()) { override = null; return null; }
    return { intent: override.intent, remainingS: (override.expiresAt - Date.now()) / 1000 };
  }
}

/**
 * Manual intent channel. `POST` sets an override, `DELETE` clears it.
 *
 * Sanitised exactly like a model response — a hand-pushed intent gets no more
 * trust than a generated one, because the point of the sanitiser is that
 * nothing downstream has to care where a value came from.
 */
/**
 * Read and parse a JSON request body, with a size cap.
 *
 * Shared by the two POST endpoints so the limit is enforced in one place — a
 * duplicated guard is a guard that eventually differs.
 *
 * Returns `{ ok: false }` after responding, so callers can just `return`.
 */
async function readJsonBody(req, res, cors) {
  const chunks = [];
  try {
    for await (const chunk of req) {
      chunks.push(chunk);
      // Guard against an unbounded body from a local client.
      if (chunks.reduce((n, c) => n + c.length, 0) > 8 * 1024) {
        json(res, 413, { error: 'body too large' }, cors);
        return { ok: false };
      }
    }
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') };
  } catch {
    json(res, 400, { error: 'invalid JSON body' }, cors);
    return { ok: false };
  }
}

async function handleManualIntent(req, res, cors, current, set) {
  if (req.method === 'DELETE') {
    set(null);
    return json(res, 200, { ok: true, override_active: false }, cors);
  }

  const { ok, body } = await readJsonBody(req, res, cors);
  if (!ok) return undefined;

  // Accept either a bare intent or { intent: {...}, ttl_s: n }.
  const raw = body?.intent ?? body;
  const intent = sanitizeIntent(raw);
  const ttl = Number(body?.ttl_s);
  const ttlS = Number.isFinite(ttl) ? Math.min(600, Math.max(0.5, ttl)) : 10;

  set({ intent, expiresAt: Date.now() + ttlS * 1000 });

  return json(res, 200, {
    ok: true,
    intent,
    ttl_s: ttlS,
    override_active: true,
  }, cors);
}

/** Start listening. Separate from createProxy so tests can drive the handler. */
export function start({ port = Number(process.env.PORT) || DEFAULT_PORT, ...opts } = {}) {
  // Resolve the provider before constructing the server so the startup banner
  // names the provider actually in use rather than "from env".
  const provider = opts.provider ?? createProviderFromEnv();
  const server = createProxy({ ...opts, provider });

  server.listen(port, '127.0.0.1', () => {
    console.log(`bounce proxy listening on http://127.0.0.1:${port}`);
    console.log(`  provider: ${provider.name}${provider.name === 'mock' ? '  (no API key — canned responses)' : ''}`);
    if (provider.name === 'mock') {
      console.log('  to use a real model: put a key in bounce/.env — see .env.example');
    }
  });
  return server;
}

// Only listen when run directly, so importing this file in tests is side-effect free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    start();
  } catch (err) {
    console.error(`failed to start: ${err.message}`);
    process.exit(1);
  }
}

async function handleCharacter(provider, res, cors) {
  try {
    const { raw, reasoning, reasoningField, model, latencyMs, reasoningTokens } = await provider.complete({
      system: CHARACTER_SYSTEM,
      user: 'Design a character.',
      purpose: 'character',
      // Providers that support it enforce this at the token level, which is
      // what makes a small local model usable. Others ignore it and fall back
      // to prompt-only plus the sanitiser.
      jsonSchema: SCHEMAS.character,
    });

    const parsed = extractJsonObject(raw);
    // A malformed response must still yield a playable character, so fall back
    // rather than erroring. `source:'fallback'` tells the UI the model was not
    // usable, which is what makes a bad prompt diagnosable instead of silent.
    const usable = parsed !== null;

    return json(res, 200, {
      spec: sanitizeSpec(usable ? parsed : DEFAULT_SPEC),
      source: usable ? model : 'fallback',
      // Reported so a slow provider is visible rather than mysterious.
      latency_ms: latencyMs ?? null,
      reasoning_tokens: reasoningTokens ?? 0,
      // The model's own words, for the thoughts panel. Redacted like any other
      // response body, and inserted as text by the page rather than as markup.
      model_said: usable ? redact(raw) : null,
      model_reasoning: reasoning ? redact(reasoning) : null,
      // Which field the scratch work came from, so the panel can attribute it
      // rather than presenting it as something the adapter invented.
      reasoning_field: reasoningField ?? null,
    }, cors);
  } catch (err) {
    // Only ProviderError messages are safe to disclose. A plain Error from an
    // adapter is treated as opaque, because an adapter bug that interpolated a
    // credential into its message would otherwise leak it into the response.
    const message = err instanceof ProviderError ? err.message : 'provider error';
    return json(res, 502, { error: redact(message) }, cors);
  }
}

/**
 * What the client reports about the world, validated.
 *
 * This is untrusted input like any other — the proxy sanitises model output
 * three times over, so accepting a client's claims unchecked would be a strange
 * exception. Ids are matched against a conservative pattern and the list is
 * capped, so a hostile or buggy page cannot inject arbitrary text into a prompt.
 *
 * The static `TARGET_IDS` are always included. The reported ones are additive,
 * because the arena obstacles exist whether or not a maze does.
 */
function readWorldReport(body) {
  const reported = Array.isArray(body?.targets) ? body.targets : [];
  const extra = reported
    .filter((t) => typeof t === 'string' && /^[a-z][a-z0-9_]{0,23}$/.test(t))
    .slice(0, 8);

  const targets = [...new Set([...TARGET_IDS, ...extra])];

  const g = body?.goal;
  const goal = g && typeof g === 'object' && typeof g.id === 'string'
    ? {
      id: g.id.slice(0, 24),
      distance_m: Number.isFinite(Number(g.distance_m)) ? Number(Number(g.distance_m).toFixed(1)) : null,
      // Reject rather than clamp. A negative path length is nonsense, and
      // clamping it to 0 would tell the model "you are at the goal" — a
      // confident lie is worse than an admitted unknown.
      path_cells: Number.isFinite(Number(g.path_cells)) && Number(g.path_cells) >= 0
        ? Math.floor(Number(g.path_cells))
        : null,
      maze: typeof g.maze === 'string' ? g.maze.slice(0, 12) : null,
      reached: g.reached === true,
    }
    : null;

  return { targets, goal };
}

/**
 * The intent prompt, built from the world as it actually is.
 *
 * A function rather than a constant because the objective is not static: `goal`
 * exists only while a maze does, and its distance changes every second. A frozen
 * prompt is how a model ends up steering a character toward a target that is not
 * there, or ignoring one that is.
 */
function intentPrompt({ targets, goal }) {
  const lines = [
    'You control a bouncing character in a small 3D toy. Reply with ONE JSON object and nothing else.',
    '',
    'Fields:',
    `  action      one of ${INTENTS.join(', ')}`,
    // No "or null" here. The schema makes `target` a required non-empty string,
    // and a prompt that offers null while the schema forbids it is a conflict
    // the smallest models resolve by picking the option that needs no decision.
    // For `wander` and `rest` the target is ignored by the brain, so naming any
    // valid id is harmless — the field is about giving the model a way to say
    // *what*, not about forcing movement.
    '  target      the id of what to head toward — always name one, see below',
    '  intensity   number, 0 to 1',
    '  duration_s  number, 1 to 5',
    '',
    `Valid target ids: ${targets.join(', ')}.`,
  ];

  if (goal && !goal.reached) {
    lines.push(
      '',
      'There is a reward at the far corner of a maze, and reaching it is the whole',
      'point of the run. `charge_target` with target "goal" is what actually gets',
      'it there — the character navigates the corridors itself, so all you owe it',
      'is the decision to go.',
    );
    if (goal.path_cells !== null) {
      lines.push(`It is currently ${goal.path_cells} corridor turns away, in a ${goal.maze ?? '?'} maze.`);
    }
    lines.push(
      '',
      'So: head for the goal. Wander or rest only once it has been reached, and',
      'prefer charge_target over seek for the same target — seek is the weaker,',
      'vaguer version of the same request.',
    );
  } else if (goal?.reached) {
    lines.push(
      '',
      'The reward has been collected and a new maze is about to start. Head for',
      'the goal again as soon as one exists.',
    );
  }

  lines.push('', 'Vary the action between calls. Do not repeat the same action every time.');
  return lines.join('\n');
}

async function handleIntent(provider, res, cors, takeOverride, body) {
  // The client describes its own world: which targets exist, and what the
  // objective is. This is the only way the prompt can mention a maze goal, since
  // the server cannot know whether the page is running a maze at all.
  const world = readWorldReport(body);

  // An active override short-circuits the model entirely. That is the whole
  // point: steering should be instant, not gated on a 20-40s provider.
  const forced = takeOverride?.();
  if (forced) {
    // Report a duration that reaches the next poll.
    //
    // The client honours an intent for `duration_s` of *simulation* time and
    // then falls back to wandering until the next request lands — and the next
    // request is ~2s away. So an override sent with a 60s ttl but a 3s
    // duration_s was only actually obeyed about half the time, and the ttl was
    // decorative. Measured: the same maze took 30s of simulated time through the
    // manual channel versus 8.1s headless, purely from this gap.
    //
    // `duration_s` is schema-bounded to 10s and the client re-polls well inside
    // that, so reporting the remaining ttl (capped) holds the override
    // continuously for its whole life.
    const held = Math.min(Math.max(forced.intent.duration_s, forced.remainingS), 10);
    return json(res, 200, {
      intent: { ...forced.intent, duration_s: held },
      targets: world.targets,
      goal: world.goal,
      source: 'manual',
      latency_ms: 0,
      override_remaining_s: Number(forced.remainingS.toFixed(1)),
    }, cors);
  }

  try {
    const { raw, reasoning, reasoningField, model, latencyMs, reasoningTokens } = await provider.complete({
      system: intentPrompt(world),
      user: world.goal && !world.goal.reached
        ? 'The character has not reached the reward yet. What should it do?'
        : 'Decide what the character should do next.',
      purpose: 'intent',
      jsonSchema: SCHEMAS.intent,
      // The structured world, not just the rendered prompt. A provider that can
      // see the state is more useful than one inferring it from prose, and the
      // mock needs it to behave like something playing the game.
      world,
    });

    const parsed = extractJsonObject(raw);
    const usable = parsed !== null;

    return json(res, 200, {
      // Sanitised again server-side. The browser sanitises a third time —
      // a response must be trusted no more than a model.
      //
      // The target is redacted on the way out. `sanitizeIntent` accepts any
      // non-empty string up to 40 characters, so a key-shaped value in a model's
      // answer reached the page verbatim. That is not exploitable today — the
      // model never sees the key, which only exists in this process — but the
      // redaction pass exists for exactly this second line of defence, and the
      // panel makes model-authored text a first-class output, so it is worth
      // closing. The brain degrades an unusable target to a wander either way, so
      // redacting it costs nothing behaviourally.
      intent: redactIntent(sanitizeIntent(usable ? parsed : FALLBACK_INTENT)),
      targets: world.targets,
      goal: world.goal,
      source: usable ? model : 'fallback',
      latency_ms: latencyMs ?? null,
      reasoning_tokens: reasoningTokens ?? 0,
      // What the model actually said, and any scratch work it published. The page
      // shows these so a decision can be read rather than inferred, and both are
      // model-authored text: they go through the same redaction as any other
      // response body, and the page inserts them as text, never as markup.
      model_said: usable ? redact(raw) : null,
      model_reasoning: reasoning ? redact(reasoning) : null,
      // Which field the scratch work came from, so the panel can attribute it
      // rather than presenting it as something the adapter invented.
      reasoning_field: reasoningField ?? null,
      // Whether the sanitiser had to change the answer. A model that keeps asking
      // for intensity 5 against a maximum of 1 is worth being able to see, and
      // `intent` alone hides it completely.
      sanitised: usable ? !sameIntent(parsed, sanitizeIntent(parsed)) : false,
    }, cors);
  } catch (err) {
    const message = err instanceof ProviderError ? err.message : 'provider error';
    return json(res, 502, { error: redact(message) }, cors);
  }
}

/**
 * Last line of defence on anything headed for a response body: strip
 * key-shaped strings. Adapters already avoid putting secrets in messages, so
 * this should never fire — it exists so that a future change cannot turn an
 * adapter mistake into a credential leak.
 */
function redact(text) {
  return String(text).replace(/\b(?:sk|nvapi|pk|key)-[A-Za-z0-9_-]{8,}/g, '[redacted]');
}

/**
 * Did sanitising change what the model asked for?
 *
 * Worth surfacing rather than keeping internal, because the most instructive
 * failure in this project was invisible in the output: a small model asked for
 * `target: null` and `intensity: 5`, the sanitiser clamped both, and the intent
 * that reached the character looked perfectly ordinary. Showing the model's own
 * words next to the applied intent is what makes that class of bug visible at all.
 */
function sameIntent(before, after) {
  if (!before || !after) return false;
  return before.action === after.action
    && (before.target ?? null) === (after.target ?? null)
    && Number(before.intensity) === after.intensity
    && Number(before.duration_s) === after.duration_s;
}

/** The sanitised intent, with any key-shaped string in the target removed. */
function redactIntent(intent) {
  if (typeof intent.target !== 'string') return intent;
  return { ...intent, target: redact(intent.target) };
}

function json(res, status, body, cors) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': cors,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Fixed-size sliding window over a Map of client -> request timestamps.
 * Prunes expired entries on access so the Map cannot grow without bound.
 */
export function createLimiter(limit, windowMs) {
  const seen = new Map();

  return {
    take(client, now = Date.now()) {
      const cutoff = now - windowMs;
      const hits = (seen.get(client) ?? []).filter((t) => t > cutoff);
      if (hits.length >= limit) {
        seen.set(client, hits);
        return false;
      }
      hits.push(now);
      seen.set(client, hits);
      return true;
    },
    get size() { return seen.size; },
  };
}
