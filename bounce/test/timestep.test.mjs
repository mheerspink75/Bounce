/**
 * The simulation must keep up with real time, and must degrade honestly when it
 * cannot.
 *
 * This exists because a substep cap that is too tight does not fail loudly. It
 * just makes everything quietly slower than the wall clock, so the character
 * appears sluggish and every timing the project reports is wrong — while every
 * test still passes, because the tests assert outcomes rather than rates.
 */
import { createWorld, FIXED_TIMESTEP } from '../public/physics.js';
import { DEFAULT_SPEC } from '../public/spec.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/**
 * Step a world for `seconds` of simulated time using a fixed render rate, and
 * report how much simulation time actually elapsed. A ratio of 1 means real time.
 */
async function advanceOver({ fps, seconds, spec = DEFAULT_SPEC, mazeSeed = 1 }) {
  const sim = await createWorld({ spec, mazeSeed });
  const frameDt = 1 / fps;
  const frames = Math.round(seconds * fps);
  let advanced = 0;

  for (let i = 0; i < frames; i += 1) {
    advanced += sim.advance(frameDt) * FIXED_TIMESTEP;
    if (i % 200 === 0) await settle();
  }
  return { sim, advanced, requested: frames * frameDt };
}

// --- real time is kept at every frame rate this box actually produces ------
{
  // 12-15 fps is what the software renderer measures here, and 12 was previously
  // the exact break point where the simulation started running slow.
  for (const fps of [60, 30, 20, 15, 12, 10, 8, 6, 5, 4]) {
    const { advanced, requested } = await advanceOver({ fps, seconds: 3 });
    const ratio = advanced / requested;
    check(`keeps real time at ${fps} fps`, ratio > 0.999,
      `${advanced.toFixed(2)}s simulated of ${requested.toFixed(2)}s requested (${(ratio * 100).toFixed(1)}%)`);
  }
}

// --- a stall is clamped, not obeyed ---------------------------------------
{
  // A backgrounded tab can hand us a multi-second delta. Believing it would
  // teleport the character and skip the maze entirely.
  const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: 1 });
  const steps = sim.advance(5.0);
  check('a 5s stall does not run 5s of simulation', steps <= 16, `${steps} substeps`);
  check('a 5s stall is still bounded work', steps * FIXED_TIMESTEP <= 0.26,
    `${(steps * FIXED_TIMESTEP).toFixed(3)}s of simulation from a 5s stall`);

  // And the character must still be findable afterwards — not launched across
  // the maze by the accumulated backlog.
  const p = sim.character.body.translation();
  check('the character is still in the maze after a stall',
    Math.abs(p.x) < 8.5 && Math.abs(p.z) < 8.5,
    `at (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
}

// --- no drift over a long run ---------------------------------------------
{
  // Floating-point drift would show up as a slow loss of real time, which is
  // exactly the bug this suite exists to catch. An hour of simulated time.
  const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: 2 });
  const frameDt = 1 / 12;
  let advanced = 0;
  const frames = 60 * 60 * 12;   // 3600 frames = 300s at 12 fps
  for (let i = 0; i < frames; i += 1) {
    advanced += sim.advance(frameDt) * FIXED_TIMESTEP;
    if (i % 400 === 0) await settle();
  }
  const requested = frames * frameDt;
  const ratio = advanced / requested;
  check('no real-time drift over 5 minutes at 12 fps', ratio > 0.999,
    `${(ratio * 100).toFixed(3)}% of real time (${advanced.toFixed(1)}s / ${requested.toFixed(1)}s)`);
}

// --- the cap and the clamp agree ------------------------------------------
{
  // The regression that motivated deriving one from the other. If someone sets
  // MAX_SUBSTEPS back to a hand-picked 5, this fails and points straight at it.
  const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: 1 });
  const needed = Math.ceil(0.25 / FIXED_TIMESTEP);
  check('the full 0.25s clamp is actually consumable', sim.advance(0.25) === needed,
    `consumed ${sim.advance(0.25)} substeps, needs ${needed} to honour 0.25s`);
}

// --- a heavy world still makes progress -----------------------------------
{
  // A fat character in a coarse maze has more contacts, so it is the worst case
  // for substep cost. Real time should hold regardless of body size.
  const spec = { ...DEFAULT_SPEC, name: 'Fat', radius: 1.8, mass: 6, restitution: 0.3 };
  const { advanced, requested } = await advanceOver({ fps: 8, seconds: 2, spec });
  check('keeps real time with a radius-1.8 character at 8 fps',
    advanced / requested > 0.999,
    `${(advanced / requested * 100).toFixed(1)}% of real time`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
