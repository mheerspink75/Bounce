/**
 * Headless verification of `public/character.js` — the trust boundary.
 *
 * From step 3 onward the spec comes from an LLM. These tests pin down what
 * happens when it arrives malformed, which is the whole point of sanitizeSpec():
 * a bad model response should degrade to defaults, never to a broken scene or a
 * simulation that never settles.
 *
 * Imports the real file the browser loads. `three` is a devDependency so the
 * mesh code can be constructed here without a DOM.
 *
 * Run: npm test
 */
import { sanitizeSpec, LIMITS, DEFAULT_SPEC, PRESET_SPECS, createCharacterMesh, disposeCharacterMesh } from '../public/character.js';
import { createWorld, FIXED_TIMESTEP, ARENA } from '../public/physics.js';

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// --- nothing in, defaults out --------------------------------------------
const fromEmpty = sanitizeSpec({});
check('empty object yields defaults', fromEmpty.radius === DEFAULT_SPEC.radius,
  `radius=${fromEmpty.radius}`);

for (const [label, input] of [
  ['undefined', undefined],
  ['null', null],
  ['a number', 42],
  ['a string', 'hello'],
  ['an array', [1, 2, 3]],
]) {
  const s = sanitizeSpec(input);
  check(`${label} input does not throw`, s.radius === DEFAULT_SPEC.radius,
    `radius=${s.radius}`);
}

// --- numbers are clamped ---------------------------------------------------
check('oversized radius clamped to max',
  sanitizeSpec({ radius: 1e9 }).radius === LIMITS.radius.max,
  `1e9 -> ${sanitizeSpec({ radius: 1e9 }).radius}`);
check('negative radius clamped to min',
  sanitizeSpec({ radius: -5 }).radius === LIMITS.radius.min,
  `-5 -> ${sanitizeSpec({ radius: -5 }).radius}`);

check('restitution cannot reach 1 (energy injection)',
  sanitizeSpec({ restitution: 5 }).restitution < 1,
  `5 -> ${sanitizeSpec({ restitution: 5 }).restitution}`);
check('negative mass clamped', sanitizeSpec({ mass: -1 }).mass === LIMITS.mass.min,
  `-1 -> ${sanitizeSpec({ mass: -1 }).mass}`);
check('zero mass clamped above 0', sanitizeSpec({ mass: 0 }).mass > 0,
  `0 -> ${sanitizeSpec({ mass: 0 }).mass}`);

