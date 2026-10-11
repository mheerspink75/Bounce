/**
 * In-browser demo mode — the whole loop with no backend at all.
 *
 * Static hosting (GitHub Pages) can serve `public/`, but the normal path needs a
 * Node proxy on :8787 to hold the API key and to call the model. That is a
 * server, and it means a deployed demo needs a server.
 *
 * This module removes it. It answers the same three endpoints the proxy answers,
 * from a scripted stand-in for the model, so the page runs from a CDN with
 * nothing else deployed. It is what makes the live demo link work for a visitor
 * who has no key, no GPU and no Ollama.
 *
 * Two deliberate constraints:
 *
 * 1. **It is opt-in and never automatic.** `?demo=1` or nothing. It does *not*
 *    engage when the proxy is unreachable, because "the proxy is down" and "the
 *    model is scripted" must never look the same — this project's HUD exists
 *    precisely to keep those distinguishable, and a silent fallback would undo
 *    the most carefully built thing here.
 * 2. **Output still goes through the real sanitisers.** `sanitizeSpec` and
 *    `sanitizeIntent` are imported from the same modules the live path uses, so
 *    the demo exercises the validation path rather than skipping it.
 */
import { sanitizeSpec } from './spec.js';
import { sanitizeIntent } from './intent.js';
import { nextCharacter, nextIntent } from './personality.js';

/**
 * Whether the page is running on demo mode.
 *
 * Precedence, highest first:
 *
 * 1. `?demo=1` — force on. The original, explicit switch.
 * 2. `?demo=0` — force **off**, even on Pages. This is the escape hatch: someone
 *    pointing the deployed site at a real proxy needs to be able to say so, and
 *    a URL flag that only turns things on cannot express that.
 * 3. A `*.github.io` host — on by default.
 * 4. Anywhere else — off. A local `?proxy=` still gets the real path.
 *
 * Rule 3 is what makes `https://mheerspink75.github.io/Bounce` work when someone
 * pastes it, with no query string and nothing installed. Rule 4 is what stops
 * that from leaking into development: on localhost the proxy is either running
 * or it is not, and a silent fallback to a scripted character would make the two
 * look identical.
 *
 * That distinction is the reason `demo` is exported and surfaced in the banner.
 * Demo mode must never be something a visitor has to guess about — the moment a
 * static page can quietly impersonate a live model, the honesty this project is
 * built on is gone. So it announces itself, loudly and always.
 */
const params = new URLSearchParams(location.search);
const flag = params.get('demo');
const onPages = /\.github\.io$/i.test(location.hostname);

export const isDemo = flag === '1' || (flag !== '0' && onPages);

/** How demo mode was decided — reported in the banner so it is never a mystery. */
export const demoReason = flag === '1' ? 'forced by ?demo=1'
  : flag === '0' ? 'disabled by ?demo=0'
    : onPages ? 'static hosting (github.io)'
      : 'not requested';

/** Provider id reported to the page. Deliberately not a real model name. */
const SOURCE = 'demo';

/**
 * A small latency, because the brain paces itself from wall-clock completion and
 * a zero-delay provider would make that pacing untestable. Kept low so a visitor
 * does not sit through artificial waiting.
 */
const SIMULATED_LATENCY_MS = 220;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scripted characters and steering live in `personality.js` — a pure module, so
 * the choices can be unit-tested without a DOM, a query string or a timer. This
 * file stays the adapter: it adds latency and runs the result through the real
 * sanitisers.
 */

let characterIndex = 0;
let intentIndex = 0;
/** The personality currently driving, so intents stay consistent with the body. */
let activePersonalityId = null;
/**
 * Seed for the personality engine. Taken from the page's own `seed` so a shared
 * URL reproduces the same characters *and* the same steering, not just the same
 * maze.
 */
const seed = Number(new URLSearchParams(location.search).get('seed')) || 1;

export async function fetchHealth() {
  await sleep(0);
  return {
    ok: true,
    provider: SOURCE,
    hasKey: false,
    override_active: false,
    demo: true,
    reason: demoReason,
  };
}

export async function fetchCharacter() {
  await sleep(SIMULATED_LATENCY_MS * 4);
  const { personality, spec: raw } = nextCharacter({ index: characterIndex, seed });
  characterIndex += 1;
  activePersonalityId = personality.id;
  // Sanitised exactly as a model response would be, so the bounds hold here too.
  const spec = sanitizeSpec(raw);
  return {
    spec,
    source: SOURCE,
    latency_ms: SIMULATED_LATENCY_MS * 4,
    reasoning_tokens: 0,
    model_said: JSON.stringify(raw),
    model_reasoning: null,
    reasoning_field: null,
    fallback: false,
    personality: { id: personality.id, label: personality.label, blurb: personality.blurb },
  };
}

/**
 * `world` carries the goal, which is the only thing the server cannot know for
 * itself. The demo reads it the same way the real prompt does and hands it to
 * the same personality that designed the body, so a character drives
 * consistently with what it is.
 */
export async function fetchIntent({ world } = {}) {
  await sleep(SIMULATED_LATENCY_MS);
  const { personality, spec: raw } = nextIntent({
    index: intentIndex,
    seed,
    world,
    personalityId: activePersonalityId,
  });
  intentIndex += 1;

  return {
    intent: sanitizeIntent(raw),
    targets: world?.targets ?? [],
    goal: world?.goal ?? null,
    source: SOURCE,
    latency_ms: SIMULATED_LATENCY_MS,
    reasoning_tokens: 0,
    model_said: JSON.stringify(raw),
    // The personality blurb stands in for chain-of-thought. It lands in the
    // thoughts panel's scratch area, which is exactly the right place for a
    // justification that did not come from a model's reasoning tokens — and it
    // is visibly not a model, which is the point.
    model_reasoning: `acting as ${personality.label}: ${personality.blurb}`,
    reasoning_field: 'personality',
    sanitised: false,
    personality: { id: personality.id, label: personality.label, blurb: personality.blurb },
  };
}
