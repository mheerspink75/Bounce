/**
 * Step 4 — the slow brain.
 *
 * The model decides *what the character wants*. This decides how often to ask,
 * how long to hold the answer, and how to turn it into forces. It never sets a
 * velocity or a position: the physics engine owns all motion.
 *
 * That split is the whole reason this file is small. An LLM call takes
 * 300ms–2s and a frame takes 16ms, so anything per-frame is impossible. The
 * brain therefore runs on two clocks:
 *
 *   - intents are held for `duration_s` of *simulation* time, so pausing the
 *     tab does not make the character change its mind;
 *   - requests are paced by *wall-clock* completion, so a slow provider makes
 *     the brain ask less often rather than stacking up requests.
 *
 * Every input is sanitised. A model that returns nonsense gets a wander, not a
 * broken simulation.
 */
import { sanitizeIntent, FALLBACK_INTENT } from './intent.js';

/** How long to wait after a request settles before asking again. */
const DEFAULT_INTERVAL_MS = 2000;

/**
 * Acceleration ceiling in m/s^2. This is what bounds the damage a bad intent
 * can do: intensity multiplies it, and intensity is clamped to 0..1.
 */
const MAX_ACCEL = 16;

/** Speed ceiling in m/s. Once at the ceiling, no further force is applied. */
const MAX_SPEED = 10;

/**
 * Speed ceiling while navigating a maze, in m/s.
 *
 * A ball has no steering geometry — it is a force on a sphere — so a 90° turn
 * costs roughly `v * sqrt(2)` of velocity change. In a corridor about 2.5m wide
 * there is only so much room to do that in, and at 10 m/s the character simply
 * cannot turn: it overshoots the corner, hits the far wall, and oscillates
 * between two cells indefinitely. Measured before this existed — a character
 * reached the far end of the first corridor in 1s and then spent 59s bouncing
 * between cells 2 and 4.
 */
const NAV_MAX_SPEED = 3.5;

/**
 * Arrival is a velocity servo, not "point at it and push".
 *
 * A pure position controller (force toward a point) cannot brake. When the aim
 * direction swings 90° at a corner the character keeps its old momentum,
 * overshoots, hits the far wall and bounces back — which is exactly what was
 * observed: a character reached the end of the first corridor in 1s and then
 * spent 59s oscillating between two cells.
 *
 * Steering toward a *desired velocity* means the servo actively brakes the old
 * velocity as the target direction changes, which is what makes corners
 * possible. `RESPONSE` is the reciprocal time constant: higher converges faster
 * and applies more force.
 */
const RESPONSE = 8;

/** Desired speed scales with distance, so arrival is smooth rather than abrupt. */
const APPROACH_RATE = 2.5;

/** Radians of heading change per second while wandering. */
const WANDER_TURN_RATE = 1.6;

/**
 * Anti-stall watchdog. See `watchForStall`.
 *
 * `STUCK_AFTER_S` is comfortably longer than a single wall scrape — a ball
 * grinding along a wall for a third of a second is normal and must not trigger
 * anything. `STUCK_MOVE_EPS` is well under the smallest useful progress: at the
 * 3.5 m/s navigation ceiling a tenth of a second is 0.35m, so 3cm cannot be
 * mistaken for genuine motion.
 */
const STUCK_AFTER_S = 0.8;
const STUCK_MOVE_EPS = 0.03;
const STUCK_ESCAPE_S = 0.5;

