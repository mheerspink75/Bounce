/**
 * The character spec: schema, limits, and sanitiser.
 *
 * Deliberately dependency-free and located under `public/` because the static
 * server's document root is `public/`, so the browser has to be able to import
 * this file. The Node proxy imports the *same* file rather than keeping its own
 * copy — two copies of these rules would eventually drift, and the whole point
 * is that they are the single definition of what a valid character is.
 *
 * From step 3 onward the spec arrives from an LLM, which makes every field
 * untrusted input. `sanitizeSpec()` is the trust boundary.
 */

/**
 * Bounds for every numeric field.
 *
 * `restitution` is capped at 0.95 rather than 1.0 deliberately: at 1.0 the
 * solver can inject energy and the character gains speed indefinitely. Arena
 * surfaces average with this value so the system would still decay, but relying
 * on that makes a bad spec quietly survivable instead of impossible.
 */
export const LIMITS = {
  radius:      { min: 0.15, max: 2.00, fallback: 0.60 },
  mass:        { min: 0.05, max: 100.0, fallback: 1.20 },
  restitution: { min: 0.00, max: 0.95, fallback: 0.85 },
  roughness:   { min: 0.00, max: 1.00, fallback: 0.35 },
};

export const COLOR_FALLBACK = '#e05a3f';

/** Used whenever the model gives us nothing usable. */
export const DEFAULT_SPEC = Object.freeze({
  name: 'Bounce-7',
  radius: 0.6,
  color: COLOR_FALLBACK,
  mass: 1.2,
  restitution: 0.85,
  roughness: 0.35,
  personality: 'reckless, favours chaos over efficiency',
});

// --- coercion helpers -----------------------------------------------------

function clampNumber(value, { min, max, fallback }) {
  // Accept numeric strings: models return "0.6" often enough that rejecting it
  // would be needlessly brittle. Empty/whitespace strings are rejected
  // explicitly, because Number('') and Number(' ') are both 0.
  const n = typeof value === 'string' && value.trim() !== ''
    ? Number(value.trim())
    : value;

  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampColor(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const hex = value.trim();

  // Strictly 3- or 6-digit hex. `rgb(...)`, named colours and junk all fall
  // back rather than being parsed leniently.
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
  return fallback;
}

function clampText(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback;
  const clean = value
    // Control characters would corrupt the HUD. The HUD also uses textContent
    // rather than innerHTML, so this is belt-and-braces, not the only defence.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length ? clean.slice(0, maxLength) : fallback;
}

// --- public API -----------------------------------------------------------

/**
 * Coerce arbitrary input into a spec that is safe to hand to both the renderer
 * and the physics engine. Never throws.
 *
 * Idempotent: `sanitizeSpec(sanitizeSpec(x))` deep-equals `sanitizeSpec(x)`,
 * so it is safe to call again on an already-clean spec.
 */
export function sanitizeSpec(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  return {
    name: clampText(input.name, DEFAULT_SPEC.name, 60),
    radius: clampNumber(input.radius, LIMITS.radius),
    color: clampColor(input.color, COLOR_FALLBACK),
    mass: clampNumber(input.mass, LIMITS.mass),
    restitution: clampNumber(input.restitution, LIMITS.restitution),
    roughness: clampNumber(input.roughness, LIMITS.roughness),
    personality: clampText(input.personality, DEFAULT_SPEC.personality, 300),
  };
}
