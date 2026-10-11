// Why does a seed fail? Prints the stuck state, the waypoint being aimed at,
// and an ASCII map with the character and route on it.
import { createWorld, FIXED_TIMESTEP } from '../public/physics.js';
import { createBrain } from '../public/brain.js';
import { DEFAULT_SPEC } from '../public/spec.js';

const SEED = Number(process.argv[2] ?? 5);
const settle = () => new Promise((r) => setTimeout(r, 0));

const sim = await createWorld({ spec: DEFAULT_SPEC, mazeSeed: SEED });
const maze = sim.maze;
const brain = createBrain({
  sim,
  ask: async () => ({ action: 'charge_target', target: 'goal', intensity: 1, duration_s: 3600 }),
  now: () => 0,
});

console.log(`seed ${SEED}  maze ${maze.dims}x${maze.dims}  pitch ${maze.pitch.toFixed(2)}`);
console.log(`start ${JSON.stringify(maze.startCell)} -> goal ${JSON.stringify(maze.goalCell)}`);
console.log(`radius ${DEFAULT_SPEC.radius}  goal radius ${DEFAULT_SPEC.radius + 0.5}\n`);

let stuck = null;
const trace = [];
let lastAim = null;
for (let i = 0; i < 60 * 60; i += 1) {
  brain.update(FIXED_TIMESTEP);
  sim.advance(FIXED_TIMESTEP);
  if (i % 30 === 0) await settle();
  if (sim.reached) break;

  const p = sim.character.body.translation();
  const v = sim.character.body.linvel();
  const speed = Math.hypot(v.x, v.z);

  // Record what the navigator is aiming at, and when it changes.
  if (i % 20 === 0) {
    const aim = sim.navigator.nextWaypoint({ x: p.x, z: p.z }, sim.goal).point;
    const key = `${aim.x.toFixed(1)},${aim.z.toFixed(1)}`;
    if (key !== lastAim) {
      trace.push(`t=${(i / 60).toFixed(1)}s  at (${p.x.toFixed(1)},${p.z.toFixed(1)}) cell ${JSON.stringify(maze.toCell(p.x, p.z))} -> aim (${key}) cell ${JSON.stringify(maze.toCell(aim.x, aim.z))}`);
      lastAim = key;
    }
  }

  if (speed < 0.25) {
    if (!stuck) stuck = { frames: 0, at: { x: p.x, z: p.z }, cell: maze.toCell(p.x, p.z) };
    stuck.frames += 1;
    if (stuck.frames > 120) {
      console.log(`STUCK at (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) cell ${JSON.stringify(stuck.cell)}`);
      break;
    }
  } else if (stuck) {
    stuck = null;
  }
}

console.log(`\n--- navigator trace (${trace.length} aim changes) ---`);
for (const line of trace.slice(0, 25)) console.log(`  ${line}`);
if (trace.length > 25) console.log(`  ... ${trace.length - 25} more`);

if (sim.reached) { console.log('REACHED THE GOAL'); process.exit(0); }

// ASCII map
const here = maze.toCell(sim.character.body.translation().x, sim.character.body.translation().z);
console.log('\n  #  wall   .  open   S  start   G  goal   @  character   *  path');
const path = maze.pathBetween(maze.startCell, maze.goalCell) ?? [];
const onPath = new Set(path.map((c) => `${c[0]},${c[1]}`));
for (let y = maze.dims - 1; y >= 0; y -= 1) {
  let row = '  ';
  for (let x = 0; x < maze.dims; x += 1) {
    const key = `${x},${y}`;
    if (x === here[0] && y === here[1]) row += '@';
    else if (x === maze.startCell[0] && y === maze.startCell[1]) row += 'S';
    else if (x === maze.goalCell[0] && y === maze.goalCell[1]) row += 'G';
    else if (onPath.has(key)) row += '*';
    else if (maze.isOpen([x, y])) row += '.';
    else row += '#';
  }
  console.log(row);
}
console.log(`\n  character is in cell ${JSON.stringify(here)}; path length ${path.length}`);
process.exit(0);
