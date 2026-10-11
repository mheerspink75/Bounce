/**
 * The intent schema: what the model is allowed to ask for, and the rules that
 * turn its answer into something the character can safely execute.
 *
 * Lives under `public/` and is shared with the Node proxy for the same reason
 * as `spec.js` — the browser must be able to import it, and the server must
 * enforce the same rules. Two copies of an allowlist would eventually drift.
 *
 * The important property here is that a model cannot express anything the
 * physics engine would have to second-guess: the action set is a closed enum,
 * and intensity and duration are clamped to ranges that cannot destabilise the
 * simulation.
 */

export const INTENTS = Object.freeze(['seek', 'wander', 'charge_target', 'rest']);

/** Longest a single intent may stay in effect, in seconds. */
export const MAX_INTENT_DURATION = 10;

export function sanitizeIntent(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};

  // Closed enum. An unknown action becomes 'wander' rather than being dropped,
  // so a confused model still produces movement.
  const action = INTENTS.includes(input.action) ? input.action : 'wander';

  const duration = Number(input.duration_s);
  const durationS = Number.isFinite(duration)
    ? Math.min(MAX_INTENT_DURATION, Math.max(0.5, duration))
    : 3;

  // Clamped to 0..1. Above 1 this multiplies an acceleration ceiling, which is
  // how a model would talk the character into tunnelling through a wall.
  const intensityRaw = Number(input.intensity);
  const intensity = Number.isFinite(intensityRaw)
    ? Math.min(1, Math.max(0, intensityRaw))
    : 0.5;

  return {
    action,
    target: typeof input.target === 'string' && input.target.trim()
      ? input.target.trim().slice(0, 40)
      : null,
    intensity,
    duration_s: durationS,
  };
}

/** What to do when an intent has expired or was never set. */
export const FALLBACK_INTENT = Object.freeze(sanitizeIntent({}));
