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

/** Whether the page was opened in demo mode. Read once — it cannot change. */
export const isDemo = new URLSearchParams(location.search).get('demo') === '1';

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
 * Scripted characters. Radii vary deliberately: the maze is sized from the
 * character radius, so a visibly fatter character produces a visibly coarser
 * maze, which is one of the more surprising behaviours in the project and worth
 * showing without a model.
 */
const CHARACTERS = [
  { name: 'Cobalt', radius: 0.55, color: '#3f7fd6', mass: 1.0, restitution: 0.78, roughness: 0.4, personality: 'calm and deliberate' },
  { name: 'Ember', radius: 0.9, color: '#e2622b', mass: 1.8, restitution: 0.6, roughness: 0.7, personality: 'warm but volatile' },
  { name: 'Brace{y}', radius: 0.4, color: '#7fd6a0', mass: 0.6, restitution: 0.9, roughness: 0.2, personality: 'playful {not really}' },
  { name: 'Monolith', radius: 1.8, color: '#8a8f98', mass: 3.2, restitution: 0.35, roughness: 0.85, personality: 'unhurried and immovable' },
  { name: 'Zippy', radius: 0.25, color: '#e0c93f', mass: 0.35, restitution: 0.92, roughness: 0.15, personality: 'reckless, favours chaos over efficiency' },
];

/** Arena targets the page reports; mirrors what `world` carries on the live path. */
const INTENT_SHAPES = [
  'charge_target', 'seek', 'wander', 'charge_target', 'rest', 'seek', 'charge_target', 'wander',
];

let characterIndex = 0;
let intentIndex = 0;

export async function fetchHealth() {
  await sleep(0);
  return { ok: true, provider: SOURCE, hasKey: false, override_active: false, demo: true };
}

export async function fetchCharacter() {
  await sleep(SIMULATED_LATENCY_MS * 4);
  const raw = CHARACTERS[characterIndex % CHARACTERS.length];
  characterIndex += 1;
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
  };
}

/**
 * `world` carries the goal, which is the only thing the server cannot know for
 * itself. The demo reads it the same way the real prompt does, and mostly heads
 * for the goal — with a deliberate minority of other intents so the character
 * reads as a decision-maker rather than a scripted animation.
 */
export async function fetchIntent({ world } = {}) {
  await sleep(SIMULATED_LATENCY_MS);
  intentIndex += 1;

  const goal = world?.goal;
  const wantsGoal = goal && !goal.reached && intentIndex % 4 !== 0;

  const raw = wantsGoal
    ? { action: 'charge_target', target: 'goal', intensity: 1, duration_s: 8 }
    : {
      action: INTENT_SHAPES[intentIndex % INTENT_SHAPES.length],
      target: 'block_a',
      intensity: 0.6,
      duration_s: 3,
    };

  return {
    intent: sanitizeIntent(raw),
    targets: world?.targets ?? [],
    goal: goal ?? null,
    source: SOURCE,
    latency_ms: SIMULATED_LATENCY_MS,
    reasoning_tokens: 0,
    model_said: JSON.stringify(raw),
    model_reasoning: null,
    reasoning_field: null,
    sanitised: false,
  };
}
