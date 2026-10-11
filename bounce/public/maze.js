/**
 * The maze: a single grid, from which both the collision geometry and the
 * navigation graph are derived.
 *
 * Defining the maze twice — once as boxes, once as a graph — is the obvious way
 * to build this and the wrong one. The two would disagree the first time a wall
 * moved, and the failure would be a character that walks confidently into a
 * wall. So the grid is the only source of truth.
 *
 * Navigation is deterministic on purpose. The model picks *where to go*
 * (`charge_target`); this file decides *how to get there*. That is the same
 * split the whole project uses, and it is what keeps a 37-second model from
 * having to reason about a maze.
 */

/** Deterministic RNG so a maze is reproducible from a seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Grid sizing is derived from the character radius, which is the one thing that
 * has to fit through a corridor. A 2.0-radius character cannot pass a corridor
 * sized for a 0.6 one, and the model picks that radius freely.
 *
 * Clamped to 3..9 so a fat character still gets a real (if coarse) maze rather
 * than a 2x2 grid with nowhere to go.
 *
 * A corridor spans one cell, minus the wall thickness that intrudes from each
 * side, so the usable width is `pitch - wallThickness`.
 */
export function gridSizeFor(radius, usable, wallThickness = 0.35) {
  const wanted = Math.max(2.6, radius * 3.2) + wallThickness;
  let dims = Math.floor(usable / wanted);
  dims = Math.max(3, Math.min(9, dims));
  return { dims, pitch: usable / dims };
}

/**
 * Recursive-backtracker maze over a dims x dims grid of passable cells.
 *
 * Walls live on the *boundaries between* cells, not inside them, so a corridor
 * is one full cell wide. Representing walls as their own cells instead (a 2n+1
 * grid) would halve the corridor-to-wall ratio for the same footprint.
 *
 * Returns `{ open, edges }` where `open` marks passable cells and `edges` holds
 * the surviving walls, keyed 'H:x:y' or 'V:x:y'.
 */
export function carveMaze(dims, rng) {
  const at = (x, y) => y * dims + x;
  const open = new Uint8Array(dims * dims);

  // Every boundary starts walled; carving removes them.
  const edges = new Set();
  for (let y = 0; y < dims; y += 1) {
    for (let x = 0; x < dims; x += 1) {
      if (x < dims - 1) edges.add(`H:${x}:${y}`);
      if (y < dims - 1) edges.add(`V:${x}:${y}`);
    }
  }

  const stack = [];
  const sx = Math.floor(rng() * dims);
  const sy = Math.floor(rng() * dims);
  stack.push([sx, sy]);
  open[at(sx, sy)] = 1;

  const DIRS = [[1, 0, 'H', 0], [-1, 0, 'H', -1], [0, 1, 'V', 0], [0, -1, 'V', -1]];

  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const options = [];

    for (const [dx, dy, kind, back] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= dims || ny >= dims) continue;
      if (open[at(nx, ny)]) continue;
      options.push([nx, ny, kind, back]);
    }

    if (!options.length) { stack.pop(); continue; }

    const [nx, ny, kind, back] = options[Math.floor(rng() * options.length)];
    open[at(nx, ny)] = 1;
    // The wall is keyed from its lower/left cell, so normalise the direction.
    edges.delete(kind === 'H' ? `H:${Math.min(cx, nx)}:${cy}` : `V:${cx}:${Math.min(cy, ny)}`);
    void back;
    stack.push([nx, ny]);
  }

  return { open, edges };
}

/**
 * Shortest path between two cells, by breadth-first search over *walls*.
 *
 * The `edges` set is not optional. This originally checked only whether the
 * destination cell was open, which was correct for the first representation
 * (walls were whole cells) and silently wrong after the switch to walls on cell
 * boundaries — where every cell is open and BFS happily routed straight through
 * them. The character then followed a perfectly plausible route into a wall.
 *
 * BFS rather than A* because the graph is uniform-cost and tiny (at most 9x9);
 * a heuristic would be extra code for no gain. Returns cell coordinates, or null.
 */
export function findPath(open, dims, edges, from, to) {
  const at = (x, y) => y * dims + x;
  if (open[at(to[0], to[1])] !== 1) return null;

  const linked = (a, b) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (dx === 1 && dy === 0) return !edges.has(`H:${a[0]}:${a[1]}`);
    if (dx === -1 && dy === 0) return !edges.has(`H:${b[0]}:${b[1]}`);
    if (dx === 0 && dy === 1) return !edges.has(`V:${a[0]}:${a[1]}`);
    if (dx === 0 && dy === -1) return !edges.has(`V:${b[0]}:${b[1]}`);
    return false;
  };

  const prev = new Int32Array(dims * dims).fill(-1);
  const seen = new Uint8Array(dims * dims);
  const queue = [from];
  seen[at(from[0], from[1])] = 1;

  for (let head = 0; head < queue.length; head += 1) {
    const [cx, cy] = queue[head];
    if (cx === to[0] && cy === to[1]) break;

    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= dims || ny >= dims) continue;
      const i = at(nx, ny);
      if (seen[i] || open[i] !== 1) continue;
      if (!linked([cx, cy], [nx, ny])) continue;   // a wall is in the way
      seen[i] = 1;
      prev[i] = at(cx, cy);
      queue.push([nx, ny]);
    }
  }

  if (!seen[at(to[0], to[1])]) return null;

  const path = [];
  let cur = to;
  while (cur) {
    path.unshift(cur);
    const p = prev[at(cur[0], cur[1])];
    if (p === -1) break;
    cur = [p % dims, Math.floor(p / dims)];
  }
  return path;
}

