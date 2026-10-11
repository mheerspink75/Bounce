/**
 * Headless tests for the brain.
 *
 * The brain is the component that turns model output into forces, so these
 * tests care less about "does it steer" and more about "can it break anything".
 * A model that returns intensity 1 aimed at a wall, forever, must not be able to
 * tunnel the character out of the arena.
 *
 * Imports the real modules. No browser, no network, no key.
 */
import { createBrain, MAX_ACCEL, MAX_SPEED, NAV_MAX_SPEED } from '../public/brain.js';
import { createWorld, FIXED_TIMESTEP, ARENA } from '../public/physics.js';
import { FALLBACK_INTENT, INTENTS } from '../public/intent.js';
import { TARGET_IDS } from '../public/targets.js';

/** Let pending microtasks settle, so an in-flight ask() can land. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Run the sim + brain for `seconds`, stepping at the fixed timestep. */
function run(sim, brain, seconds) {
  const frames = Math.round(seconds / FIXED_TIMESTEP);
  for (let i = 0; i < frames; i += 1) {
    brain.update(FIXED_TIMESTEP);
    sim.advance(FIXED_TIMESTEP);
  }
}

// --- construction ---------------------------------------------------------

{
  let threw = false;
  try { createBrain({}); } catch { threw = true; }
  check('createBrain requires a sim and ask()', threw);

  let threwNoAsk = false;
  try { createBrain({ sim: await createWorld({ maze: false }) }); } catch { threwNoAsk = true; }
  check('createBrain requires ask()', threwNoAsk);
}

// --- the slow/fast split --------------------------------------------------

{
  const sim = await createWorld({ maze: false });
  // A controllable clock: lets us prove pacing without real waiting.
  let clock = 0;
  let calls = 0;
  const brain = createBrain({
    sim,
    ask: async () => { calls += 1; return { action: 'wander', intensity: 0.5, duration_s: 3 }; },
    now: () => clock,
    intervalMs: 2000,
  });

  brain.update(FIXED_TIMESTEP);
  check('asks for an intent on the first frame', calls === 1 || brain.state.requests === 1,
    `requests=${brain.state.requests}`);

  await settle();
  check('intent applied after the request lands', brain.intent.action === 'wander',
    `action=${brain.intent.action}`);

  // 1 second of sim time, clock unmoved: should NOT ask again.
  const before = brain.state.requests;
  for (let i = 0; i < 60; i += 1) brain.update(FIXED_TIMESTEP);
  check('does not re-ask before the interval elapses', brain.state.requests === before,
    `requests=${brain.state.requests}`);

  // Advance the wall clock past the interval.
  clock = 2500;
  brain.update(FIXED_TIMESTEP);
  await settle();
  check('re-asks once the wall clock passes the interval', brain.state.requests > before,
    `requests=${brain.state.requests}`);
}

// --- failure handling -----------------------------------------------------

{
  const sim = await createWorld({ maze: false });
  const brain = createBrain({
    sim,
    ask: async () => { throw new Error('proxy unreachable'); },
    now: () => 0,
  });

  brain.update(FIXED_TIMESTEP);
  await settle();
  check('a failed request reports error status', brain.state.status === 'error',
    `status=${brain.state.status}`);
  check('a failed request degrades to a wander, not a freeze',
    brain.intent.action === 'wander', `action=${brain.intent.action}`);
  check('a failed request keeps moving', (() => {
    const p0 = sim.character.body.translation();
    run(sim, brain, 1.5);
    const p1 = sim.character.body.translation();
    return Math.hypot(p1.x - p0.x, p1.z - p0.z) > 0.2;
  })());
}

// --- the model cannot destabilise the sim --------------------------------

{
  const sim = await createWorld({ maze: false });
  // Hostile: maximum intensity, aimed at a real target, changed every call, and
  // a target id that does not exist. This is the worst thing a model can say.
  const hostileActions = ['charge_target', 'seek', 'wander', 'rest'];
  let n = 0;
  const brain = createBrain({
    sim,
    ask: async () => {
      const i = n++;
      return {
        action: hostileActions[i % hostileActions.length],
        target: i % 3 === 0 ? 'block_a' : (i % 3 === 1 ? 'does_not_exist' : null),
        intensity: 999,          // must clamp to 1
        duration_s: 1e9,         // must clamp to MAX_INTENT_DURATION
      };
    },
    now: () => 0,
  });

  let contained = true;
  let maxSpeed = 0;
  let badIntensity = false;
  let badDuration = false;

  for (let i = 0; i < 3600; i += 1) {   // 60 seconds
    brain.update(FIXED_TIMESTEP);
    sim.advance(FIXED_TIMESTEP);
    if (i % 10 === 0) await settle();

    const p = sim.character.body.translation();
    const v = sim.character.body.linvel();
    maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.z));

    if (brain.intent.intensity > 1 || brain.intent.intensity < 0) badIntensity = true;
    if (brain.intent.duration_s > 10) badDuration = true;

    if (!Number.isFinite(p.x + p.y + p.z)
      || Math.abs(p.x) > ARENA.halfWidth || Math.abs(p.z) > ARENA.halfDepth || p.y < -1) {
      contained = false;
      break;
    }
  }

  check('hostile intents clamp intensity to 0..1', !badIntensity);
  check('hostile intents clamp duration', !badDuration);
  check('hostile intents cannot escape the arena over 60s', contained);
  check('speed stays under the ceiling', maxSpeed <= MAX_SPEED + 0.5,
    `peak horizontal ${maxSpeed.toFixed(2)} m/s, ceiling ${MAX_SPEED}`);
}

