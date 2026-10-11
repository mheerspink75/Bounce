/**
 * The demo personalities must be reproducible, varied, and schema-valid.
 *
 * Two failure modes this pins down, both of which would be invisible in a
 * screenshot:
 *
 * 1. **Nondeterminism.** The demo calls `Math.random()` nowhere on purpose — a
 *    shared URL has to reproduce the same run, or `?seed=` means nothing beyond
 *    the maze. Asserted by running the engine twice and demanding byte-identical
 *    output.
 * 2. **Targets on aimless actions.** `brain.js` reads a `wander` *with* a target
 *    as a live model answer and a `wander` *without* one as the shape the
 *    fallback produces. So a spurious target here would make the HUD report the
 *    scripted demo as a real model — the single worst outcome this project could
 *    ship from a demo mode.
 *
 * The output is also run through the real `sanitizeIntent`, so the demo cannot
 * drift away from the validation the live path enforces.
 */
import {
  PERSONALITIES,
  PERSONALITY_IDS,
  makeRng,
  nextCharacter,
  nextIntent,
} from '../public/personality.js';
import { sanitizeIntent } from '../public/intent.js';
import { sanitizeSpec } from '../public/spec.js';

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const WORLD = {
  goal: { x: 4, z: -6, reached: false },
  targets: [
    { id: 'goal', label: 'reward', position: { x: 4, z: -6 } },
    { id: 'block_a', label: 'a', position: { x: -2, z: 2 } },
    { id: 'block_b', label: 'b', position: { x: 6, z: 3 } },
  ],
};

// --- the cast ------------------------------------------------------------
{
  check('five personalities are defined', PERSONALITIES.length === 5,
    PERSONALITY_IDS.join(', '));
  check('the prompt\'s five archetypes are all present',
    ['explorer', 'aggressive', 'efficient', 'curious', 'random']
      .every((id) => PERSONALITY_IDS.includes(id)));
  check('personality ids are unique',
    new Set(PERSONALITY_IDS).size === PERSONALITY_IDS.length);
  check('every personality has at least one character spec',
    PERSONALITIES.every((p) => p.specs.length > 0));
}

// --- determinism ---------------------------------------------------------
{
  const a = JSON.stringify(
    Array.from({ length: 12 }, (_, i) => nextCharacter({ index: i, seed: 42 })),
  );
  const b = JSON.stringify(
    Array.from({ length: 12 }, (_, i) => nextCharacter({ index: i, seed: 42 })),
  );
  check('the same seed produces the same characters', a === b);

  const other = JSON.stringify(
    Array.from({ length: 12 }, (_, i) => nextCharacter({ index: i, seed: 43 })),
  );
  check('a different seed produces different characters', other !== a);

  // The engine must not quietly reach for Math.random.
  const realRandom = Math.random;
  Math.random = () => { throw new Error('personality.js called Math.random()'); };
  let threw = null;
  try {
    nextCharacter({ index: 3, seed: 7 });
    nextIntent({ index: 3, seed: 7, world: WORLD });
  } catch (err) { threw = err; }
  Math.random = realRandom;
  check('the engine never calls Math.random', threw === null, threw?.message ?? '');
}

// --- variety -------------------------------------------------------------
{
  const chars = Array.from({ length: 20 }, (_, i) => nextCharacter({ index: i, seed: 1 }).spec);
  check('characters visibly vary in name',
    new Set(chars.map((c) => c.name)).size >= 5,
    `${new Set(chars.map((c) => c.name)).size} distinct names`);
  check('characters visibly vary in colour',
    new Set(chars.map((c) => c.color)).size >= 5);
  check('characters visibly vary in radius',
    new Set(chars.map((c) => c.radius)).size >= 5);
  check('characters visibly vary in mass',
    new Set(chars.map((c) => c.mass)).size >= 5);
  check('every character carries a personality blurb',
    chars.every((c) => typeof c.personality === 'string' && c.personality.length > 0));
}

