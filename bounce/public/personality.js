/**
 * Deterministic AI personalities for the browser-only demo.
 *
 * The demo used to be one flat list of five characters and a hard-coded rule
 * that mostly headed for the goal. That produced a visitor who watched the same
 * ball do the same thing for as long as they cared to stay — the opposite of
 * showing off an AI-controlled system.
 *
 * This module is where the demo's *decisions* live, kept deliberately free of
 * `location`, `fetch`, timers and the DOM. That is not tidiness for its own sake:
 * `demo.js` reads the query string at import time and sleeps on wall-clock
 * timers, so neither can be imported from the headless suite. Keeping the choice
 * of who to be and what to do in a pure module means it can be unit-tested
 * directly, and it means `demo.js` stays a thin adapter that adds latency and
 * sanitisation — the same two things it did before.
 *
 * Everything here is seeded. The demo must be reproducible: a visitor who
 * reloads, or who shares a URL, should see the same run. Nothing calls
 * `Math.random()`.
 */

/** Intent shapes the schema accepts. Mirrors `intent.js`. */
export const SHAPES = ['charge_target', 'seek', 'wander', 'rest'];

/**
 * A tiny linear congruential generator.
 *
 * `Math.random()` would be simpler, but it would make the demo unreproducible and
 * untestable at once. Park–Miller with a 32-bit modulus: 32 bits of state is
 * plenty here, and it stays inside the exact-integer range of `| 0` arithmetic,
 * so results are identical in every engine.
 */
export function makeRng(seed = 1) {
  let s = (Math.trunc(seed) >>> 0) || 1;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s / 4294967296;
  };
}

/**
 * The personalities.
 *
 * Each carries a pool of specs, so repeatedly asking for a character visibly
 * changes it, and a steering profile, so it visibly *drives* differently. The
 * pools are spread across radius and mass on purpose: the maze is generated from
 * the character radius, so a fatter character produces a visibly coarser maze.
 * That coupling is one of the more surprising behaviours in the project and is
 * worth demonstrating without needing a model.
 *
 * `goalBias` is the probability of charging the reward when one exists. An
 * `Efficient` character is nearly always beelining; a `Curious` one is not.
 */
export const PERSONALITIES = [
  {
    id: 'explorer',
    label: 'Explorer',
    blurb: 'small and quick, mapping the maze rather than racing through it',
    goalBias: 0.4,
    intensity: [0.35, 0.7],
    duration_s: [2, 4],
    weights: { charge_target: 3, seek: 4, wander: 3, rest: 1 },
    specs: [
      { name: 'Wisp', radius: 0.3, color: '#6fd3e0', mass: 0.4, restitution: 0.88, roughness: 0.2 },
      { name: 'Pip', radius: 0.42, color: '#8fe3b0', mass: 0.6, restitution: 0.8, roughness: 0.28 },
      { name: 'Vex', radius: 0.35, color: '#a8d86f', mass: 0.5, restitution: 0.82, roughness: 0.25 },
    ],
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    blurb: 'heavy, bouncy and permanently charging the reward',
    goalBias: 0.92,
    intensity: [0.8, 1],
    duration_s: [4, 8],
    weights: { charge_target: 8, seek: 2, wander: 1, rest: 0 },
    specs: [
      { name: 'Rampart', radius: 1.7, color: '#e04b3a', mass: 3.4, restitution: 0.5, roughness: 0.8 },
      { name: 'Bruiser', radius: 1.35, color: '#ef7a3c', mass: 2.7, restitution: 0.58, roughness: 0.72 },
    ],
  },
  {
    id: 'efficient',
    label: 'Efficient',
    blurb: 'dense and low-friction, taking the shortest route almost every time',
    goalBias: 0.97,
    intensity: [0.65, 0.95],
    duration_s: [3, 6],
    weights: { charge_target: 9, seek: 3, wander: 0, rest: 0 },
    specs: [
      { name: 'Vector', radius: 0.62, color: '#4f8ff0', mass: 1.35, restitution: 0.35, roughness: 0.15 },
      { name: 'Cadence', radius: 0.55, color: '#6d7ff2', mass: 1.2, restitution: 0.4, roughness: 0.18 },
    ],
  },
  {
    id: 'curious',
    label: 'Curious',
    blurb: 'changes its mind often, and says so in the thoughts panel',
    goalBias: 0.5,
    intensity: [0.3, 1],
    duration_s: [1.5, 3.5],
    weights: { charge_target: 3, seek: 3, wander: 4, rest: 2 },
    specs: [
      { name: 'Quill', radius: 0.8, color: '#b07ff0', mass: 1.1, restitution: 0.7, roughness: 0.45 },
      { name: 'Mote', radius: 0.5, color: '#f07fb0', mass: 0.85, restitution: 0.75, roughness: 0.38 },
      { name: 'Fizz', radius: 0.95, color: '#7ff0e0', mass: 1.25, restitution: 0.68, roughness: 0.5 },
    ],
  },
  {
    id: 'random',
    label: 'Random',
    blurb: 'seeded chaos — reproducible, but not predictable from one run to the next',
    goalBias: 0.6,
    intensity: [0.25, 1],
    duration_s: [1, 7],
    weights: { charge_target: 4, seek: 3, wander: 3, rest: 2 },
    specs: [
      { name: 'Chaos', radius: 1.1, color: '#e0c93f', mass: 1.6, restitution: 0.9, roughness: 0.55 },
      { name: 'Null', radius: 0.28, color: '#9aa4b0', mass: 0.3, restitution: 0.95, roughness: 0.1 },
      { name: 'Bulk', radius: 1.95, color: '#8a8f98', mass: 3.6, restitution: 0.3, roughness: 0.9 },
    ],
  },
];

