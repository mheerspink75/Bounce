/**
 * The intent schema's optionality, pinned.
 *
 * This is a regression test for a bug that a green suite could not see, because
 * the broken output was *valid*. `target` used to be optional and typed
 * `['string','null']`, which is the friendliest-looking schema in the world and
 * the worst one for a small model: under grammar-constrained decoding an
 * optional field is an escape hatch, and a weak model takes it every time.
 *
 * Measured against qwen2.5:1.5b-instruct, same prompt, only the schema varied:
 *
 *   target: ['string','null'], optional   ->  0/10  target:"goal", 10/10 null
 *   target: 'string',          optional   ->  0/10  target:"goal"  (key omitted)
 *   target: 'string',          required   ->  8/10  target:"goal"
 *
 * A 7B was 10/10 under all three, so no test written against the 7B would ever
 * have caught this — which is exactly why the constraint is asserted here rather
 * than left to a live model.
 *
 * The failure was invisible because the response was schema-valid and inert:
 * `brain.js` steers on `findTarget(target)`, so a null target produces zero
 * steering and falls back to wandering. The maze simply never completed, with no
 * error anywhere. Six mazes, four minutes, zero rewards.
 */
import { INTENT_SCHEMA } from '../public/schema.js';
import { sanitizeIntent, FALLBACK_INTENT } from '../public/intent.js';

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

console.log('\nintent schema: target must be required and non-nullable\n');

// The two properties that matter, stated separately so a failure says which one.
check(
  'target is listed in required',
  INTENT_SCHEMA.required.includes('target'),
  `required=[${INTENT_SCHEMA.required.join(', ')}]`,
);

check(
  'target does not admit null',
  INTENT_SCHEMA.properties.target.type === 'string',
  `type=${JSON.stringify(INTENT_SCHEMA.properties.target.type)}`,
);

check(
  'target cannot be empty',
  (INTENT_SCHEMA.properties.target.minLength ?? 0) >= 1,
  `minLength=${INTENT_SCHEMA.properties.target.minLength}`,
);

// Still a free string — the deliberate decision that ids live in the world, not
// in the schema. Requiring the key must not quietly turn into an enum.
check(
  'target is still a free string, not an enum of ids',
  INTENT_SCHEMA.properties.target.enum === undefined,
);

check(
  'every required property exists in properties',
  INTENT_SCHEMA.required.every((k) => k in INTENT_SCHEMA.properties),
);

check(
  'additionalProperties is still false',
  INTENT_SCHEMA.additionalProperties === false,
);

// The prompt must not offer what the schema forbids. A model that reads "or
// null" and is then constrained to a string is being set up to fail.
import { readFileSync } from 'node:fs';
const serverSrc = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
check(
  'the intent prompt no longer offers target as null',
  !/target\s+the id of what to head toward, or null/.test(serverSrc),
);

// Tightening the schema must not change what the runtime accepts: the sanitiser
// is the real boundary, and it still has to cope with a provider that ignores
// the schema completely.
check(
  'sanitiser still yields null for a missing target',
  sanitizeIntent({ action: 'charge_target', intensity: 1, duration_s: 3 }).target === null,
);

check(
  'sanitiser still yields null for an empty target',
  sanitizeIntent({ action: 'charge_target', target: '   ', intensity: 1 }).target === null,
);

check(
  'sanitiser still yields null for a non-string target',
  sanitizeIntent({ action: 'charge_target', target: 7, intensity: 1 }).target === null,
);

check(
  'sanitiser keeps a usable target',
  sanitizeIntent({ action: 'charge_target', target: 'goal', intensity: 1 }).target === 'goal',
);

check(
  'the internal fallback intent is unaffected',
  FALLBACK_INTENT.target === null && FALLBACK_INTENT.action === 'wander',
);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
