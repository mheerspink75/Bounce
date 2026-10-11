/**
 * Navigation: turns a maze and a character position into somewhere to steer
 * next.
 *
 * The character is a ball with momentum, so "point at the goal" is not enough —
 * it drives into walls. This walks a path through the maze and hands the brain
 * one waypoint at a time.
 *
 * Navigation is deliberately deterministic. The model chooses the *goal*; this
 * chooses the route. A 37-second-latency model cannot reason about a maze, and
 * it should not have to — that split is what lets a small or slow model still
 * produce a competent walk.
 */

/** How many cells ahead we will consider skipping to in one go. */
const LOOKAHEAD = 4;

export function createNavigator({ maze, radius = 0.6 }) {
  // Clearance the character needs when testing whether a straight line is clear.
  const clearance = radius + 0.15;

  /**
   * True if the straight segment a->b cannot be walked.
   *
   * The test is cell-to-cell connectivity along the line, nothing else.
   *
   * Two earlier versions got this wrong in opposite directions, and both are
   * worth remembering. Sampling for wall *cells* near each point stepped over
   * the 0.35m-thick walls entirely (0.79m sampling), reporting a wall as clear.
   * Adding a "keep clear of walls" margin then overcorrected: the line legitimately
   * crosses a boundary to get from one cell to the next, and the margin rejected
   * every crossing — so the navigator could never route out of the cell the
   * character was standing in, and reported the *next waypoint* unreachable.
   *
   * Connectivity is the whole answer. Corridor width already exceeds the
   * character's diameter, so physical clearance takes care of corners.
   */
  function isBlocked(a, b) {
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(2, Math.ceil(dist / (maze.pitch * 0.2)));

    let prev = null;
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const cell = maze.toCell(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);

      if (!maze.isOpen(cell)) return true;
      if (prev && (cell[0] !== prev[0] || cell[1] !== prev[1])) {
        if (!maze.connected(prev, cell)) return true;
      }
      prev = cell;
    }
    return false;
  }

  /**
   * Where to steer next, given a target world position.
   *
   * Stateless on purpose. An earlier version cached the route and advanced an
   * index, which needs invalidation whenever a bounce puts the character
   * somewhere it cannot see its waypoint from — and since `isBlocked` is
   * deliberately pessimistic near walls, that check fired almost every frame and
   * the route thrashed, which was worse than the bug it fixed. The grid is at
   * most 9x9, so a breadth-first search per frame is free by comparison, and
   * "recompute from where I am now" cannot go stale.
   *
   * Returns `{ point, remaining, mode }` — `mode` is 'direct' when the line is
   * clear (so behaviour in an open arena is unchanged) or 'path' when routing.
   */
  function nextWaypoint(from, target) {
    if (!isBlocked(from, target)) {
      return { point: { x: target.x, z: target.z }, remaining: 0, mode: 'direct' };
    }

    const fromCell = maze.toCell(from.x, from.z);
    const goalCell = maze.toCell(target.x, target.z);
    const path = maze.pathBetween(fromCell, goalCell);

    if (!path || path.length < 2) {
      return { point: { x: target.x, z: target.z }, remaining: 0, mode: 'path' };
    }

    const points = path.map((c) => maze.toWorld(c));

    // Aim at the next cell by default, and skip ahead only while the straight
    // line from here stays clear. Skipping blindly is what makes a ball saw
    // between waypoints in a corridor.
    let best = 1;
    const limit = Math.min(points.length - 1, 1 + LOOKAHEAD);
    for (let j = limit; j >= 2; j -= 1) {
      if (!isBlocked(from, points[j])) { best = j; break; }
    }

    return { point: points[best], remaining: path.length - best, mode: 'path' };
  }

  return {
    nextWaypoint,
    isBlocked,
    /** Kept for API symmetry; there is no cached state to clear. */
    reset() {},
    /** Cells remaining on the shortest route from `from` to `target`. */
    routeLength(from, target) {
      const path = maze.pathBetween(maze.toCell(from.x, from.z), maze.toCell(target.x, target.z));
      return path ? path.length : 0;
    },
  };
}
