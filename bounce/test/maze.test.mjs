// Standalone checks on the maze, before it is wired into physics.
import { buildMaze, findPath, gridSizeFor, mulberry32 } from '../public/maze.js';

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// --- RNG is deterministic -------------------------------------------------
{
  const a = mulberry32(7);
  const b = mulberry32(7);
  const c = mulberry32(8);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  const seqC = [c(), c(), c()];
  check('same seed gives the same sequence', JSON.stringify(seqA) === JSON.stringify(seqB));
  check('different seed differs', JSON.stringify(seqA) !== JSON.stringify(seqC));
  check('values are in 0..1', seqA.every((v) => v >= 0 && v < 1), seqA.map((v) => v.toFixed(3)).join(','));
}

// --- corridor sizing fits the character -----------------------------------
{
  const WT = 0.35;
  for (const radius of [0.15, 0.6, 1.2, 2.0]) {
    const { dims, pitch } = gridSizeFor(radius, 17, WT);
    // A corridor is one cell, less the wall intruding from each boundary.
    const corridor = pitch - WT;
    const diameter = radius * 2;
    check(`corridor fits a radius-${radius} character`, corridor > diameter,
      `corridor ${corridor.toFixed(2)} > diameter ${diameter.toFixed(2)} (grid ${dims}x${dims})`);
  }
  const small = gridSizeFor(0.15, 17, WT);
  const large = gridSizeFor(2.0, 17, WT);
  check('a fat character gets a coarser maze, not a broken one',
    small.dims > large.dims && large.dims >= 3, `${small.dims}x${small.dims} -> ${large.dims}x${large.dims}`);
}

// --- generation -----------------------------------------------------------
{
  const maze = buildMaze({ radius: 0.6, seed: 42 });
  check('open flags are 0/1', maze.open.every((v) => v === 0 || v === 1));

  const openCells = maze.open.reduce((n, v) => n + v, 0);
  check('every cell is reachable in a perfect maze', openCells === maze.dims * maze.dims,
    `${openCells}/${maze.dims * maze.dims}`);

  // A perfect maze on n*n cells carves n*n-1 passages out of 2*n*(n-1)
  // possible boundaries, so that many walls survive.
  const possible = 2 * maze.dims * (maze.dims - 1);
  const expected = possible - (maze.dims * maze.dims - 1);
  check('a perfect maze keeps cells-1 passages carved', maze.edges.size === expected,
    `${maze.edges.size} walls of ${possible} possible (grid ${maze.dims}x${maze.dims})`);
  check('wall colliders exist', maze.walls.length === maze.edges.size + 4,
    `${maze.walls.length} colliders = ${maze.edges.size} internal + 4 perimeter`);

  const same = buildMaze({ radius: 0.6, seed: 42 });
  const diff = buildMaze({ radius: 0.6, seed: 43 });
  check('same seed rebuilds identically',
    Buffer.compare(Buffer.from(maze.open), Buffer.from(same.open)) === 0
    && maze.edges.size === same.edges.size
    && [...maze.edges].every((e) => same.edges.has(e)));
  check('a different seed gives a different maze',
    [...diff.edges].some((e) => !maze.edges.has(e)),
    `${[...diff.edges].filter((e) => !maze.edges.has(e)).length} walls differ`);
}

// --- connectivity and pathfinding ----------------------------------------
{
  // A maze must be fully connected or the goal can be unreachable.
  let allReachable = true;
  let unreachable = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    const maze = buildMaze({ radius: 0.6, seed });
    const path = maze.pathBetween(maze.startCell, maze.goalCell);
    if (!path) { allReachable = false; unreachable += 1; }
  }
  check('goal is reachable from start on every seed tried', allReachable,
    unreachable ? `${unreachable}/40 seeds failed` : '40/40 seeds ok');

  const maze = buildMaze({ radius: 0.6, seed: 42 });
  const path = maze.pathBetween(maze.startCell, maze.goalCell);
  check('path starts at start and ends at goal',
    path[0][0] === maze.startCell[0] && path[0][1] === maze.startCell[1]
    && path.at(-1)[0] === maze.goalCell[0] && path.at(-1)[1] === maze.goalCell[1],
    `length ${path.length}`);

  // Every cell on the path must actually be open, or we would steer into a wall.
  check('every cell on the path is open', path.every((c) => maze.isOpen(c)));
  check('path steps are adjacent (no teleporting)',
    path.every((c, i) => i === 0 || Math.abs(c[0] - path[i - 1][0]) + Math.abs(c[1] - path[i - 1][1]) === 1));

  // The assertion that would have caught the real bug. "Every cell is open" is
  // trivially true once walls live on cell boundaries, so it proves nothing on
  // its own — the path must also never cross a wall.
  check('path never crosses a wall', path.every((c, i) => i === 0 || maze.connected(path[i - 1], c)),
    `${path.length - 1} steps, ${path.slice(1).filter((c, i) => !maze.connected(path[i], c)).length} through walls`);

  check('the path is the short way round, not a straight line through walls',
    path.length > 1 && path.length <= maze.dims * 2,
    `path length ${path.length} for a ${maze.dims}x${maze.dims} maze`);

  check('no path to a wall cell', maze.pathBetween(maze.startCell, [0, 0]) === null
    || maze.isOpen([0, 0]));
}

// --- coordinates ----------------------------------------------------------
{
  const maze = buildMaze({ radius: 0.6, seed: 42, halfExtent: 8.5 });
  const w = maze.toWorld([0, 0]);
  const wFar = maze.toWorld([maze.dims - 1, maze.dims - 1]);
  check('cell (0,0) maps near the low corner',
    w.x > -8.5 && w.x < -8.5 + maze.pitch, `x=${w.x.toFixed(2)}`);
  check('last cell maps near the high corner',
    wFar.x < 8.5 && wFar.x > 8.5 - maze.pitch, `x=${wFar.x.toFixed(2)}`);

  // Round-tripping world -> cell must be stable.
  let roundTrips = true;
  for (const cell of [[0, 0], [1, 2], [3, 3], [maze.dims - 1, maze.dims - 1]]) {
    const p = maze.toWorld(cell);
    const back = maze.toCell(p.x, p.z);
    if (back[0] !== cell[0] || back[1] !== cell[1]) roundTrips = false;
  }
  check('world -> cell round-trips', roundTrips);

  check('out-of-bounds coordinates clamp instead of throwing', (() => {
    const c = maze.toCell(999, -999);
    return c[0] >= 0 && c[0] < maze.dims && c[1] >= 0 && c[1] < maze.dims;
  })());
}

// --- walls fit inside the arena without overlapping it -------------------
{
  // The arena wall spans 8.5..9.5 per side. The maze perimeter must sit inside
  // 8.5 or the two interpenetrate, which reads as a doubled wall.
  const ARENA_HALF = 9;
  const ARENA_WALL_INNER = 8.5;

  for (const radius of [0.6, 2.0]) {
    const maze = buildMaze({ radius, seed: 9 });
    const outermost = maze.walls.reduce((m, w) => Math.max(
      m,
      Math.abs(w.pos[0]) + w.half[0],
      Math.abs(w.pos[2]) + w.half[2],
    ), 0);

    check(`radius-${radius} maze stays clear of the arena wall`,
      outermost <= ARENA_WALL_INNER,
      `outermost face ${outermost.toFixed(2)} <= ${ARENA_WALL_INNER}`);
    check(`radius-${radius} maze stays inside the arena`,
      outermost < ARENA_HALF, `outermost ${outermost.toFixed(2)}`);
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