export function createBrain({
  sim,
  ask,
  intervalMs = DEFAULT_INTERVAL_MS,
  random = Math.random,
  now = () => Date.now(),
} = {}) {
  if (!sim || typeof ask !== 'function') {
    throw new Error('createBrain needs a sim and an ask() function');
  }

  let intent = FALLBACK_INTENT;
  let intentExpiresAt = 0;    // simulation time
  let simTime = 0;
  let nextAskAt = 0;          // wall-clock ms
  let asking = false;
  let inFlight = null;        // AbortController for the request being asked now
  let retryWhenSettled = false;
  let wanderAngle = 0;
  let lastError = null;
  // Anti-stall watchdog state. `escapeUntil` is simulation time, so a backgrounded
  // tab does not silently end an escape that the user never saw.
  let stuckFor = 0;
  let stuckAnchor = null;
  let escapeUntil = 0;
  let escapeTurn = 1;
  let requests = 0;
  let lastLatencyMs = null;
  let avgLatencyMs = null;

  const state = { status: 'idle', requests, lastError, lastLatencyMs, avgLatencyMs };

  function refresh() {
    state.status = asking ? 'asking' : state.status;
    state.requests = requests;
    state.lastError = lastError;
    state.lastLatencyMs = lastLatencyMs;
    state.avgLatencyMs = avgLatencyMs;
  }

  /**
   * Ask the model for a new intent. Fire-and-forget: the render loop must never
   * await a network call. Failures degrade to a wander so the character keeps
   * moving rather than freezing.
   */
  async function request() {
    if (asking) return;
    asking = true;
    state.status = 'asking';
    requests += 1;
    const startedAt = now();
    const controller = new AbortController();
    inFlight = controller;

    try {
      // The signal is what makes an override able to cut a slow request short.
      const raw = await ask({ signal: controller.signal });
      intent = sanitizeIntent(raw);
      intentExpiresAt = simTime + intent.duration_s;
      lastError = null;
      state.status = 'ok';
    } catch (err) {
      // An interrupt is not a failure — it is us changing our minds on purpose,
      // and reporting it as an error would make a working manual channel look
      // broken in the HUD.
      if (controller.signal.aborted) {
        state.status = 'interrupted';
      } else {
        // The point of the fallback: a dead provider must not strand the character.
        intent = FALLBACK_INTENT;
        intentExpiresAt = simTime + FALLBACK_INTENT.duration_s;
        lastError = err?.message ?? 'request failed';
        state.status = 'error';
      }
    } finally {
      // Measured on the failure path too. A timed-out call's latency is exactly
      // the number worth seeing — recording only successes meant the HUD showed
      // nothing at all in the common case on a slow free tier.
      const elapsed = now() - startedAt;
      if (Number.isFinite(elapsed) && elapsed >= 0) {
        lastLatencyMs = elapsed;
        avgLatencyMs = avgLatencyMs === null ? elapsed : avgLatencyMs * 0.6 + elapsed * 0.4;
      }

      asking = false;
      inFlight = null;
      // Pace the next request from completion, not from the request start, so a
      // slow provider cannot produce a backlog.
      nextAskAt = now() + intervalMs;
      refresh();

      // An interrupt asked for a fresh request the moment this one settled.
      // Doing it here rather than in `interrupt()` is what makes it work: an
      // aborted fetch rejects asynchronously, so `asking` is still true at the
      // instant `interrupt()` returns, and a direct retry is silently dropped.
      if (retryWhenSettled) {
        retryWhenSettled = false;
        void request();
      }
    }
  }

  /**
   * Abandon the in-flight request and ask again immediately.
   *
   * This is what makes the manual channel actually manual. Without it, a manual
   * intent posted while a 20s model request is outstanding is stuck in a queue
   * behind that request — the character keeps wandering until the model call
   * finally times out. Measured on the maze: 22s of the 30s run was spent
   * waiting for a request that was never going to be wanted.
   */
  function interrupt() {
    if (!inFlight) {
      nextAskAt = 0;
      return request();
    }
    retryWhenSettled = true;
    inFlight.abort();
    return undefined;
  }

  /**
   * Advance the brain by one frame's worth of simulation time and apply the
   * current intent as a force. Call this *before* `sim.advance()`.
   */
  function update(frameDt) {
    simTime += frameDt;

    if (simTime >= intentExpiresAt) intent = FALLBACK_INTENT;
    if (!asking && now() >= nextAskAt) void request();

    watchForStall(frameDt);
    applyForce(intent);
    return intent;
  }

  /**
   * Refuse to stay stuck.
   *
   * `slide` removes the specific failure mode where the heading drives straight
   * into a wall. It cannot remove *every* equilibrium, and the one that remains is
   * intermittent: instrumenting the live page caught a 5.15s stall at
   * `speed 0.00 m/s` (seed 29, 4x4, radius 1.0) on one 150s run and nothing at all
   * on the next two, so it could not be reproduced on demand even with the exact
   * seed, spec and position.
   *
   * That is the argument for a watchdog rather than for hunting the last case. An
   * intermittent stall that a user sees as "stuck on the wall" and a test suite
   * cannot reproduce is not something to leave to chance: measure that the
   * character is not moving while it is being told to go somewhere, and then
   * deterministically break the equilibrium by steering along the wall instead of
   * into it.
   *
   * A stuck character is a *visible* failure and a moving one is not, so the cost
   * of firing this when it was not needed is one brief turn in an open corridor.
   * The alternative — being occasionally frozen for seconds — is worse.
   */
  function watchForStall(frameDt) {
    const p = sim.character.body.translation();
    const wantsToMove = (intent.action === 'charge_target' || intent.action === 'seek')
      && Boolean(intent.target);

    if (!wantsToMove) {
      stuckFor = 0;
      stuckAnchor = null;
      return;
    }

    if (!stuckAnchor) stuckAnchor = { x: p.x, z: p.z };
    const moved = Math.hypot(p.x - stuckAnchor.x, p.z - stuckAnchor.z);

    if (moved > STUCK_MOVE_EPS) {
      // Progress: re-anchor the window and cancel any escape in progress.
      stuckFor = 0;
      stuckAnchor = { x: p.x, z: p.z };
      escapeUntil = 0;
      return;
    }

    stuckFor += frameDt;
    if (stuckFor >= STUCK_AFTER_S && simTime >= escapeUntil) {
      // Alternate the turn direction so a repeated stall cannot settle into a
      // second equilibrium one turn further along.
      escapeTurn = escapeTurn === 1 ? -1 : 1;
      escapeUntil = simTime + STUCK_ESCAPE_S;
      stuckFor = 0;
      stuckAnchor = { x: p.x, z: p.z };
    }
  }

  /**
   * Remove the component of a desired heading that drives into a wall, leaving
   * the part that slides along it.
   *
   * A purely positional aim has no way to express "go around", so any component
   * of the heading that points into a wall is simply absorbed by the contact and
   * the friction. At the position instrumented on the live page (seed 29, 4x4,
   * radius 1.0, ball at (-0.20, -5.10) against the end of a wall) the raw heading
   * drove **0.068 into the wall** and 0.997 along it.
   *
   * That number is much smaller than it first looked. An earlier version of this
   * comment claimed 0.991 — a deadlock — because it picked the wall normal by
   * nearest axis instead of by closest point, which is wrong at a corner: the
   * ball was against a wall's *end*, where the true normal is diagonal. Correcting
   * the measurement turned "the whole force is absorbed, this cannot possibly
   * work" into "6.8% of the force is absorbed, which is a real but modest loss".
   * Both numbers came from the same script; only one of them was right, and the
   * wrong one was the one that made a tidy story.
   *
   * So this is a genuine improvement and it is cheap, but on its own it is not an
   * explanation of a 5-second stall. `watchForStall` is what addresses the stall;
   * this removes the avoidable loss that would otherwise compound it.
   *
   * The navigator cannot do this job. `isBlocked` walks cells along the line and
   * the line genuinely is clear — the obstruction is the character's own *radius*
   * against a wall, which is a contact problem, not a routing problem. It needs
   * the character treated as a disc, which is what the closest-point normal below
   * does.
   *
   * `sim.maze` rather than a module-level wall list, so the open arena (where it
   * is null) is untouched.
   */
  function slide(x, z, dx, dz, radius) {
    const walls = sim.maze?.walls;
    if (!walls || walls.length === 0) return { x: dx, z: dz };

    // Reach counts as contact. Rapier's own slop is ~1mm, and a hair of margin
    // means the slide engages just before the solver stops the ball dead.
    const reach = radius + 0.02;
    let vx = dx;
    let vz = dz;

    for (const w of walls) {
      const [hx, , hz] = w.half;
      const [cx, , cz] = w.pos;

      // Closest point on the box to the character centre. Using the closest point
      // rather than picking a face by nearest axis is what makes corners work: a
      // ball against a wall's *end* gets a diagonal normal, and projecting against
      // that slides it around the end instead of jamming on it.
      const qx = Math.max(cx - hx, Math.min(x, cx + hx));
      const qz = Math.max(cz - hz, Math.min(z, cz + hz));
      let nx = x - qx;
      let nz = z - qz;
      const d = Math.hypot(nx, nz);

      if (d > reach) continue;              // not touching
      if (d < 1e-6) continue;               // dead centre inside the box; let the solver own it

      nx /= d; nz /= d;                     // outward normal, box -> character

      // Negative means the heading pushes into this wall.
      const into = vx * nx + vz * nz;
      if (into >= 0) continue;

      vx -= nx * into;
      vz -= nz * into;
    }

    const len = Math.hypot(vx, vz);
    if (len < 1e-6) {
      // The heading was *exactly* into the wall, so projecting left nothing.
      // Any fixed choice would be arbitrary; pick a perpendicular deterministically
      // so the ball always leaves along the wall rather than freezing, and let the
      // next frame's aim (now from a moved position) finish the job.
      return { x: -dz, z: dx };
    }
    return { x: vx / len, z: vz / len };
  }

  function applyForce(current) {
    const body = sim.character.body;
    const p = body.translation();
    const v = body.linvel();

    // Steer in the horizontal plane only. Pushing down would fight gravity;
    // pushing up would launch the character through the wall tops.
    let ax = 0;
    let az = 0;
    let desired = 0;

    // An escape overrides the aim entirely. Steering into a wall is what caused
    // the stall; steering across it is what breaks it, and the tangential
    // direction is the one direction friction cannot absorb.
    const escaping = simTime < escapeUntil;

    if (escaping) {
      // An escape ignores the aim entirely: the whole point is that aiming is what
      // wedged the character. `escapeTurn` is relative to the heading we last
      // wanted, so repeated stalls alternate sides rather than always picking the
      // same one and settling into a second equilibrium.
      const ref = Math.hypot(ax, az) > 1e-6 ? { x: ax, z: az } : { x: 1, z: 0 };
      ax = -ref.z * escapeTurn;
      az = ref.x * escapeTurn;
      desired = 1;
    } else if (current.action === 'charge_target' || current.action === 'seek') {
      const target = sim.findTarget(current.target);
      if (target) {
        let aim = target.position;

        // Route around walls when the direct line is blocked. In an open arena
        // this is a no-op, so behaviour there is unchanged — in a maze it is the
        // difference between reaching the goal and grinding into a wall.
        if (sim.navigator) {
          aim = sim.navigator.nextWaypoint({ x: p.x, z: p.z }, aim).point;
        }

        const dx = aim.x - p.x;
        const dz = aim.z - p.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 1e-4) {
          ax = dx / dist;
          az = dz / dist;
          // Slide along walls instead of pressing into them. See `slide`.
          const slid = slide(p.x, p.z, ax, az, sim.character.spec.radius);
          ax = slid.x;
          az = slid.z;
          // Slow down on approach, so arrival is smooth rather than abrupt.
          desired = Math.min(1, dist * APPROACH_RATE);
        }
      }
      // An unknown or missing target produces no steering at all, which looks
      // like a character that has given up. Fall back to wandering instead.
      if (ax === 0 && az === 0 && current.action !== 'rest') {
        wanderAngle += (random() - 0.5) * WANDER_TURN_RATE;
        ax = Math.cos(wanderAngle);
        az = Math.sin(wanderAngle);
        desired = 1;
      }
    } else if (current.action === 'wander') {
      // Drift the heading rather than jittering each frame.
      wanderAngle += (random() - 0.5) * WANDER_TURN_RATE;
      ax = Math.cos(wanderAngle);
      az = Math.sin(wanderAngle);
      desired = 1;
    }
    // 'rest' leaves desired at 0, which makes the servo brake to a stop.

    // The speed ceiling is lower while navigating: corners are the binding
    // constraint there, not tunnelling.
    const ceiling = (sim.navigator ? NAV_MAX_SPEED : MAX_SPEED) * current.intensity;

    // Velocity servo. Targeting a velocity rather than a position is what lets
    // the character brake through a corner instead of carrying its old momentum
    // into the far wall.
    const wantVx = ax * desired * ceiling;
    const wantVz = az * desired * ceiling;

    const mass = body.mass() || 1;
    let fx = (wantVx - v.x) * RESPONSE * mass;
    let fz = (wantVz - v.z) * RESPONSE * mass;

    // Never exceed the acceleration ceiling, whatever the velocity error.
    const maxF = MAX_ACCEL * current.intensity * mass;
    const mag = Math.hypot(fx, fz);
    if (mag > maxF && mag > 0) {
      fx = (fx / mag) * maxF;
      fz = (fz / mag) * maxF;
    }

    body.resetForces(true);
    body.addForce({ x: fx, y: 0, z: fz }, true);
  }

  return {
    update,
    get intent() { return intent; },
    get state() { return { ...state, requests }; },
    /** True while a model request is outstanding. */
    get busy() { return asking; },
    /** Force an immediate request, e.g. from a keypress. */
    poke() { nextAskAt = 0; return request(); },
    /**
     * Abandon the in-flight request and ask again now. Used when a manual
     * override appears — see the note on `interrupt()`.
     */
    interrupt,
    /** Drop to a plain wander and stop asking for a while. */
    quiet(ms = intervalMs) {
      intent = FALLBACK_INTENT;
      intentExpiresAt = simTime + FALLBACK_INTENT.duration_s;
      nextAskAt = now() + ms;
    },
  };
}

export { MAX_ACCEL, MAX_SPEED, NAV_MAX_SPEED, RESPONSE, APPROACH_RATE };
