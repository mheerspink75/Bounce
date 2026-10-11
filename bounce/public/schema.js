/**
 * JSON Schema for the character spec and the intent, derived from the same
 * constants the sanitiser uses.
 *
 * Why this exists: asking a small model for "one JSON object and nothing else"
 * fails regularly. The research on sub-7B models is blunt about it — prompting
 * alone is unreliable, and grammar constraints are the fix. Both llama.cpp and
 * Ollama can enforce a schema at the token level, which makes invalid output
 * structurally impossible rather than merely unlikely.
 *
 * That is what makes a <=2B local model viable for this project. Without
 * constraints it would need a large model; with them, model quality barely
 * matters for shape.
 *
 * Derived from LIMITS rather than hand-written so the schema can never drift
 * from the validation rules. If a bound changes in spec.js, it changes here.
 */
import { LIMITS } from './spec.js';
import { INTENTS, MAX_INTENT_DURATION } from './intent.js';

const num = ({ min, max }) => ({ type: 'number', minimum: min, maximum: max });

export const CHARACTER_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 60 },
    radius: num(LIMITS.radius),
    color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
    mass: num(LIMITS.mass),
    restitution: num(LIMITS.restitution),
    roughness: num(LIMITS.roughness),
    personality: { type: 'string', maxLength: 300 },
  },
  required: ['name', 'radius', 'color', 'mass', 'restitution', 'roughness', 'personality'],
  additionalProperties: false,
});

export const INTENT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...INTENTS] },
    // No enum of ids here: targets live in the world, not in the schema, and the
    // sanitiser already degrades an unknown id to a wander. A stale enum would
    // be a worse failure than a loose one.
    //
    // But it IS required, and that is a separate decision from the enum above —
    // one that was wrong until somebody measured it. `target` used to be optional
    // and typed `['string','null']`, and that made the *small* models worse, not
    // safer. Under grammar-constrained decoding an optional field is an escape
    // hatch, and a weak model's greedy path runs straight through it: against
    // qwen2.5:1.5b-instruct, `target` came back null 8/8 and then 10/10 times,
    // and the grammar locked the null in. Making it a non-null string but leaving
    // it optional changed nothing — the model just omitted the key instead
    // (`seek:undefined` 8/10). Requiring it took the same model to 8/10
    // `target:"goal"`, and left a 7B at 10/10.
    //
    // Why it mattered: `brain.js` steers on `findTarget(target)`, so a null or
    // missing target produces *zero* steering and silently falls back to
    // wandering. A small model was therefore returning valid, schema-conformant
    // and completely inert JSON — the constraint made the failure unrecoverable
    // rather than merely unlikely. See README "Schema-constrained decoding".
    //
    // The sanitiser is unchanged and still yields `target: null` for anything
    // arriving without a usable string, so a provider that ignores the schema is
    // unaffected.
    target: { type: 'string', minLength: 1, maxLength: 40 },
    intensity: { type: 'number', minimum: 0, maximum: 1 },
    duration_s: { type: 'number', minimum: 0.5, maximum: MAX_INTENT_DURATION },
  },
  required: ['action', 'target', 'intensity', 'duration_s'],
  additionalProperties: false,
});

export const SCHEMAS = Object.freeze({
  character: CHARACTER_SCHEMA,
  intent: INTENT_SCHEMA,
});