// --- an unknown target falls back to wandering ---------------------------

{
  const sim = await createWorld({ maze: false });
  const brain = createBrain({
    sim,
    ask: async () => ({ action: 'charge_target', target: 'atlantis', intensity: 1, duration_s: 5 }),
    now: () => 0,
  });

  brain.update(FIXED_TIMESTEP);
  await settle();
  const p0 = sim.character.body.translation();
  run(sim, brain, 1.5);
  const p1 = sim.character.body.translation();
  check('unknown target still produces movement', Math.hypot(p1.x - p0.x, p1.z - p0.z) > 0.2,
    `moved ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2)}m`);
  check('unknown target is preserved for diagnostics', brain.intent.target === 'atlantis');
}

// --- rest applies no force ------------------------------------------------

{
  // `rest` is no longer "apply no force" — since steering became a velocity
  // servo, it means "brake to a stop". The previous test asserted bit-for-bit
  // equivalence with an unsteered world, which was true of the old position
  // controller and is deliberately no longer true of this one.
  //
  // The claim worth testing now is the intent: a resting character loses speed,
  // and an identical unsteered one does not.
  const withBrain = await createWorld({ maze: false });
  const control = await createWorld({ maze: false });

  const brain = createBrain({
    sim: withBrain,
    ask: async () => ({ action: 'rest', intensity: 1, duration_s: 30 }),
    now: () => 0,
  });

  brain.update(FIXED_TIMESTEP);
  await settle();
  check('rest is the active intent', brain.intent.action === 'rest');

  let controlTravel = 0;
  const controlStart = control.character.body.translation();
  for (let i = 0; i < 300; i += 1) {   // 5s
    brain.update(FIXED_TIMESTEP);
    withBrain.advance(FIXED_TIMESTEP);
    control.advance(FIXED_TIMESTEP);

    const b = control.character.body.translation();
    controlTravel = Math.max(controlTravel, Math.hypot(
      b.x - controlStart.x, b.y - controlStart.y, b.z - controlStart.z,
    ));
  }

  const resting = withBrain.character.body.linvel();
  const coasting = control.character.body.linvel();
  const restSpeed = Math.hypot(resting.x, resting.z);
  const coastSpeed = Math.hypot(coasting.x, coasting.z);

  check('rest brakes the character to a near stop', restSpeed < 0.2,
    `resting ${restSpeed.toFixed(3)} m/s`);
  // Relative rather than an absolute threshold: friction slows the control
  // anyway, so "the control is above N m/s" is a number that drifts with tuning.
  check('braking is what stopped it, not friction', restSpeed < coastSpeed * 0.5,
    `resting ${restSpeed.toFixed(3)} vs coasting ${coastSpeed.toFixed(3)} m/s`);
  check('the control world actually moved (comparison is meaningful)',
    controlTravel > 1, `control travelled ${controlTravel.toFixed(2)}m`);
}

// --- intent expiry --------------------------------------------------------

{
  const sim = await createWorld({ maze: false });
  const brain = createBrain({
    sim,
    ask: async () => ({ action: 'rest', intensity: 1, duration_s: 1 }),
    now: () => 0,
  });
  brain.update(FIXED_TIMESTEP);
  await settle();
  check('short intent is held', brain.intent.action === 'rest');

  // Past its duration and with no new request, it should have expired.
  run(sim, brain, 1.6);
  check('an expired intent falls back rather than persisting',
    brain.intent.action === FALLBACK_INTENT.action,
    `action=${brain.intent.action}`);
}

// --- targets agree between prompt and world -------------------------------

