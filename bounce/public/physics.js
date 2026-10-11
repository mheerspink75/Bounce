/**
 * The Rapier world: fixed arena + one character.
 *
 * Owns the fixed-timestep accumulator. Physics must NOT be driven by the render
 * loop's delta directly: on a slow frame the character would move further in one
 * step than its own radius and tunnel through the floor. See README §7 — this
 * machine renders 3D in software, so slow frames are the normal case, not an
 * edge case.
 *
 * The arena is static and not spec-driven. All world mutation happens here;
 * `character.js` only knows how to build a character, not where it lives.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { createCharacter, DEFAULT_SPEC, sanitizeSpec } from './character.js';
import { createNavigator } from './navigator.js';
import { buildMaze } from './maze.js';
import { TARGETS } from './targets.js';

export const FIXED_TIMESTEP = 1 / 60;

/** Longest frame delta we will believe. Anything more is a stall/tab-switch. */
const MAX_FRAME_DT = 0.25;

/**
 * Cap catch-up work so a stall can't trigger a death spiral of steps.
 *
 * Derived from MAX_FRAME_DT rather than set independently, because the two are
 * halves of one mechanism: the delta clamp decides how much time we are willing
 * to believe, and the substep cap decides how much of it we can actually
 * consume. When these disagreed (cap 5 = 0.083s, clamp 0.25s) the clamp was dead
 * code and the cap silently became the real limit — the simulation quietly ran
 * slow below 12 fps while the number that looked like it governed said 0.25s.
 *
 * Deriving one from the other means they cannot drift apart again.
 *
 * The cap is cheap here, which is why it is worth this much headroom. Measured on
 * this box (scripts/substep-budget.mjs), a 1/60s substep of a 21-body maze
 * costs 0.035ms, so 15 of them is 0.52ms — 0.6% of the 66-83ms frame this
 * software renderer takes. The old cap of 5 cost 0.17ms, so tripling it buys
 * real-time behaviour down to 4 fps instead of 12 for under half a millisecond.
 */
const MAX_SUBSTEPS = Math.ceil(MAX_FRAME_DT / FIXED_TIMESTEP);

export const ARENA = {
  // 18x18 play area. Sized so a default-radius (0.6) character reads clearly
  // against the space, and so the whole arena frames in one camera view.
  halfWidth: 9,
  halfDepth: 9,
  // Wall half-height, so the wall spans y = 0..5. Tall enough to contain a
  // character thrown off a wall bounce, short enough not to occlude the action
  // from a raised camera.
  wallHeight: 2.5,
  wallThickness: 0.5,
};

/** Quaternion from an axis and an angle in radians. */
function quatFromAxisAngle(axis, angle) {
  const half = angle / 2;
  const s = Math.sin(half);
  return {
    x: axis[0] * s,
    y: axis[1] * s,
    z: axis[2] * s,
    w: Math.cos(half),
  };
}

const { halfWidth: HW, halfDepth: HD, wallHeight: WH, wallThickness: WT } = ARENA;

/**
 * Static geometry. `half` is collider half-extents, `pos` is the centre in world
 * space, `rot` is a collider-local rotation.
 *
 * Restitution combines with the ball's by averaging, so surfaces are given lower
 * values than the ball to bleed energy off over time.
 */
const STATICS = [
  // Floor: top surface sits exactly at y = 0.
  { label: 'floor',    half: [HW + 1, 0.5, HD + 1], pos: [0, -0.5, 0], rot: null, restitution: 0.55 },
  // Walls, enclosing the play area.
  { label: 'wall -z',  half: [HW + 1, WH, WT], pos: [0, WH, -HD], rot: null, restitution: 0.7 },
  { label: 'wall +z',  half: [HW + 1, WH, WT], pos: [0, WH,  HD], rot: null, restitution: 0.7 },
  { label: 'wall -x',  half: [WT, WH, HD + 1], pos: [-HW, WH, 0], rot: null, restitution: 0.7 },
  { label: 'wall +x',  half: [WT, WH, HD + 1], pos: [ HW, WH, 0], rot: null, restitution: 0.7 },

  // Aimable obstacles. Shared with the proxy so the set of ids the model is
  // told it can target can never drift from the set that actually exists.
  // See public/targets.js.
  ...TARGETS.map((t) => ({
    id: t.id,
    label: t.label,
    half: t.half,
    pos: t.position,
    rot: t.rotationAxis ? quatFromAxisAngle(t.rotationAxis, t.rotationAngle) : null,
    restitution: t.restitution,
  })),
];