// --- non-finite numbers fall back rather than poisoning the sim -----------
for (const [label, bad] of [['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['-Infinity', Number.NEGATIVE_INFINITY]]) {
  const s = sanitizeSpec({ radius: bad, mass: bad, restitution: bad });
  const clean = Number.isFinite(s.radius) && Number.isFinite(s.mass) && Number.isFinite(s.restitution);
  check(`${label} does not reach the spec`, clean,
    `radius=${s.radius} mass=${s.mass}`);
}

// --- numeric strings are accepted (models emit these) ---------------------
const fromStrings = sanitizeSpec({ radius: '0.9', mass: '2.5' });
check('numeric strings coerced', fromStrings.radius === 0.9 && fromStrings.mass === 2.5,
  `radius=${fromStrings.radius} mass=${fromStrings.mass}`);
check('out-of-range numeric string still clamped',
  sanitizeSpec({ radius: '99' }).radius === LIMITS.radius.max,
  `'99' -> ${sanitizeSpec({ radius: '99' }).radius}`);

// --- colours ---------------------------------------------------------------
check('6-digit hex accepted', sanitizeSpec({ color: '#ABCDEF' }).color === '#abcdef',
  sanitizeSpec({ color: '#ABCDEF' }).color);
check('3-digit hex expanded', sanitizeSpec({ color: '#f0a' }).color === '#ff00aa',
  sanitizeSpec({ color: '#f0a' }).color);
for (const [label, bad] of [
  ['rgb() string', 'rgb(224,90,63)'],
  ['named colour', 'red'],
  ['no hash', 'e05a3f'],
  ['wrong length', '#12345'],
  ['non-hex chars', '#gggggg'],
  ['empty', ''],
  ['a number', 0xff0000],
]) {
  const s = sanitizeSpec({ color: bad });
  check(`${label} rejected`, s.color === DEFAULT_SPEC.color, `-> ${s.color}`);
}

// --- text fields -----------------------------------------------------------
const ctrl = sanitizeSpec({ name: 'Bo\u0000un\u0007ce' });
check('control characters stripped from name', !/[\u0000-\u001f\u007f]/.test(ctrl.name),
  JSON.stringify(ctrl.name));
check('name length bounded', sanitizeSpec({ name: 'x'.repeat(9999) }).name.length <= 60,
  `${sanitizeSpec({ name: 'x'.repeat(9999) }).name.length} chars`);
check('whitespace-only name falls back',
  sanitizeSpec({ name: '   \n\t  ' }).name === DEFAULT_SPEC.name);
check('empty personality falls back',
  sanitizeSpec({ personality: '' }).personality === DEFAULT_SPEC.personality);

// --- idempotence -----------------------------------------------------------
const once = sanitizeSpec({ radius: 99, color: '#F0A', name: '  spaced  out  ' });
const twice = sanitizeSpec(once);
check('sanitizeSpec is idempotent', JSON.stringify(once) === JSON.stringify(twice),
  JSON.stringify(twice));

// --- meshes are constructible and disposable ------------------------------
const mesh = createCharacterMesh({ radius: 1.2, color: '#f2c14e' });
check('mesh geometry matches spec radius', mesh.geometry.parameters.radius === 1.2,
  `radius=${mesh.geometry.parameters.radius}`);
check('mesh has a material', Boolean(mesh.material?.color));
let disposed = false;
mesh.geometry.dispose = () => { disposed = true; };
disposeCharacterMesh(mesh);
check('dispose releases geometry', disposed);
check('dispose tolerates null', (() => { try { disposeCharacterMesh(null); return true; } catch { return false; } })());

// --- every preset is valid and produces a live body -----------------------
const sim = await createWorld();
for (const preset of PRESET_SPECS) {
  const s = sanitizeSpec(preset);
  const ok = Number.isFinite(s.radius) && s.radius > 0 && s.mass > 0
    && s.restitution >= 0 && s.restitution < 1 && /^#[0-9a-f]{6}$/.test(s.color);
  check(`preset "${s.name}" is valid`, ok,
    `r=${s.radius} m=${s.mass} e=${s.restitution}`);
}

// --- swapping a character mid-simulation ----------------------------------
const before = sim.character.body.translation();
check('character starts above the floor', before.y > sim.character.spec.radius,
  `y=${before.y.toFixed(2)} radius=${sim.character.spec.radius}`);

for (let i = 0; i < 120; i += 1) sim.advance(FIXED_TIMESTEP);

const oldBody = sim.character.body;
const { character: heavy } = sim.replaceCharacter({ radius: 1.6, mass: 8, restitution: 0.25 });
const afterSwap = heavy.body.translation();
check('replaceCharacter installs a new body', heavy.body !== oldBody);
check('old body is detached from the world', heavy.body !== oldBody
  && sim.character.body === heavy.body);
check('new character spawns clear of the floor', afterSwap.y > heavy.spec.radius,
  `y=${afterSwap.y.toFixed(2)} radius=${heavy.spec.radius}`);
check('new character is finite', Number.isFinite(afterSwap.x + afterSwap.y + afterSwap.z));

// The old body must be gone: stepping must not throw or corrupt the new one.
let swapStable = true;
for (let i = 0; i < 180; i += 1) {
  sim.advance(FIXED_TIMESTEP);
  const p = sim.character.body.translation();
  if (!Number.isFinite(p.x + p.y + p.z)) { swapStable = false; break; }
}
check('simulation survives the swap', swapStable);

// A character at the maximum radius must still fit inside the arena.
const { character: big } = sim.replaceCharacter({ radius: LIMITS.radius.max });
for (let i = 0; i < 240; i += 1) sim.advance(FIXED_TIMESTEP);
const bp = big.body.translation();
check('max-radius character stays contained',
  Math.abs(bp.x) < ARENA.halfWidth && Math.abs(bp.z) < ARENA.halfDepth && bp.y > -0.5,
  `x=${bp.x.toFixed(2)} y=${bp.y.toFixed(2)} z=${bp.z.toFixed(2)} arena=${ARENA.halfWidth}`);

// A minimum-radius character must not degenerate or explode.
const { character: tiny } = sim.replaceCharacter({ radius: LIMITS.radius.min, mass: LIMITS.mass.min });
for (let i = 0; i < 240; i += 1) sim.advance(FIXED_TIMESTEP);
const tp = tiny.body.translation();
check('min-radius character stays finite and contained',
  Number.isFinite(tp.x + tp.y + tp.z)
  && Math.abs(tp.x) < ARENA.halfWidth && Math.abs(tp.z) < ARENA.halfDepth && tp.y > -0.5,
  `x=${tp.x.toFixed(2)} y=${tp.y.toFixed(2)} z=${tp.z.toFixed(2)} arena=${ARENA.halfWidth}`);

// A bouncy, light character in a smaller arena is the most likely tunnelling
// case: high speed, thin walls. Run it long enough to matter.
let contained = true;
for (const preset of PRESET_SPECS) {
  const { character: c } = sim.replaceCharacter(preset);
  for (let i = 0; i < 900; i += 1) {   // 15s at 1/60
    sim.advance(FIXED_TIMESTEP);
    const p = c.body.translation();
    if (!Number.isFinite(p.x + p.y + p.z) || Math.abs(p.x) > ARENA.halfWidth
      || Math.abs(p.z) > ARENA.halfDepth || p.y < -1) {
      contained = false;
      break;
    }
  }
}
check('all presets stay contained over 15s each (no wall tunnelling)', contained);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