/**
 * Build a complete maze.
 *
 * @param {object}  opts
 * @param {number}  opts.radius   character radius — sizes the corridors
 * @param {number}  opts.seed      reproducible layout
 * @param {number}  opts.halfExtent  half-size of the square the maze occupies
 */
/**
 * The maze's outer face sits at `halfExtent + 1.5 * wallThickness` (perimeter
 * centre, plus its own half-thickness). The arena wall's inner face is at 8.5,
 * so with the default 0.35 thickness `halfExtent` must stay at or below 7.975 or
 * the two interpenetrate — which reads as a doubled wall. 7.9 leaves a margin.
 */
export function buildMaze({ radius = 0.6, seed = 1, halfExtent = 7.9, wallHeight = 2.4, wallThickness = 0.35 }) {
  const rng = mulberry32(seed);
  const usable = halfExtent * 2;
  const { dims, pitch } = gridSizeFor(radius, usable, wallThickness);
  const { open, edges } = carveMaze(dims, rng);

  // Cell (0,0) is the low corner, so world x/z map linearly onto the grid.
  const origin = -halfExtent;
  const cellCentre = (i) => origin + (i + 0.5) * pitch;
  const toWorld = ([cx, cy]) => ({ x: cellCentre(cx), z: cellCentre(cy) });
  const toCell = (x, z) => [
    Math.max(0, Math.min(dims - 1, Math.floor((x - origin) / pitch))),
    Math.max(0, Math.min(dims - 1, Math.floor((z - origin) / pitch))),
  ];

  // One collider per surviving wall, sitting on the boundary it divides.
  // Unmerged: at this size there are only a few dozen, so merging would be code
  // for no measurable gain.
  const walls = [];
  for (const key of edges) {
    const [kind, sx, sy] = key.split(':');
    const x = Number(sx);
    const y = Number(sy);
    if (kind === 'H') {
      // between (x,y) and (x+1,y): a wall running along z
      walls.push({
        half: [wallThickness / 2, wallHeight, pitch / 2],
        pos: [origin + (x + 1) * pitch, wallHeight / 2, cellCentre(y)],
        restitution: 0.3,
      });
    } else {
      // between (x,y) and (x,y+1): a wall running along x
      walls.push({
        half: [pitch / 2, wallHeight, wallThickness / 2],
        pos: [cellCentre(x), wallHeight / 2, origin + (y + 1) * pitch],
        restitution: 0.3,
      });
    }
  }

  // Perimeter, so the character is confined to the maze rather than the gap
  // between the maze edge and the arena wall.
  const half = usable / 2 + wallThickness;
  const perimeter = [
    { half: [half, wallHeight, wallThickness / 2], pos: [0, wallHeight / 2, -half] },
    { half: [half, wallHeight, wallThickness / 2], pos: [0, wallHeight / 2, half] },
    { half: [wallThickness / 2, wallHeight, half], pos: [-half, wallHeight / 2, 0] },
    { half: [wallThickness / 2, wallHeight, half], pos: [half, wallHeight / 2, 0] },
  ];
  for (const w of perimeter) walls.push({ ...w, restitution: 0.3 });

  // Start and goal: the open corner cells furthest apart. Opposite corners is
  // what makes this a maze rather than a stroll.
  const corners = [[0, 0], [dims - 1, 0], [0, dims - 1], [dims - 1, dims - 1]]
    .filter(([x, y]) => open[y * dims + x] === 1);
  const startCell = corners[0] ?? [0, 0];
  const goalCell = corners.at(-1) ?? [dims - 1, dims - 1];

  return {
    dims,
    pitch,
    open,
    edges,
    seed,
    origin,
    halfExtent,
    wallThickness,
    walls,
    startCell,
    goalCell,
    toWorld,
    toCell,
    isOpen: (cell) => open[cell[1] * dims + cell[0]] === 1,
    /** Is there no wall between two orthogonally adjacent cells? */
    connected: (a, b) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      if (dx === 1 && dy === 0) return !edges.has(`H:${a[0]}:${a[1]}`);
      if (dx === -1 && dy === 0) return !edges.has(`H:${b[0]}:${b[1]}`);
      if (dx === 0 && dy === 1) return !edges.has(`V:${a[0]}:${a[1]}`);
      if (dx === 0 && dy === -1) return !edges.has(`V:${b[0]}:${b[1]}`);
      return false;   // not adjacent, so certainly not directly connected
    },
    pathBetween: (a, b) => findPath(open, dims, edges, a, b),
  };
}
