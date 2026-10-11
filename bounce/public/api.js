/**
 * Talking to the proxy. The only module that performs network I/O.
 *
 * The API key lives on the server and is never present here — this module only
 * ever sees a sanitised spec coming back.
 */

const DEFAULT_BASE = 'http://127.0.0.1:8787';

// Demo mode answers the same three endpoints from the page itself, so a static
// deployment needs no proxy. Opt-in via `?demo=1` only — it never engages on its
// own, because "the proxy is unreachable" and "the model is scripted" must not
// look identical, and telling them apart is what the HUD's `control` line is for.
import { isDemo, fetchHealth as demoHealth, fetchCharacter as demoCharacter, fetchIntent as demoIntent } from './demo.js';

/** Read the proxy URL from the query string so it can be pointed elsewhere. */
function proxyBase() {
  const fromQuery = new URLSearchParams(location.search).get('proxy');
  if (fromQuery) return fromQuery.replace(/\/$/, '');
  return DEFAULT_BASE;
}

/**
 * Do the request, and make a *network-level* failure say something useful.
 *
 * A CORS rejection is the awkward one: the proxy answers `403 origin not
 * allowed` with an explanation, but the browser never surfaces that body — the
 * preflight failed, so `fetch` rejects with a bare `TypeError: Failed to fetch`.
 * That string is unactionable, and it is what the HUD showed while the real
 * cause was one character of difference in the page's address.
 *
 * So a rejected fetch is reported with the two things that actually explain it:
 * where the page thinks the proxy is, and the origin the proxy is being asked to
 * trust. The client cannot see the 403, so it cannot know for certain — but it
 * can name the overwhelmingly likely cause instead of shrugging.
 */
async function call(path, { signal, ...init } = {}) {
  const base = proxyBase();
  let res;
  try {
    res = await fetch(`${base}${path}`, { ...init, signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;   // an interrupt, not a fault
    // Worded so the cause and the fix land in the first line, because the HUD
    // truncates this and a message that explains itself after the cut is no use.
    throw new Error(
      `proxy unreachable from page origin ${location.origin} — usually this origin `
      + `is not in the proxy's ALLOWED_ORIGIN (proxy ${base}). Start the proxy, or `
      + 'open the page at an allowed address.',
    );
  }
  return res;
}

export async function fetchHealth({ signal } = {}) {
  if (isDemo) return demoHealth();
  const res = await call('/api/health', { signal });
  if (!res.ok) throw new Error(`health check failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Ask the model for a character.
 *
 * Returns `{ spec, source }`. `source` is the provider/model id, or
 * `'fallback'` if the proxy could not use the model's output — the caller
 * should surface that rather than pretending the model was used.
 */
export async function fetchCharacter({ signal } = {}) {
  if (isDemo) return demoCharacter();
  const res = await call('/api/character', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal,
  });

  if (!res.ok) {
    // The proxy sends a short, already-redacted message.
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch { /* keep the status-only message */ }
    throw new Error(detail);
  }

  return res.json();
}

/**
 * Ask the model what the character should do next.
 *
 * `world` is reported with every request so the proxy can describe the actual
 * objective. The target list is not something the server can know for itself —
 * `goal` only exists when a maze does — and a model told about a target that
 * does not exist, or not told about one that does, is a model steering blind.
 *
 * Returns `{ intent, targets, source }`. The proxy has already sanitised the
 * intent; the brain sanitises again, because a response is trusted no more than
 * a model is.
 */
export async function fetchIntent({ signal, world } = {}) {
  if (isDemo) return demoIntent({ world });
  const res = await call('/api/intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(world ?? {}),
    signal,
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch { /* keep the status-only message */ }
    throw new Error(detail);
  }

  return res.json();
}
