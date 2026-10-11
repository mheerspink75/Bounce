/**
 * The character: a spec, realised as a physics body and a visible mesh.
 *
 * The spec schema, limits and sanitiser live in `spec.js` because the Node
 * proxy needs the exact same rules. This file only knows how to turn a spec
 * into something the engine can simulate and the renderer can draw.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { sanitizeSpec, DEFAULT_SPEC } from './spec.js';

export { sanitizeSpec, LIMITS, DEFAULT_SPEC } from './spec.js';

/** Spawn height: clears the ramp, and scales up so a large radius still fits. */
const SPAWN_Y = 7;

/**
 * Presets that demonstrate the character really is spec-driven.
 * Cycles with the spacebar. Step 3 swaps where these come from, not this code.
 */
export const PRESET_SPECS = Object.freeze([
  DEFAULT_SPEC,
  { name: 'Tombstone', radius: 1.6, color: '#4a5b7a', mass: 8.0, restitution: 0.25, roughness: 0.90, personality: 'heavy, slow to be moved' },
  { name: 'Pinball',   radius: 0.35, color: '#f2c14e', mass: 0.4, restitution: 0.92, roughness: 0.15, personality: 'hyperactive, never settles' },
  { name: 'Ghost',     radius: 0.9, color: '#8ad6c0', mass: 0.3, restitution: 0.05, roughness: 1.00, personality: 'slips away, avoids contact' },
]);

/** Volume of a sphere, used to convert a requested mass into a density. */
function ballVolume(r) {
  return (4 / 3) * Math.PI * r ** 3;
}

/**
 * Create the physics body for a character in an existing world.
 * Returns the sanitized spec alongside the body so callers never handle raw input.
 */
export function createCharacter(world, rawSpec, { spawn } = {}) {
  const spec = sanitizeSpec(rawSpec);

  // Default to dropping in from above. A maze supplies its own start: a
  // character materialising in the middle of the maze is both wrong and makes
  // "did it solve the maze?" ambiguous. `spawn.y` places it explicitly, which is
  // what replacing a character mid-run needs — dropping from height there would
  // land it on top of a wall.
  const spawnX = spawn?.x ?? 0;
  const spawnZ = spawn?.z ?? 0;
  const spawnY = spawn?.y ?? (Math.max(SPAWN_Y, spec.radius * 3) + (spawn?.drop ?? 0));

  // The open arena launches the character so it visibly rolls and bounces. A
  // maze must not: the launch carries it 8.5m past its own start before the
  // navigator has a say, which both looks wrong and makes the start position
  // unreproducible. `launch` is the escape hatch for callers that want it back.
  const launch = spawn?.launch ?? { x: 3.5, y: 0, z: -2 };

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnX, spawnY, spawnZ)
      .setLinvel(launch.x, launch.y, launch.z)
      .setLinearDamping(0.05)
      .setAngularDamping(0.2)
      // Impact overshoot + thin-ramp insurance. Measured: soft CCD takes max
      // penetration from 0.157m to 0. See README §10.
      .setCcdEnabled(true)
      .setSoftCcdPrediction(0.5),
  );

  const collider = world.createCollider(
    RAPIER.ColliderDesc.ball(spec.radius)
      .setRestitution(spec.restitution)
      .setFriction(0.3)
      // Rapier derives mass from density x volume, so the requested mass has to
      // be converted. Without this the spec's `mass` field would be decorative.
      .setDensity(spec.mass / ballVolume(spec.radius)),
    body,
  );

  return { spec, body, collider };
}

/** Build the visible mesh. Sanitizes again — it is free and idempotent. */
export function createCharacterMesh(rawSpec, { shadows = true } = {}) {
  const spec = sanitizeSpec(rawSpec);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(spec.radius, 48, 32),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(spec.color),
      roughness: spec.roughness,
      metalness: 0.05,
    }),
  );
  mesh.castShadow = shadows;
  mesh.name = spec.name;
  return mesh;
}

/** Release GPU resources when a character is swapped out. */
/**
 * A faint shell drawn *over* everything, so the character is always locatable.
 *
 * The maze walls are 2.4m tall and opaque, and they cannot be shortened — a
 * radius-2.0 character rests with its centre at y=2.0, so lower walls would let
 * the biggest characters roll out. That makes occlusion unavoidable from any
 * camera that still reads as 3D: measured by raycast from the camera, the
 * character was fully hidden behind a wall in 36-60% of frames at a 42-degree
 * look-down, and one seed stayed at 61% even at 73 degrees, because the ball
 * spends its time in the far half of a corridor with the near wall between it
 * and the camera.
 *
 * That is not a cosmetic problem. It was reported four times as "the ball passes
 * through the walls", and every physics measurement said the ball was legally
 * inside a corridor. A character you cannot see is indistinguishable from one
 * that is escaping, so this is a correctness fix wearing a rendering costume.
 *
 * Deliberately a separate, cheap shell rather than `depthTest: false` on the real
 * mesh: the character keeps its proper shading and self-occlusion, and only the
 * locator ignores depth. `depthWrite: false` so the shell never occludes anything
 * else, and a low opacity so it reads as a highlight rather than a second ball.
 */
export function createLocatorMesh(spec) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(spec.radius * 1.08, 20, 14),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(spec.color),
      transparent: true,
      opacity: 0.3,
      depthTest: false,
      depthWrite: false,
    }),
  );
  // Drawn after everything else, so it wins against the walls.
  mesh.renderOrder = 999;
  mesh.name = 'characterLocator';
  return mesh;
}

export function disposeCharacterMesh(mesh) {
  if (!mesh) return;
  mesh.geometry?.dispose();
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) m?.dispose?.();
}