/** Total weight across a personality's shapes, for weighted selection. */
function totalWeight(w) {
  return Object.values(w).reduce((a, b) => a + b, 0);
}

/** Pick one shape by weight using `rng`. */
function pickShape(rng, weights) {
  const total = totalWeight(weights);
  let roll = rng() * total;
  for (const shape of SHAPES) {
    roll -= weights[shape] ?? 0;
    if (roll <= 0) return shape;
  }
  return SHAPES[0];
}

/** A float in `[lo, hi]`. */
const between = (rng, [lo, hi]) => lo + rng() * (hi - lo);

/**
 * Choose the next character.
 *
 * `index` advances on every call so pressing A keeps changing the character, and
 * `seed` keeps that sequence reproducible.
 *
 * Returns the personality alongside the spec: the caller reports both, because a
 * visitor should be able to see that the *behaviour* changed, not just the paint.
 */
export function nextCharacter({ index = 0, seed = 1 } = {}) {
  const p = PERSONALITIES[index % PERSONALITIES.length];
  const rng = makeRng(seed + index * 7919);
  const base = p.specs[Math.floor(rng() * p.specs.length) % p.specs.length];
  return {
    personality: p,
    spec: { ...base, personality: p.blurb },
  };
}

/**
 * Choose the next intent.
 *
 * `world.goal` is honoured when it exists and has not been reached — the same
 * information the real prompt is given, read the same way. Without it the demo
 * would be steering at a reward that is not there, which is precisely the
 * "steering blind" failure the live path goes out of its way to avoid.
 */
export function nextIntent({ index = 0, seed = 1, world = {}, personalityId } = {}) {
  const p =
    PERSONALITIES.find((x) => x.id === personalityId) ??
    PERSONALITIES[index % PERSONALITIES.length];

  const rng = makeRng(seed + index * 104729);
  const goal = world?.goal;
  const hasGoal = Boolean(goal && !goal.reached);

  const chase = hasGoal && rng() < p.goalBias;
  const action = chase ? 'charge_target' : pickShape(rng, p.weights);

  // `wander` and `rest` take no target. Handing them one is not a stylistic
  // choice: `brain.js` treats a `wander` with a target as a model answer and a
  // `wander` without one as the shape the fallback produces, so a spurious target
  // would make the HUD's `control` line report the fallback as a live model.
  const wantsTarget = action === 'charge_target' || action === 'seek';

    // Aimless actions get no target. Targeted ones get the goal when chasing, and
    // otherwise one of the nearby blocks, so a wandering character still has
    // something to steer at rather than drifting.
    let target = null;
    if (wantsTarget) {
      if (chase) {
        target = 'goal';
      } else {
        const options = (world?.targets ?? [])
          .map((t) => t.id)
          .filter((id) => id !== 'goal');
        target = options.length ? options[Math.floor(rng() * options.length)] : 'goal';
      }
    }

    return {
      personality: p,
      spec: {
        action,
        target,
        intensity: Number(between(rng, p.intensity).toFixed(2)),
        duration_s: Number(between(rng, p.duration_s).toFixed(1)),
      },
    };
  }

/** Every personality id, for tests and for the demo's own status line. */
export const PERSONALITY_IDS = PERSONALITIES.map((p) => p.id);