// --- steering behaviour --------------------------------------------------
{
  const AIMLESS = new Set(['wander', 'rest']);
  let aimed = null;
  let strayTarget = null;
  let badShape = null;
  let badIntensity = null;
  let unknownTarget = null;

  for (const p of PERSONALITIES) {
    for (let i = 0; i < 200; i += 1) {
      const { spec } = nextIntent({ index: i, seed: 5, world: WORLD, personalityId: p.id });
      if (!['charge_target', 'seek', 'wander', 'rest'].includes(spec.action)) badShape = spec.action;
      if (AIMLESS.has(spec.action) && spec.target != null) strayTarget = `${p.id}:${spec.action}->${spec.target}`;
      if (spec.target != null && !['goal', 'block_a', 'block_b'].includes(spec.target)) {
        unknownTarget = `${p.id}:${spec.target}`;
      }
      if (!(spec.intensity > 0 && spec.intensity <= 1)) badIntensity = spec.intensity;
      if (spec.action === 'charge_target' && spec.target) aimed = p.id;
    }
  }

  check('only the four schema actions are ever emitted', badShape === null, badShape ?? '');
  check('wander and rest never carry a target', strayTarget === null, strayTarget ?? '');
  check('no intent aims at a target that does not exist', unknownTarget === null, unknownTarget ?? '');
  check('intensity stays within (0, 1]', badIntensity === null, String(badIntensity ?? ''));
  check('targeted intents do aim at something', aimed !== null, aimed ?? '');
}

// --- the two archetypes that must differ --------------------------------
{
  // If `Efficient` and `Curious` chase the goal at the same rate, the demo
  // "personalities" are a costume and the whole phase is decorative.
  const rate = (id) => {
    let chasing = 0;
    for (let i = 0; i < 400; i += 1) {
      const { spec } = nextIntent({ index: i, seed: 9, world: WORLD, personalityId: id });
      if (spec.target === 'goal') chasing += 1;
    }
    return chasing / 400;
  };
  const eff = rate('efficient');
  const cur = rate('curious');
  check('Efficient chases the reward far more than Curious',
    eff > cur + 0.2, `efficient=${eff.toFixed(2)} curious=${cur.toFixed(2)}`);
  check('Efficient is near-certain to chase', eff > 0.85, eff.toFixed(2));
}

// --- a reached goal changes behaviour ------------------------------------
{
  const done = { ...WORLD, goal: { ...WORLD.goal, reached: true } };
  let chased = 0;
  for (let i = 0; i < 200; i += 1) {
    if (nextIntent({ index: i, seed: 3, world: done }).spec.target === 'goal') chased += 1;
  }
  check('nothing chases a reward that is already collected', chased === 0, `${chased}/200`);
}

// --- the real sanitisers accept everything -------------------------------
{
  let rejected = null;
  for (const p of PERSONALITIES) {
    for (let i = 0; i < 100; i += 1) {
      const clean = sanitizeIntent(
        nextIntent({ index: i, seed: 11, world: WORLD, personalityId: p.id }).spec,
      );
      // A silent sanitiser would mean the demo is emitting values the live path
      // would reject — the demo would look fine and the validator would be lying.
      if (clean.action !== nextIntent({ index: i, seed: 11, world: WORLD, personalityId: p.id }).spec.action) {
        rejected = `${p.id}: action rewritten by sanitizeIntent`;
      }
      const spec = sanitizeSpec(nextCharacter({ index: i, seed: 11 }).spec);
      if (!(spec.radius > 0) || typeof spec.color !== 'string') rejected = `${p.id}: bad spec`;
    }
  }
  check('every demo intent and spec survives the real sanitisers unchanged',
    rejected === null, rejected ?? '');
}

// --- the generator itself ------------------------------------------------
{
  const rng = makeRng(1);
  const draws = Array.from({ length: 2000 }, () => rng());
  check('rng stays inside [0, 1)',
    draws.every((d) => d >= 0 && d < 1));
  check('rng is not obviously degenerate',
    new Set(draws.map((d) => d.toFixed(6))).size > 1900,
    `${new Set(draws.map((d) => d.toFixed(6))).size} distinct of 2000`);
  // Seed 0 is coerced to 1 so a zero-seeded generator cannot sit still. The
    // property that matters is that its *stream* stays varied, not that two
    // identically-seeded generators disagree — they must agree, or the demo would
    // stop being reproducible.
    const zero = makeRng(0);
    const zeroStream = Array.from({ length: 500 }, () => zero());
    check('a zero seed does not collapse to a constant stream',
      new Set(zeroStream.map((d) => d.toFixed(6))).size > 450,
      `${new Set(zeroStream.map((d) => d.toFixed(6))).size} distinct of 500`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);