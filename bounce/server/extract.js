/**
 * Pulling a usable JSON object out of whatever the model actually returned.
 *
 * Models wrap JSON in prose, markdown fences, and trailing commentary even when
 * told not to. Every one of these shapes has to degrade to a usable spec rather
 * than an error, because a failed character request should still show a
 * character.
 *
 * The intent schema and its sanitiser live in `public/intent.js` so the browser
 * and the server enforce identical rules.
 */
export { INTENTS, sanitizeIntent, MAX_INTENT_DURATION, FALLBACK_INTENT } from '../public/intent.js';

// --- JSON extraction ------------------------------------------------------

/**
 * Extract the first balanced top-level JSON object from a string.
 *
 * Scans for brace depth while tracking string state and escapes, so a `{`
 * inside a string value (a `personality` field is a realistic place for one)
 * does not throw the depth off.
 *
 * Returns the parsed object, or null if there isn't one.
 */
export function extractJsonObject(raw) {
  if (typeof raw !== 'string') return null;

  let text = raw.trim();

  // Strip a markdown code fence, e.g. ```json { ... } ```
  const fence = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  // Fast path: the whole thing is the object.
  const direct = tryParseObject(text);
  if (direct) return direct;

  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const c = text[i];

    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return tryParseObject(text.slice(start, i + 1));
    }
  }

  return null;   // unbalanced — truncated response, most likely
}

function tryParseObject(candidate) {
  try {
    const value = JSON.parse(candidate);
    // Arrays are objects in JS but are useless as a spec.
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
