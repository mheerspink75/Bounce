/**
 * The aimable obstacles, in one place.
 *
 * `physics.js` builds its colliders from this list, and the proxy builds the
 * model's prompt from the same ids. Without that, the set of things the model
 * is told it can target would drift from the set that actually exists — and the
 * failure would be silent, showing up only as a character that wanders when it
 * should be charging something.
 *
 * Dependency-free so the proxy can import it without pulling in the Rapier WASM.
 */

export const TARGETS = Object.freeze([
  {
    id: 'block_a',
    label: 'block A',
    half: [1.5, 1.5, 1.5],
    position: [-4, 1.5, -2],
    rotationAxis: null,
    rotationAngle: 0,
    restitution: 0.5,
  },
  {
    id: 'block_b',
    label: 'block B',
    half: [2.5, 0.5, 2.5],
    position: [3, 0.5, 2],
    rotationAxis: null,
    rotationAngle: 0,
    restitution: 0.5,
  },
  {
    id: 'ramp',
    label: 'ramp',
    half: [4, 0.25, 2],
    // 4*sin(0.35) + 0.25*cos(0.35) = 1.6065, so the lowest corner lands on y=0.
    position: [0, 1.61, 4.5],
    rotationAxis: [0, 0, 1],
    rotationAngle: -0.35,
    restitution: 0.4,
  },
]);

export const TARGET_IDS = Object.freeze(TARGETS.map((t) => t.id));