{
  const sim = await createWorld({ maze: false });
  const world = sim.targets().map((t) => t.id).sort();
  check('target ids match what the model is told', JSON.stringify(world) === JSON.stringify([...TARGET_IDS].sort()),
    `world=${world.join(',')}`);

  let allResolve = true;
  for (const id of TARGET_IDS) if (!sim.findTarget(id)) allResolve = false;
  check('every advertised target resolves', allResolve);

  // A case difference from the model should still resolve.
  check('target lookup is case-insensitive', Boolean(sim.findTarget('BLOCK_A')));
}

// --- latency is reported, including on failure ---------------------------

{
  // A slow free tier is the normal case, and timeouts are the common outcome.
  // Latency has to be visible then too, or the HUD reports nothing exactly when
  // the user most needs to know why.
  const sim = await createWorld({ maze: false });
  let clock = 0;
  const brain = createBrain({
    sim,
    ask: async () => { clock += 20000; throw new Error('timed out after 20s'); },
    now: () => clock,
  });

  brain.update(FIXED_TIMESTEP);
  await settle();
  check('latency is recorded when the request FAILS', brain.state.lastLatencyMs === 20000,
    `lastLatencyMs=${brain.state.lastLatencyMs}`);
  check('average latency is tracked on failure too', brain.state.avgLatencyMs === 20000,
    `avgLatencyMs=${brain.state.avgLatencyMs}`);
  check('failure status and message are both kept',
    brain.state.status === 'error' && /timed out/.test(brain.state.lastError ?? ''),
    `${brain.state.status} / ${brain.state.lastError}`);
}

{
  const sim = await createWorld({ maze: false });
  let clock = 0;
  const brain = createBrain({
    sim,
    ask: async () => { clock += 500; return { action: 'wander' }; },
    now: () => clock,
  });
  brain.update(FIXED_TIMESTEP);
  await settle();
  check('latency is recorded on success too', brain.state.lastLatencyMs === 500,
    `lastLatencyMs=${brain.state.lastLatencyMs}`);
}

// --- poke and quiet ------------------------------------------------------

{
  const sim = await createWorld({ maze: false });
  let calls = 0;
  let clock = 0;
  const brain = createBrain({ sim, ask: async () => { calls += 1; return { action: 'wander' }; }, now: () => clock });

  await brain.poke();
  await settle();
  check('poke forces an immediate request', calls === 1, `calls=${calls}`);

  brain.quiet(10_000);
  clock = 5_000;                      // still inside the quiet window
  brain.update(FIXED_TIMESTEP);
  await settle();
  check('quiet suppresses requests inside its window', calls === 1, `calls=${calls}`);

  clock = 10_001;                     // window elapsed
  brain.update(FIXED_TIMESTEP);
  await settle();
  check('requests resume once the quiet window passes', calls === 2, `calls=${calls}`);
}

// --- a manual override interrupts a slow in-flight request ---------------
{
  // This is what makes the manual channel manual. The brain paces requests from
  // completion, so with a slow model call outstanding it asks for nothing — and
  // a manual intent was stuck in a queue behind it. Measured on the maze: 22 of
  // 30 seconds spent waiting for a request nobody wanted.
  let release;
  const gate = new Promise((r) => { release = r; });
  let aborted = false;
  let calls = 0;

  const sim = await createWorld({ maze: false });
  const brain = createBrain({
    sim,
    ask: async ({ signal } = {}) => {
      calls += 1;
      if (calls === 1) {
        // First call hangs, as a slow provider would.
        await Promise.race([
          gate,
          new Promise((_, rej) => signal?.addEventListener('abort', () => {
            aborted = true;
            rej(new Error('aborted'));
          })),
        ]);
        return { action: 'wander', intensity: 0.5, duration_s: 3 };
      }
      // The retry, which is what an override triggers.
      return { action: 'charge_target', target: 'block_a', intensity: 1, duration_s: 5 };
    },
    now: () => Date.now(),
  });

  brain.update(FIXED_TIMESTEP);            // fires the hanging request
  const askedWhileHanging = calls;
  check('the first request is in flight', askedWhileHanging === 1 && brain.busy === true);

  // A second update must NOT stack another request.
  brain.update(FIXED_TIMESTEP);
  check('a second update does not stack requests', calls === 1, `${calls} calls`);

  // Now the override arrives.
  brain.interrupt();
  await new Promise((r) => setTimeout(r, 10));

  check('interrupt aborted the slow request', aborted === true);
  check('interrupt retried immediately rather than waiting for the timeout', calls === 2, `${calls} calls`);
  check('the overridden intent is in force',
    brain.intent.action === 'charge_target' && brain.intent.target === 'block_a',
    JSON.stringify(brain.intent));
  check('an interrupt is not reported as an error', brain.state.status !== 'error',
    `status=${brain.state.status}`);

  release();
  await new Promise((r) => setTimeout(r, 10));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