/** Aimable targets, resolved to plain positions for the brain. */
const TARGETS_BY_ID = TARGETS.map((t) => ({
  id: t.id,
  label: t.label,
  position: { x: t.position[0], y: t.position[1], z: t.position[2] },
}));

/**
 * Build the world. Must be awaited: it initialises the Rapier WASM module.
 *
 * The arena is fixed; only the character comes from the spec. All world
 * mutation stays in here — callers get `replaceCharacter()` rather than
 * reaching into the world themselves.
 */
export async function createWorld({ spec = DEFAULT_SPEC, mazeSeed = 1, maze = true } = {}) {
  await RAPIER.init();

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_TIMESTEP;

  // The maze is sized from the character's radius, so it has to be built around
  // the character rather than the other way round. `let`, not `const`: a model
  // can hand us a fatter character later, and the maze has to be rebuilt to fit
  // it. See `replaceCharacter`.
  let layout = maze
    ? buildMaze({ radius: spec.radius, seed: mazeSeed })
    : null;
  // A maze starts the character at rest on the start cell; the open arena
  // launches it so it rolls around on its own.
  //
  // A function, not a value. Both of its inputs move: `newMaze` installs a new
  // layout with a different start cell, and `rebuildMaze` re-grids for a new
  // radius so the same cell index maps to a different world position. It used to
  // be captured once at startup, which meant every later maze and every larger
  // character inherited the *first* maze's start cell and the *first* radius as
  // its height.
  //
  // The `y` matters most. `createCharacter` falls back to `SPAWN_Y = 7` — a
  // drop-in from above the open arena — whenever it is not told a height, and in a
  // maze that is 3.4m above the top of every wall. So the character fell in from
  // the sky, and a hard enough landing sent it over the walls: it read as the
  // walls having no collision at all. The floor's top face is y=0, so a ball of
  // radius r resting on it has its centre at y=r, and that is the only answer.
  function mazeSpawn(radius) {
    if (!layout) return undefined;
    return {
      ...layout.toWorld(layout.startCell),
      y: radius,
      launch: { x: 0, y: 0, z: 0 },
    };
  }

  /**
   * Would a ball of `radius` resting at (x, z) be inside a wall?
   *
   * XZ only, which is valid here and only here: the ball is resting on the floor
   * with its centre at y=radius, and every wall spans y=-1.2..3.6, so the
   * vertical ranges always intersect. A 2D test would be wrong for a ball in the
   * air — that mistake is what made this bug look like wall tunnelling when it
   * was a spawn height.
   */
  function embedsAWall(x, z, radius) {
    for (const w of layout.walls) {
      const [hx, , hz] = w.half;
      const [cx, , cz] = w.pos;
      const dx = Math.max(Math.abs(x - cx) - hx, 0);
      const dz = Math.max(Math.abs(z - cz) - hz, 0);
      if (Math.hypot(dx, dz) < radius) return true;
    }
    return false;
  }

  const initialSpawn = mazeSpawn(spec.radius);

  // Where the character was actually born, recorded rather than inferred.
  // Asserting "the character is at the start" against the live body is flaky —
  // the brain starts steering within a second and it has moved by then.
  const spawnPoint = { x: initialSpawn?.x ?? 0, z: initialSpawn?.z ?? 0 };

  // Which static bodies go in depends on whether we are running a maze.
  const bodies = maze
    ? [
      { label: 'floor', half: [HW + 1, 0.5, HD + 1], pos: [0, -0.5, 0], rot: null, restitution: 0.55 },
      // Maze walls grip rather than bounce. A maze wants a character that
      // scrubs speed off on contact; a bouncy ball ricochets down corridors and
      // overshoots every corner.
      ...layout.walls.map((w, i) => ({ label: `maze wall ${i}`, ...w, rot: null, friction: 0.95 })),
    ]
    : STATICS;

  const statics = bodies.map(addStatic);

  /** Create one static body and record it, so maze walls can be swapped later. */
  function addStatic(s) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(s.pos[0], s.pos[1], s.pos[2]),
    );

    let desc = RAPIER.ColliderDesc.cuboid(s.half[0], s.half[1], s.half[2])
      .setRestitution(s.restitution)
      .setFriction(s.friction ?? 0.4);
    if (s.rot) desc = desc.setRotation(s.rot);

    world.createCollider(desc, body);
    return { ...s, body };
  }

  /**
   * Tear down the current maze and build one sized for `radius`.
   *
   * Needed because the model picks `radius` freely: a maze sized for the
   * default 0.6 has ~2.4m corridors, and a `radius: 2.0` character is 4m
   * across. Without this it would be wedged in the first corridor forever, with
   * no way out and no error.
   *
   * Only rebuilds when the grid dimensions actually differ, so a same-size
   * replacement leaves the maze — and the run through it — untouched.
   */
  function rebuildMaze(radius) {
    const next = buildMaze({ radius, seed: layout.seed });
    if (next.dims === layout.dims) return false;
    installMaze(next);
    return true;
  }

  /**
   * Swap the maze in the world: remove the old walls, add the new ones, and
   * republish the start and goal.
   *
   * Deliberately does *not* touch the character. Where the character ends up is
   * the caller's decision, and the two callers want opposite things — a
   * radius-driven rebuild wants the character to stay put, while advancing to a
   * new maze wants it teleported to the new start before the old walls vanish.
   */
  function installMaze(next) {
    for (let i = statics.length - 1; i >= 0; i -= 1) {
      if (!statics[i].label.startsWith('maze wall')) continue;
      world.removeRigidBody(statics[i].body);
      statics.splice(i, 1);
    }
    for (const w of next.walls) {
      statics.push(addStatic({ label: 'maze wall', ...w, rot: null, friction: 0.95 }));
    }

    layout = next;
    goalPosition = next.toWorld(next.goalCell);
    startPosition = next.toWorld(next.startCell);
    // Bumped on every geometry change so a renderer can tell it needs to rebuild.
    //
    // This is not an optimisation. The maze advances every generation, and the
    // scene's wall meshes are built once from `statics` — so without this the
    // *drawn* walls stayed on the first maze while the *colliders* moved to the
    // new one. The character then walked through walls that were merely drawn
    // where the old maze had been, which reads as "the walls have no collision".
    // No headless test can catch it: the bug is entirely in the mismatch between
    // what is simulated and what is drawn.
    staticsVersion += 1;
  }

  /**
   * Advance to a new maze: new layout, new start, new goal, reward cleared.
   *
   * Order matters: the old walls come out *before* the character is respawned.
   * Spawning first looks safer — "never briefly embed it in geometry that is
   * about to disappear" — but it is the opposite: the new start cell can have a
   * wall standing on it in the outgoing layout, so the body is created inside a
   * static collider and Rapier resolves the penetration by ejecting it. Measured:
   * maze 2 became unsolvable, because the character was flung off its start.
   */
  function newMaze(seed) {
    if (!layout) return null;

    const nextSeed = Number.isFinite(seed) && seed > 0 ? Math.floor(seed) : layout.seed + 1;
    const next = buildMaze({ radius: character.spec.radius, seed: nextSeed });

    installMaze(next);

    world.removeRigidBody(character.body);
    character = createCharacter(world, character.spec, { spawn: mazeSpawn(character.spec.radius) });

    navigator = createNavigator({ maze: next, radius: character.spec.radius });
    reached = false;
    reward = null;
    generation += 1;

    return { seed: next.seed, dims: next.dims, goalCell: next.goalCell };
  }

  let character = createCharacter(world, spec, { spawn: initialSpawn });
  let navigator = layout ? createNavigator({ maze: layout, radius: spec.radius }) : null;

  // Maze state. `reached` latches on arrival so the win is detected once, not
  // every frame while the character sits in the goal.
  let goalPosition = layout ? layout.toWorld(layout.goalCell) : null;
  let startPosition = layout ? layout.toWorld(layout.startCell) : null;
  let reached = false;
  let reward = null;

  // How many mazes this session has been through. 0 until the first advance, so
  // the HUD can show "maze 1" from the start.
  let generation = 0;
  // Bumped whenever the static geometry is replaced, so a renderer knows to
  // rebuild. See `installMaze`.
  let staticsVersion = 0;

  let accumulator = 0;
  let simTime = 0;

  /**
   * Radius within which the character counts as having reached the goal.
   *
   * Kept as a second, generous safety net — but it is no longer the test. See
   * `evaluateGoal`.
   */
  const goalRadius = () => character.spec.radius + 0.5;

  /**
   * Has the character arrived?
   *
   * The trigger used to be "within `radius + 0.5` of the goal marker", and that
   * was a coin flip. Measured over 16 seeds at three radii, the margin between the
   * closest approach and the trigger was **4mm to 46mm** — and on one seed it was
   * exactly 0.000m, firing on the boundary. A test that passes by 4mm is not a
   * test, it is a coincidence that has not failed yet: any change at all — a
   * different intent from the model, one different bounce, the character being
   * resized, one more substep — flips it, and the ball then sits inside the goal
   * cell next to the marker with the reward never firing. Reported as "it gets
   * stuck right before the goal, like there is an invisible wall", which is
   * exactly what it looks like from outside.
   *
   * The maze already says what "arrived" means: it has a goal *cell*. Testing
   * that is both the semantically correct question and enormously more robust —
   * a 3.16m box instead of a 1.0m circle, capturing a ball up to 2.23m from the
   * marker if it stops at the cell's entrance, while still being bounded so it
   * cannot fire from across the maze.
   *
   * `toCell` clamps to the grid, so a ball sitting *outside* the perimeter would
   * be reported as being in the nearest edge cell — and if that were the goal
   * cell it would trigger from outside the maze. Hence the explicit bounds test.
   */
  function evaluateGoal() {
    if (!layout || reached) return;
    const p = character.body.translation();
    const g = goalPosition;

    const insideMaze = Math.abs(p.x) <= layout.halfExtent && Math.abs(p.z) <= layout.halfExtent;
    const inGoalCell = insideMaze
      && layout.toCell(p.x, p.z)[0] === layout.goalCell[0]
      && layout.toCell(p.x, p.z)[1] === layout.goalCell[1];

    const d = Math.hypot(p.x - g.x, p.z - g.z);

    if (inGoalCell || d <= goalRadius()) {
      reached = true;
      reward = {
        won: true,
        seed: layout.seed,
        maze: `${layout.dims}x${layout.dims}`,
        pathLength: layout.pathBetween(layout.startCell, layout.goalCell)?.length ?? 0,
        // How it actually arrived, which is worth knowing when reading a timeline:
        // `cell` means it reached the goal cell, `radius` means it got within
        // touching distance of the marker without ever entering the cell.
        via: inGoalCell ? 'cell' : 'radius',
      };
    }
  }

  return {
    world,
    statics,
    get character() { return character; },
    get maze() { return layout; },
    get navigator() { return navigator; },
    get goal() { return goalPosition; },
    get start() { return startPosition; },
    get spawn() { return { ...spawnPoint }; },
    /**
     * Increments every time the static geometry is replaced.
     *
     * A renderer must rebuild its meshes when this changes. The scene builds them
     * once from `statics`, and the maze advances every generation, so without
     * watching this the drawn walls stay on the first maze while the colliders
     * move — the character appears to walk through walls that are only *drawn*
     * where the old maze was.
     */
    get staticsVersion() { return staticsVersion; },

    /**
     * Total simulated seconds since the world was built. Compare against the
     * wall clock to see whether the simulation is keeping up.
     */
    get simTime() { return simTime; },
    get reached() { return reached; },
    get reward() { return reward; },
    /** Mazes completed-and-advanced past in this session. */
    get generation() { return generation; },

    /**
     * What the model is told about the objective.
     *
     * Distance and path length are what make the goal actionable rather than
     * just a name: a model choosing between "go to the goal" and "wander" needs
     * to know the goal is worth going to, and how far it is. Kept here, next to
     * the maze that owns the answer, so the numbers cannot go stale.
     */
    goalInfo() {
      if (!layout || !goalPosition) return null;
      const p = character.body.translation();
      const path = layout.pathBetween(layout.toCell(p.x, p.z), layout.goalCell);
      return {
        id: 'goal',
        cell: [...layout.goalCell],
        maze: `${layout.dims}x${layout.dims}`,
        seed: layout.seed,
        distance_m: Number(Math.hypot(p.x - goalPosition.x, p.z - goalPosition.z).toFixed(1)),
        // Null when the character is somehow walled off; better to admit that
        // than to report a route that does not exist.
        path_cells: path ? path.length - 1 : null,
        reached,
      };
    },

    /** Advance to a fresh maze. See `newMaze`. */
    newMaze(seed) { return newMaze(seed); },

    /** Things an intent can name. Cheap; returns a fresh array each call. */
    targets() { return TARGETS_BY_ID.map((t) => ({ ...t, position: { ...t.position } })); },

    /** Look up a target id, or null. Tolerates unknown ids from the model. */
    findTarget(id) {
      const key = String(id ?? '').toLowerCase();
      if (key === 'goal' && goalPosition) {
        return { id: 'goal', label: 'reward', position: { ...goalPosition } };
      }
      return TARGETS_BY_ID.find((t) => t.id === key) ?? null;
    },

    /**
     * Swap in a new character built from `rawSpec`, which is sanitized
     * internally. Returns the new record (sanitized spec + body + collider).
     *
     * A redesign is not a restart. Two bugs lived here:
     *
     * 1. The replacement spawned at the maze start, so every new character
     *    discarded the run in progress. Harmless-looking with a fast provider,
     *    ruinous with a slow one: NIM takes 14-58s to design a character, so
     *    the spec landed *mid-run* and threw away the walk. Measured on seed 1,
     *    12.1s of simulated time with the mock provider versus 30.5s with NIM —
     *    the difference was entirely re-walking the maze.
     * 2. The maze was sized for the *original* radius. The model picks radius
     *    freely, so a fatter replacement could wedge in the first corridor
     *    forever. The maze is now rebuilt when the new radius needs a different
     *    grid.
     *
     * Returns `{ character, mazeRebuilt }` so the caller can tell the user when
     * progress really was lost — which only happens if the maze changed.
     */
    replaceCharacter(rawSpec) {
      const previous = character.body.translation();
      const newRadius = sanitizeSpec(rawSpec).radius;

      // Build the new body off to one side; where it lands is decided below,
      // because "the maze may have been re-gridded for this radius" changes the
      // answer. `mazeSpawn` is re-evaluated after the rebuild so the height is the
      // *new* radius — the old stale `y` put a larger ball inside the floor, and
      // Rapier's answer to that is to fire it across the maze.
      let next = createCharacter(world, rawSpec, { spawn: mazeSpawn(newRadius) });
      const mazeRebuilt = layout ? rebuildMaze(next.spec.radius) : false;

      world.removeRigidBody(character.body);
      character = next;

      if (mazeRebuilt) {
        // The goal genuinely moved, so the run really is over. Say so honestly
        // rather than pretending the character simply wandered off.
        reached = false;
        reward = null;
        character = createCharacter(world, next.spec, { spawn: mazeSpawn(next.spec.radius) });
      } else {
        // Same maze: appear where the action is, resting on the floor rather than
        // dropped in from height — a 7m drop lands on top of a wall.
        //
        // "Where the action is" has to yield to legality. A *fatter* character at
        // the old position can be wider than the gap it is standing in, and a body
        // created inside a static collider gets ejected by the solver: measured
        // 0.37m of overlap, which is clean through a 0.35m wall. So the position is
        // kept only when it is actually valid, and otherwise snapped to the centre
        // of the cell it is in — which `gridSizeFor` guarantees is wide enough for
        // this radius, since a corridor is `pitch - wallThickness` and that is
        // sized to exceed the diameter.
        let x = previous.x;
        let z = previous.z;
        if (embedsAWall(x, z, next.spec.radius)) {
          const cell = layout.toCell(x, z);
          const centre = layout.toWorld(cell);
          x = centre.x;
          z = centre.z;
        }

        character = createCharacter(world, next.spec, {
          spawn: { x, y: next.spec.radius, z, launch: { x: 0, y: 0, z: 0 } },
        });
      }

      // A different radius means different clearance, and the navigator caches
      // the clearance it was built with.
      navigator = layout
        ? createNavigator({ maze: layout, radius: character.spec.radius })
        : null;

      return { character, mazeRebuilt };
    },

    /** Reset the goal so the loop can run again on the same maze. */
    resetGoal() {
      reached = false;
      reward = null;
      navigator?.reset();
      return true;
    },

    /**
     * Advance physics by one render frame's worth of elapsed time.
     * Returns the number of fixed substeps actually taken.
     */
    advance(frameDt) {
      accumulator += Math.min(frameDt, MAX_FRAME_DT);

      let steps = 0;
      while (accumulator >= FIXED_TIMESTEP && steps < MAX_SUBSTEPS) {
        world.step();
        evaluateGoal();
        accumulator -= FIXED_TIMESTEP;
        steps += 1;
      }

      // Still behind after the cap: drop the backlog rather than spiral.
      if (steps === MAX_SUBSTEPS) accumulator = 0;

      // Total simulated time, in seconds. Comparing this against the wall clock
      // is the only way to tell two very different problems apart: a simulation
      // that is running slow, and a character that is behaving badly. Both look
      // identical in a screenshot — "it took too long".
      simTime += steps * FIXED_TIMESTEP;
      return steps;
    },
  };
}
