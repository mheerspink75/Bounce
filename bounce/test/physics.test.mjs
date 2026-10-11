/**
 * Headless verification of the Rapier world in `public/physics.js`.
 *
 * Runs in Node, not the browser, so the physics can be validated without a GPU
 * or a browser. This matters here: the dev machine renders 3D in software and
 * no browser was attached to the authoring session (see README §7, §10).
 *
 * `public/physics.js` is imported directly — not copied — so this tests the real
 * file the browser loads. The only reason this works in Node is the
 * `devDependencies` entry in package.json; the browser itself loads Rapier from
 * a CDN via the import map in index.html.
 *
 * Run: npm test
 */
import { createWorld, FIXED_TIMESTEP, ARENA } from '../public/physics.js';

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// This suite covers the *open arena*. The default world is now a maze, whose
// walls would change the bounce geometry these checks depend on, so the arena is
// requested explicitly. Maze behaviour lives in navigation.test.mjs.
const sim = await createWorld({ maze: false });

check('world initialises', Boolean(sim.world));
check('arena statics created', sim.statics.length === 8, `${sim.statics.length} bodies`);
check('no maze or navigator in arena mode', sim.maze === null && sim.navigator === null);
check('character body created', Boolean(sim.character.body));

const r = sim.character.spec.radius;
const start = sim.character.body.translation();
check('character starts above floor', start.y > r, `y=${start.y.toFixed(2)}`);

// --- simulate 12 seconds at a steady 60fps -------------------------------
const FRAMES = 720;
let minY = Infinity;
let maxY = -Infinity;
let maxSpeed = 0;
let nonFinite = false;

// An apex is the MAX height of an upward hop, not the height on the frame the
// velocity flips positive. Track the peak across the whole flight.
let inFlight = false;
let flightMaxY = -Infinity;
const apexYs = [];

for (let i = 0; i < FRAMES; i += 1) {
  const steps = sim.advance(FIXED_TIMESTEP);
  if (steps !== 1) { nonFinite = true; break; }

  const p = sim.character.body.translation();
  const v = sim.character.body.linvel();

  if (!Number.isFinite(p.x + p.y + p.z + v.x + v.y + v.z)) { nonFinite = true; break; }

  minY = Math.min(minY, p.y);
  maxY = Math.max(maxY, p.y);
  maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));

  if (v.y > 0) {
    inFlight = true;
    flightMaxY = Math.max(flightMaxY, p.y);
  } else if (inFlight) {
    apexYs.push(flightMaxY);   // just passed the top of this hop
    inFlight = false;
    flightMaxY = -Infinity;
  }
}
const peakCount = apexYs.length;

check('no NaN/Infinity in state', !nonFinite);
// Tunnelling test: the floor slab spans y=-1..0, so "centre below the floor
// surface" is the real failure. Transient contact penetration of a few cm for a
// single frame at impact is normal discrete-solver behaviour, not a bug — that
// is asserted separately below with a loose bound.
check('never tunnelled through floor', minY > 0,
  `minY=${minY.toFixed(3)}, floor surface=0`);
check('penetration stays shallow', minY >= r - 0.02,
  `minY=${minY.toFixed(3)} vs resting height=${r}`);

// Real restitution check. Rapier combines the character's restitution with the
// surface's by averaging, so read both from their actual sources rather than
// hardcoding numbers that would silently drift. This is the check that catches
// a typo'd or unapplied setRestitution.
const charRestitution = sim.character.spec.restitution;
const floorRestitution = sim.statics.find((s) => s.label === 'floor').restitution;
const expectedApex = start.y * Math.pow((charRestitution + floorRestitution) / 2, 2);
const firstApex = apexYs[0] ?? 0;
check('restitution behaves as configured',
  firstApex > expectedApex * 0.7 && firstApex < expectedApex * 1.05,
  `first apex ${firstApex.toFixed(2)}m, expected ~${expectedApex.toFixed(2)}m `
  + `from a ${start.y.toFixed(2)}m drop (char e=${charRestitution}, floor e=${floorRestitution})`);

check('successive bounces lose energy',
  apexYs.length < 2 || apexYs.at(-1) < firstApex,
  `first ${firstApex.toFixed(2)}m -> last ${(apexYs.at(-1) ?? 0).toFixed(2)}m over ${peakCount} bounces`);
check('character reached a real apex', maxY > r * 2, `maxY=${maxY.toFixed(2)}`);
check('multiple bounces detected', peakCount >= 3, `${peakCount} apexes in 12s`);
check('reached realistic impact speed', maxSpeed > 5, `peak ${maxSpeed.toFixed(2)} m/s`);
// Worth knowing for the demo: with this damping the ball settles well inside 12s.
// Step 4's AI `charge_target` action is what keeps it moving.
const vEnd = sim.character.body.linvel();
const endSpeed = Math.hypot(vEnd.x, vEnd.y, vEnd.z);
check('character settles without tunnelling or escape', endSpeed < 5,
  `end speed ${endSpeed.toFixed(2)} m/s after ${peakCount} bounces`);

const p = sim.character.body.translation();
const limitX = ARENA.halfWidth - r;
const limitZ = ARENA.halfDepth - r;
check('contained within walls',
  Math.abs(p.x) <= limitX + 0.05 && Math.abs(p.z) <= limitZ + 0.05,
  `x=${p.x.toFixed(2)}/${limitX} z=${p.z.toFixed(2)}/${limitZ}`);

// --- substep cap under a stall -------------------------------------------
// Assert the invariant, not a literal. The cap is derived from MAX_FRAME_DT, so
// hardcoding a number here meant this test broke — correctly — when the cap was
// raised from 5 to 15 to keep real time at low frame rates. See
// test/timestep.test.mjs, which covers the rate behaviour properly.
const sim2 = await createWorld();
const EXPECTED_CAP = Math.ceil(0.25 / FIXED_TIMESTEP);
const capped = sim2.advance(5.0);          // pretend a 5-second freeze
check('substep cap respected on stall', capped === EXPECTED_CAP,
  `${capped} steps (cap is ${EXPECTED_CAP})`);
check('a stall advances no more than the frame clamp',
  capped * FIXED_TIMESTEP <= 0.25 + FIXED_TIMESTEP,
  `${(capped * FIXED_TIMESTEP).toFixed(3)}s of simulation from a 5s stall`);
const oneFrame = sim2.advance(FIXED_TIMESTEP);
check('recovers to 1 substep after stall', oneFrame === 1, `${oneFrame} step`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
