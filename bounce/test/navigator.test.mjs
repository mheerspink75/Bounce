// Isolates the navigator from physics: walk the returned waypoints as a
// perfect, teleporting follower and see whether the route is even correct.
// If this passes, any failure in the full test is control/physics, not routing.
import { buildMaze } from '../public/maze.js';
import { createNavigator } from '../public/navigator.js';
import { DEFAULT_SPEC } from '../public/spec.js';

let failures = 0;
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

for (const radius of [0.2, 0.6, 1.2, 1.8]) {
  let solved = 0;
  const problems = [];

  for (let seed = 1; seed <= 12; seed += 1) {
    const maze = buildMaze({ radius, seed });
    const nav = createNavigator({ maze, radius });
    const goal = maze.toWorld(maze.goalCell);

    // Start at the start cell centre.
    let here = maze.toWorld(maze.startCell);
    let reached = false;

    for (let step = 0; step < 400; step += 1) {
      const dist = Math.hypot(here.x - goal.x, here.z - goal.z);
      if (dist <= radius + 0.5) { reached = true; break; }

      const wp = nav.nextWaypoint(here, goal);

      // Would a follower actually get to the waypoint it was given?
      if (nav.isBlocked(here, wp.point)) {
        const hereCell = maze.toCell(here.x, here.z);
        const aimCell = maze.toCell(wp.point.x, wp.point.z);
        problems.push(
          `seed ${seed} step ${step}: unreachable aim from cell ${JSON.stringify(hereCell)}`
          + ` -> ${JSON.stringify(aimCell)} (mode=${wp.mode}, remaining=${wp.remaining})`,
        );
        break;
      }
      // Teleport to the waypoint, exactly as a perfect follower would.
      here = wp.point;
    }

    if (reached) solved += 1;
    else if (!problems.some((p) => p.includes(`seed ${seed}:`))) {
      problems.push(`seed ${seed}: follower ran out of steps`);
    }
  }

  check(`radius ${radius}: routing is solvable on every seed`, solved === 12,
    problems.length ? problems.slice(0, 2).join('; ') : '12/12 seeds');
}

// --- the exact stuck positions, traced -----------------------------------
{
  const maze = buildMaze({ radius: 0.6, seed: 1 });
  const nav = createNavigator({ maze, radius: 0.6 });
  const goal = maze.toWorld(maze.goalCell);

  for (const stuckAt of [{ x: -2.4, z: -6.3 }, { x: 6.3, z: 0.8 }, { x: 4.0, z: -6.3 }]) {
    const cell = maze.toCell(stuckAt.x, stuckAt.z);
    const path = maze.pathBetween(cell, maze.goalCell);
    const wp = nav.nextWaypoint(stuckAt, goal);

    const line = [];
    for (let i = 0; (path?.length ?? 0) > 1 && i < path.length - 1; i += 1) {
      line.push(maze.connected(path[i], path[i + 1]) ? '-' : 'X');
    }
    console.log(
      `\n  at (${stuckAt.x}, ${stuckAt.z}) cell ${JSON.stringify(cell)}`
      + `\n    path  ${JSON.stringify(path)}`
      + `\n    links ${line.join('')}  (X = a wall is in the way!)`
      + `\n    aim   (${wp.point.x.toFixed(2)}, ${wp.point.z.toFixed(2)}) mode=${wp.mode} remaining=${wp.remaining}`,
    );
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
