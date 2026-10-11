/**
 * The character must be findable, not merely legal.
 *
 * Four separate bugs were reported as "the ball passes through the walls". Three
 * were real faults — a spawn height above the walls, a stale spawn on resize, and
 * drawn walls that never followed the colliders. The fourth was neither: the ball
 * was inside a legal corridor the whole time and simply could not be seen.
 *
 * The walls are 2.4m tall and opaque, and they cannot be shortened — a radius-2.0
 * character rests with its centre at y=2.0, so walls below ~2.4 let the largest
 * characters roll out (measured max centre height 2.036m over 5 radii x 4 seeds).
 * With walls that tall, occlusion from any camera that still reads as 3D is
 * unavoidable. Measured by raycast from the camera to the character:
 *
 *   42deg look-down   36-60% of frames hidden
 *   53deg             58%
 *   62deg              6%
 *   73deg              0-61%, depending on the seed
 *
 * Seed 2 is the stubborn one: the ball spends its time in the far half of a
 * corridor with the near wall between it and the camera, so steepening the camera
 * cannot fix it without abandoning the 3D view entirely.
 *
 * So the guarantee is a depth-independent locator shell drawn over the walls
 * (`createLocatorMesh`). This asserts the *guarantee* — that something is always
 * drawn at the character's position regardless of occlusion — rather than
 * pretending the geometry can be arranged so occlusion never happens.
 *
 *   node test/visibility.test.mjs      (needs the static server on :8080)
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PAGE = process.env.BOUNCE_URL ?? 'http://localhost:8080/';

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await chromium.launch();

console.log('\nvisibility: the character can always be found\n');

/**
 * Is a depth-independent marker drawn at the character's position?
 *
 * This is the property that actually matters, and it is checkable regardless of
 * where the walls are: something is rendered on top of them, at the body.
 */
async function locatorState(page) {
  return page.evaluate(() => {
    const { sim, scene, camera } = window.bounce;
    let locator = null;
    scene.traverse((o) => { if (o.name === 'characterLocator') locator = o; });
    if (!locator) return { present: false };

    const t = sim.character.body.translation();
    const offset = Math.hypot(
      locator.position.x - t.x,
      locator.position.y - t.y,
      locator.position.z - t.z,
    );
    const mat = locator.material;

    return {
      present: true,
      depthTest: mat.depthTest,
      depthWrite: mat.depthWrite,
      renderOrder: locator.renderOrder,
      visible: locator.visible,
      followsBody: +offset.toFixed(4),
      radius: +locator.geometry.parameters.radius.toFixed(3),
      bodyRadius: sim.character.spec.radius,
      camDist: +Math.hypot(camera.position.x, camera.position.y, camera.position.z).toFixed(1),
    };
  });
}

/** How often is the *real* mesh hidden? Recorded, not asserted. */
async function occlusionPct(page, ms = 6000) {
  return page.evaluate(async (limit) => {
    const THREE = await import('three');
    const { sim, scene, camera } = window.bounce;
    const group = scene.children
      .find((c) => c.isGroup && c.children.some((m) => m.userData?.label === 'floor'));
    const walls = group.children.filter((c) => String(c.userData?.label ?? '').startsWith('maze wall'));
    const mesh = sim.character.spec.radius;
    void mesh;
    const rc = new THREE.Raycaster();
    const tg = new THREE.Vector3();
    const dr = new THREE.Vector3();
    let frames = 0; let occ = 0; let maxD = 0;
    const t0 = performance.now();
    await new Promise((done) => {
      const tick = () => {
        const t = sim.character.body.translation();
        tg.set(t.x, t.y, t.z);
        dr.copy(tg).sub(camera.position);
        maxD = Math.max(maxD, dr.length());
        rc.set(camera.position, dr.normalize());
        rc.far = maxD;
        frames += 1;
        if (rc.intersectObjects(walls, false).length) occ += 1;
        if (performance.now() - t0 < limit) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    return (100 * occ) / frames;
  }, ms);
}

for (const seed of [1, 2, 3, 7]) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(`${PAGE}?seed=${seed}`);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30_000 });
  await page.waitForTimeout(700);

  const s = await locatorState(page);
  check(`seed ${seed}: a locator shell exists`, s.present === true);
  if (s.present) {
    check(`seed ${seed}: it ignores depth, so walls cannot hide it`,
      s.depthTest === false && s.depthWrite === false,
      `depthTest=${s.depthTest} depthWrite=${s.depthWrite}`);
    check(`seed ${seed}: it draws last`, s.renderOrder >= 999, `renderOrder=${s.renderOrder}`);
    check(`seed ${seed}: it tracks the body`, s.followsBody !== null && s.followsBody < 0.001,
      `offset ${s.followsBody}m`);
    check(`seed ${seed}: it is sized to the character`,
      Math.abs(s.radius - s.bodyRadius * 1.08) < 0.01,
      `locator r=${s.radius} vs body r=${s.bodyRadius}`);
  }
  const occ = await occlusionPct(page);
  console.log(`      (raw mesh hidden behind a wall in ${occ.toFixed(0)}% of frames — the locator covers this)`);
  await page.close();
}

// The locator must survive a character swap, resized to the new spec.
{
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(PAGE);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30_000 });
  await page.evaluate(() => {
    const spec = { ...window.bounce.sim.character.spec, radius: 1.5 };
    window.bounce.applySpec(spec);
  });
  await page.waitForTimeout(500);
  const s = await locatorState(page);
  check('a new character gets a matching locator, not the old one\'s',
    Math.abs(s.radius - s.bodyRadius * 1.08) < 0.01,
    `locator r=${s.radius} vs new body r=${s.bodyRadius}`);
  const stale = await page.evaluate(() => {
    let n = 0;
    window.bounce.scene.traverse((o) => { if (o.name === 'characterLocator') n += 1; });
    return n;
  });
  check('exactly one locator in the scene after a swap (no leak)', stale === 1, `${stale} found`);
  await page.close();
}

// The orbit limit is part of the fix: a user who drags the camera back to the old
// shallow angle should not be able to walk into the same misreading.
{
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto(PAGE);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30_000 });
  const l = await page.evaluate(() => {
    const c = window.bounce.controls;
    return { min: c?.minPolarAngle, max: c?.maxPolarAngle };
  });
  check('orbit is constrained to a readable pitch',
    l.max !== undefined && l.max <= 0.31,
    `polar ${l.min}..${l.max} rad = ${(90 - l.max * 180 / Math.PI).toFixed(0)}deg look-down at worst`);
  await page.close();
}

await browser.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
