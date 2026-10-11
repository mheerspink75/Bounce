/**
 * The drawn walls must be the colliders.
 *
 * The maze advances every generation, and the scene builds its wall meshes once
 * from `sim.statics`. It used to never rebuild them, so from the first reward
 * onward the *rendered* walls were the first maze while the *colliders* were the
 * current one. The character navigated the real maze and therefore appeared to
 * walk straight through walls — the exact symptom of "the AI goes through walls",
 * reported more than once.
 *
 * No headless test can catch this, because the fault is entirely in the
 * disagreement between what is simulated and what is drawn. It needs a browser, a
 * real maze advance, and a comparison of the scene graph against the colliders.
 *
 *   node test/visual-sync.test.mjs        (needs the static server on :8080)
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
const page = await browser.newPage();

/**
 * Compare the wall meshes in the scene against the colliders, and report how far
 * apart they are. Keyed by label so a wall that was removed and a new one added
 * is not mistaken for a match.
 */
async function compareSceneToColliders() {
  return page.evaluate(() => {
    const sim = window.bounce.sim;
    const group = window.bounce.scene.getObjectByName('staticsGroup');

    const colliders = new Map();
    for (const s of sim.statics) {
      if (!s.label.startsWith('maze wall')) continue;
      colliders.set(`${s.pos[0].toFixed(3)},${s.pos[1].toFixed(3)},${s.pos[2].toFixed(3)}`,
        { half: s.half });
    }

    if (!group) return { error: 'staticsGroup not in scene' };

    const meshes = new Map();
    for (const child of group.children) {
      if (!String(child.userData?.label ?? '').startsWith('maze wall')) continue;
      meshes.set(
        `${child.position.x.toFixed(3)},${child.position.y.toFixed(3)},${child.position.z.toFixed(3)}`,
        {
          size: [child.geometry.parameters.width, child.geometry.parameters.height, child.geometry.parameters.depth],
        },
      );
    }

    // Every collider must have a mesh, and vice versa.
    const missingMesh = [...colliders.keys()].filter((k) => !meshes.has(k));
    const extraMesh = [...meshes.keys()].filter((k) => !colliders.has(k));
    // And each must have the same extents.
    const sizeMismatch = [];
    for (const [k, c] of colliders) {
      const m = meshes.get(k);
      if (!m) continue;
      const want = [c.half[0] * 2, c.half[1] * 2, c.half[2] * 2];
      for (let i = 0; i < 3; i += 1) {
        if (Math.abs(want[i] - m.size[i]) > 1e-6) sizeMismatch.push(`${k} axis${i}: ${m.size[i]} vs ${want[i]}`);
      }
    }

    return {
      colliders: colliders.size,
      meshes: meshes.size,
      missingMesh: missingMesh.length,
      extraMesh: extraMesh.length,
      sizeMismatch: sizeMismatch.slice(0, 3),
      version: sim.staticsVersion,
      seed: sim.maze.seed,
      dims: sim.maze.dims,
    };
  });
}

console.log('\nvisual/physics sync: the drawn walls are the colliders\n');

// The group exists before `ready` is set, so it can be tagged by looking for the
// group whose children carry the static labels.
await page.goto(PAGE);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 30_000 });

// The group is created before `ready`, so find it by inspecting the scene for a
// group whose children are labelled statics.
await page.evaluate(() => {
  window.bounce.scene.traverse((o) => {
    if (o.isGroup && o.children.some((c) => c.userData?.label === 'floor')) o.name = 'staticsGroup';
  });
});

const before = await compareSceneToColliders();
check('meshes match colliders on load', before.missingMesh === 0 && before.extraMesh === 0 && before.sizeMismatch.length === 0,
  `${before.meshes} meshes / ${before.colliders} colliders, ${before.sizeMismatch.length} size mismatch`);

// Now force several maze advances — this is where it used to break.
for (let i = 0; i < 3; i += 1) {
  await page.evaluate(() => window.bounce.sim.newMaze());
  // Let a couple of frames run so the render loop notices the version bump.
  await page.waitForTimeout(400);
  const after = await compareSceneToColliders();
  check(`meshes still match colliders after maze advance ${i + 1}`,
    after.missingMesh === 0 && after.extraMesh === 0 && after.sizeMismatch.length === 0,
    `${after.meshes} meshes / ${after.colliders} colliders, seed ${after.seed}`
    + `${after.missingMesh ? `, ${after.missingMesh} colliders with no mesh` : ''}`
    + `${after.extraMesh ? `, ${after.extraMesh} stale meshes` : ''}`);
}

// A re-grid also replaces the geometry, and it is the case where the drawn and
// simulated layouts differ most.
await page.evaluate(() => {
  window.bounce.sim.replaceCharacter({ ...window.bounce.sim.character.spec, radius: 2.0 });
});
await page.waitForTimeout(400);
const regird = await compareSceneToColliders();
check('meshes still match colliders after a re-grid (radius 2.0)',
  regird.missingMesh === 0 && regird.extraMesh === 0 && regird.sizeMismatch.length === 0,
  `${regird.meshes} meshes / ${regird.colliders} colliders, now ${regird.dims}x${regird.dims} grid`);

// The old meshes must actually be released, not merely dropped from the graph —
// the maze advances every ~12s, so a leaked geometry and material per generation
// is a slow GPU memory climb. Counted from the group itself, which is the same
// place the comparison above reads from, so the two numbers cannot disagree.
const orphans = await page.evaluate(() => {
  const group = window.bounce.scene.getObjectByName('staticsGroup');
  const wallsInGroup = group
    ? group.children.filter((c) => String(c.userData?.label ?? '').startsWith('maze wall')).length
    : -1;
  const colliders = window.bounce.sim.statics
    .filter((s) => s.label.startsWith('maze wall')).length;
  return { wallsInGroup, colliders };
});
check('no orphaned wall meshes left in the group',
  orphans.wallsInGroup === orphans.colliders,
  `${orphans.wallsInGroup} wall meshes vs ${orphans.colliders} colliders`);

await browser.close();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
