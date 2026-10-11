/**
 * Rendering + the render loop. Reads physics state, never writes it.
 *
 * The character mesh is rebuilt from the spec whenever the character changes, so
 * this file never invents a character attribute — see `character.js`.
 *
 * `window.bounce.applySpec()` is the step-3 seam: an LLM response gets handed
 * there and the character changes. Nothing else needs to know about it.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createWorld, FIXED_TIMESTEP } from './physics.js';
import { createCharacterMesh, createLocatorMesh, disposeCharacterMesh, PRESET_SPECS } from './character.js';
import { createBrain } from './brain.js';
import { fetchHealth, fetchCharacter, fetchIntent } from './api.js';

/** Shadows cost fill rate. On a software renderer this is the first thing to cut. */
const SHADOWS = true;

/**
 * How often the page checks whether a manual override has appeared.
 *
 * Short enough that "instant" is honest — well inside the ~2s the README
 * promises — and long enough to be irrelevant next to the model calls it exists
 * to cut short.
 */
const OVERRIDE_POLL_MS = 200;

const hud = document.getElementById('hud');

// Surface any module-level or async failure instead of dying silently in console.
function fatal(err) {
  const el = document.getElementById('err');
  el.style.display = 'block';
  el.textContent = `${err?.message ?? err}\n\n${err?.stack ?? ''}`;
  hud.textContent = 'FAILED — see panel';
  console.error(err);
}

main().catch(fatal);

async function main() {
  // --- scene -------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0f12);
  // Pushed out with the camera. Fog from 30 would otherwise swallow the far half
  // of the maze, since the camera now sits ~31 units out.
  scene.fog = new THREE.Fog(0x0d0f12, 46, 96);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  // Steep, and deliberately so.
  //
  // The walls are 2.4m tall and opaque, and they cannot be shortened: a
  // radius-2.0 character rests with its centre at y=2.0, so anything below ~2.4
  // would let the largest characters roll straight out of the maze (measured max
  // centre height 2.036m over 5 radii x 4 seeds). With walls that tall, a shallow
  // camera is a correctness problem rather than a taste one — a wall's top edge
  // projects *over* the corridor behind it, so a ball 0.9m clear of a wall is
  // drawn apparently sitting on it.
  //
  // Measured occlusion of the character by a wall, raycast from the camera:
  //
  //   (0,16,18)  42deg   36-60% of frames     <- the old default
  //   (0,20,15)  53deg   58%
  //   (0,24,13)  62deg    6%
  //   (0,30, 9)  73deg    0%
  //
  // The threshold is where the view clears atan(wallHeight / corridorWidth) for
  // the tightest maze — 2.4m over a 2.81m corridor, about 55deg.
  camera.position.set(0, 30, 9);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  if (SHADOWS) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  document.body.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.enableDamping = true;
  controls.minDistance = 6;
  controls.maxDistance = 45;
  // Keep the camera above the floor so orbiting never goes under the arena.
  controls.maxPolarAngle = Math.PI * 0.49;
  // ...and keep it steep enough to see into the corridors. Orbiting down to the
  // old 42 degrees is what made the character look like it was passing through
  // walls: it was simply hidden behind one, 36-60% of the time. A user who
  // orbits freely can walk straight back into that misreading, so the limit is
  // part of the fix rather than a separate concern.
  //
  // 0.30 rad from vertical is a 73-degree look-down, the measured 0% point.
  controls.minPolarAngle = 0.10;
  controls.maxPolarAngle = 0.30;

  // Three-light rig. The arena is a closed box, so a single overhead key left
  // the interior in shadow — the fill light is what makes the floor readable.
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2622, 1.5));

  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(8, 26, 12);
  if (SHADOWS) {
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 70;
    key.shadow.camera.left = -14;
    key.shadow.camera.right = 14;
    key.shadow.camera.top = 14;
    key.shadow.camera.bottom = -14;
    key.shadow.bias = -0.001;
  }
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x9db4d8, 0.9);
  fill.position.set(-12, 10, -8);
  scene.add(fill);

  // --- world -------------------------------------------------------------
  // The seed is in the URL so a maze can be shared or reproduced, and R rolls a
  // new one.
  const urlSeed = Number(new URLSearchParams(location.search).get('seed'));
  let mazeSeed = Number.isFinite(urlSeed) && urlSeed > 0 ? urlSeed : 1;

  const sim = await createWorld({ mazeSeed });
  hud.textContent = 'physics ready…';

  // Frame the scene now that we know whether there is a maze. The open-arena
  // angle is too shallow for one: at 2.4m the walls hide most of the layout, and
  // a maze you cannot see is a maze you cannot debug.
  if (sim.maze) {
    camera.position.set(0, 20, 12);
    controls.target.set(0, 0, 0);
  }
  controls.update();

  // Exposed for the browser smoke test (test/browser-smoke.mjs). Must come
  // after `sim` is initialised.
  window.__bounce = { sim, scene, renderer, camera, ready: false };

  // Static geometry, mirrored from the collider definitions. Works for both the
  // open arena and the maze, since both go through sim.statics.
  //
  // Rebuilt whenever `sim.staticsVersion` changes, which it does every time the
  // maze advances. Building this once was a real bug: the maze changes every
  // generation, so the *drawn* walls stayed on the first maze while the
  // *colliders* moved to the new one, and the character appeared to walk
  // straight through walls. Nothing headless can catch that, because the fault is
  // entirely in the disagreement between what is simulated and what is drawn.
  const staticsGroup = new THREE.Group();
  scene.add(staticsGroup);

  let staticsVersion = sim.staticsVersion;

  function rebuildStatics() {
    // Dispose before dropping. The maze advances every ~12s, so leaking a
    // geometry and a material per generation is a slow GPU memory climb.
    for (const child of [...staticsGroup.children]) {
      staticsGroup.remove(child);
      child.geometry?.dispose();
      // Materials are shared per-mesh here, so disposing each is correct; guard
      // anyway so a future shared material is not freed out from under a sibling.
      child.material?.dispose?.();
    }

    for (const s of sim.statics) {
      const isFloor = s.label === 'floor';
      const isWall = s.label.startsWith('wall') || s.label.startsWith('maze wall');
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(s.half[0] * 2, s.half[1] * 2, s.half[2] * 2),
        new THREE.MeshStandardMaterial({
          // Maze walls are lighter than the open-arena props: a maze seen from
          // above is mostly wall, and at the old contrast the layout vanished
          // into the floor.
          color: isFloor ? 0x1e232b : (isWall ? 0x5a6a82 : 0x4a5464),
          roughness: 0.85,
          metalness: 0.05,
        }),
      );
      mesh.position.set(s.pos[0], s.pos[1], s.pos[2]);
      if (s.rot) mesh.quaternion.set(s.rot.x, s.rot.y, s.rot.z, s.rot.w);
      mesh.castShadow = SHADOWS;
      mesh.receiveShadow = SHADOWS;
      mesh.userData.label = s.label;
      staticsGroup.add(mesh);
    }
    staticsVersion = sim.staticsVersion;
  }

  rebuildStatics();

  // --- goal marker --------------------------------------------------------
  // A beam plus a ring. The beam is tall enough to clear the 2.4m maze walls so
  // the reward is findable from anywhere in the maze, which is the whole point
  // of a goal — a marker you can only see on arrival is not navigation.
  //
  // Both markers are *repositioned* rather than rebuilt, because a new maze
  // arrives every time the reward is collected.
  let goalMarker = null;
  let goalMat = null;
  if (sim.goal) {
    goalMat = new THREE.MeshStandardMaterial({
      color: 0x7ef2a0,
      emissive: 0x3fa860,
      emissiveIntensity: 1.4,
      roughness: 0.3,
      transparent: true,
      opacity: 0.5,
    });
    // The group is parked on the goal and its children use *local* offsets.
    // Placing children in world coordinates and then rotating the group swings
    // them around the arena origin instead of spinning them in place, which
    // left the beam visibly leaning across the maze.
    goalMarker = new THREE.Group();

    // 3.2m clears the 2.4m walls. Much taller and the downward-pitched camera's
    // perspective makes it look like it is leaning.
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 3.2, 12), goalMat);
    beam.position.set(0, 1.6, 0);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.11, 10, 28), goalMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.08, 0);
    goalMarker.add(beam, ring);
    scene.add(goalMarker);
  }

  // --- start marker -------------------------------------------------------
  let startRing = null;
  if (sim.start) {
    startRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.8, 0.06, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0x5f7fa8 }),
    );
    startRing.rotation.x = -Math.PI / 2;
    scene.add(startRing);
  }

  /** Move the markers onto the current maze. On boot and on every advance. */
  function placeMarkers() {
    if (goalMarker && sim.goal) goalMarker.position.set(sim.goal.x, 0, sim.goal.z);
    if (startRing && sim.start) startRing.position.set(sim.start.x, 0.07, sim.start.z);
  }
  placeMarkers();

  // --- character ---------------------------------------------------------
  // Rebuilt from the spec whenever the character changes, so nothing here
  // needs to know how a character is constructed.
  let characterMesh = createCharacterMesh(sim.character.spec, { shadows: SHADOWS });
  scene.add(characterMesh);

  // Drawn over the walls so the character is always locatable. See
  // `createLocatorMesh` for why this is a correctness fix and not polish.
  let locatorMesh = createLocatorMesh(sim.character.spec);
  scene.add(locatorMesh);

  /**
   * Replace the character from a raw spec. Sanitizing happens inside
   * `replaceCharacter`/`createCharacterMesh`, so callers can pass LLM output
   * straight in without pre-validating it.
   */
  function applySpec(rawSpec) {
    const { character, mazeRebuilt } = sim.replaceCharacter(rawSpec);
    const next = createCharacterMesh(character.spec, { shadows: SHADOWS });

    scene.remove(characterMesh);
    disposeCharacterMesh(characterMesh);

    // The locator is sized and coloured from the spec too, so a new character
    // gets a matching shell rather than inheriting the old one's radius.
    scene.remove(locatorMesh);
    disposeCharacterMesh(locatorMesh);
    locatorMesh = createLocatorMesh(character.spec);
    scene.add(locatorMesh);

    characterMesh = next;
    scene.add(characterMesh);
    logEvent('applySpec', { name: character.spec.name, radius: character.spec.radius, mazeRebuilt });

    // A new character keeps its place in the maze; only a rebuilt maze (needed
    // when the new radius will not fit the old corridors) loses the run. Say
    // which happened, so a reset never looks like a glitch.
    if (mazeRebuilt) {
      status.source = 'new maze — the character outgrew the old corridors';
    }
    return character.spec;
  }

  // --- resize ------------------------------------------------------------
  function resize() {
    const { clientWidth: w, clientHeight: h } = document.body;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  addEventListener('resize', resize);
  resize();

  // --- preset cycling ----------------------------------------------------
  // Placeholder for step 4. Today it walks hardcoded specs; then it will walk
  // specs the LLM returned. The applySpec() path is identical either way.
  let presetIndex = 0;
  addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    e.preventDefault();
    presetIndex = (presetIndex + 1) % PRESET_SPECS.length;
    applySpec(PRESET_SPECS[presetIndex]);
  });

  // --- what the model is emitting ------------------------------------------
  //
  // A small ring buffer of the model's own words, shown in the panel on the
  // right. Two reasons this is worth having, both learned the hard way:
  //
  // 1. The applied intent is *sanitised*, so it looks tidy whether or not the
  //    model behaved. A 1.5B asking for `target: null` and `intensity: 5` was
  //    clamped into something perfectly valid, and the character silently did
  //    nothing — six mazes, four minutes, zero rewards, no error anywhere. Seeing
  //    the raw output next to the applied intent makes that class of failure
  //    obvious at a glance instead of only in a log.
  // 2. Whether the model is *deciding* anything is the open question in this
  //    project, and it is not answerable from the applied intent. One reward,
  //    strongly suggested, and the 7B answers `charge_target -> goal` every time
  //    because the prompt tells it to. A panel showing the raw output makes the
  //    difference between obeying and choosing visible rather than asserted.
  //
  // Text is inserted with `textContent`, never as markup: this is model-authored
  // output, and a model is free to emit `<script>`.
  const THOUGHTS_MAX = 12;
  const thoughts = [];

  function noteThought(entry) {
    thoughts.unshift(entry);
    if (thoughts.length > THOUGHTS_MAX) thoughts.length = THOUGHTS_MAX;
  }

  const thoughtsEl = document.getElementById('thoughts');
  const panelOpen = () => document.body.classList.contains('thoughts-open');

  // The toggle lives in index.html and runs before this module, so it cannot call
  // in directly. It dispatches this instead.
  addEventListener('bounce:thoughts', () => renderThoughts());

  function renderThoughts() {
    if (!thoughtsEl || !panelOpen()) return;
    const head = document.createElement('h2');
    head.textContent = 'model output';
    thoughtsEl.replaceChildren(head);

    if (thoughts.length === 0) {
      const none = document.createElement('div');
      none.className = 't-none';
      none.textContent = 'nothing yet — press A to design a character';
      thoughtsEl.append(none);
      return;
    }

    for (const t of thoughts) {
      const row = document.createElement('div');
      row.className = 't-entry';

      const meta = document.createElement('div');
      meta.className = 't-meta';
      meta.textContent = `${t.kind} · ${t.model} · ${t.latency}`;

      const said = document.createElement('pre');
      said.className = t.clamped ? 't-said is-clamped' : 't-said';
      said.textContent = t.said;

      row.append(meta, said);

      // Scratch work gets its own block, above the answer rather than below it.
      // Reasoning models emit a lot of it, and burying it under the JSON would
      // make the two easy to confuse — which is precisely the mistake the
      // provider adapter exists to prevent.
      if (t.reasoning) {
        const think = document.createElement('pre');
        think.className = 't-reason';
        const tag = document.createElement('span');
        tag.className = 't-tag';
        // Name the field only when it is not the one already implied by the
        // heading. "reasoning · reasoning" is noise; "reasoning · thinking" tells
        // you which spelling this provider happened to use.
        const field = t.reasoningField ?? 'reasoning';
        tag.textContent = field === 'reasoning' ? 'reasoning' : `reasoning · ${field}`;
        think.append(tag, document.createTextNode(t.reasoning));
        row.append(think);
      }

      if (t.why) {
        const why = document.createElement('p');
        why.className = 't-why';
        // `why` is built from known strings and numbers, never model text.
        why.textContent = t.why;
        row.append(why);
      }
      thoughtsEl.append(row);
    }
  }

  // --- step 3: ask the model for a character -----------------------------
  // The key is on the server. This only ever receives a sanitised spec.
  const status = { state: 'idle', provider: '—', source: '—', providerOk: null, providerError: null };

  async function askForCharacter() {
    if (status.state === 'loading') return;
    status.state = 'loading';
    try {
      const res = await fetchCharacter();
      const { spec, source } = res;
      applySpec(spec);
      status.state = 'ok';
      status.source = source;

      noteThought({
        kind: 'character',
        model: source,
        latency: res.latency_ms != null ? `${(res.latency_ms / 1000).toFixed(1)}s` : '—',
        said: res.model_said ?? '(no model output — fallback spec)',
        clamped: false,
        reasoning: res.model_reasoning ? res.model_reasoning.trim() : null,
        reasoningField: res.reasoning_field ?? null,
        why: `applied: ${spec.name}, r=${spec.radius}`,
      });
      renderThoughts();
    } catch (err) {
      // Keep the current character. A failed request should not empty the scene.
      status.state = 'error';
      status.source = err.message;
      noteThought({ kind: 'character', model: '—', latency: '—', said: `error: ${err.message}`, clamped: true });
      renderThoughts();
    }
  }

  addEventListener('keydown', (e) => {
    if (e.code === 'KeyA' && !e.repeat) askForCharacter();
  });

  // Report which provider is live, so it is obvious whether a key is loaded.
  fetchHealth()
    .then((h) => { status.provider = h.provider; })
    .catch(() => { status.provider = 'offline'; });

  // Step 3 seam: hand an LLM response here and the character changes.
  window.bounce = {
    applySpec,
    askForCharacter,
    status,
    sim,
    scene,
    renderer,
    camera,
    controls,
    // Live frame stats on the debug seam. Without these, "is the simulation
    // keeping up?" can only be answered by reading a screenshot, which is how
    // a substep cap that silently ran the sim slow went unnoticed.
    stats: { fps: 0, substeps: 0, lastIntent: null },
  };

  // --- step 4: the slow brain --------------------------------------------
  // The model decides what it wants; the brain decides how to ask and how to
  // hold the answer. The physics engine still owns every bit of motion.
  let lastIntentSignature = null;
  const brain = createBrain({
    sim,
    ask: async ({ signal } = {}) => {
      // Report the world so the proxy can name the goal and tell the model how
      // far away it is. Without this the model only ever sees the arena
      // obstacles, has no idea a reward exists, and wanders.
      const res = await fetchIntent({
        signal,
        world: {
          targets: [...sim.targets().map((t) => t.id), ...(sim.goal ? ['goal'] : [])],
          goal: sim.goalInfo(),
        },
      });

      // Every 2s would flood a 12-entry panel within half a minute, and the
      // decisions worth reading are the ones where something changed. So: log
      // always when the sanitiser had to intervene or the answer was unusable,
      // and otherwise only when the decision differs from the last one logged.
      const { intent } = res;
      const signature = `${intent.action}:${intent.target ?? '-'}`;
      const notable = res.sanitised
        || res.source === 'fallback'
        || signature !== lastIntentSignature;
      if (notable) {
        lastIntentSignature = signature;
        const applied = `${intent.action}${intent.target ? ` -> ${intent.target}` : ''}`;
        noteThought({
          kind: 'intent',
          model: res.source,
          latency: res.latency_ms != null ? `${(res.latency_ms / 1000).toFixed(1)}s` : '—',
          said: res.model_said ?? '(no model output — fallback intent)',
          clamped: Boolean(res.sanitised) || res.source === 'fallback',
          // Scratch work in its own block rather than clipped into `why`: it is
          // the thing worth reading, and 300 characters of it is not enough.
          reasoning: res.model_reasoning ? res.model_reasoning.trim() : null,
          reasoningField: res.reasoning_field ?? null,
          why: [
            res.sanitised ? 'sanitiser changed this' : null,
            res.source === 'fallback' ? 'provider output unusable' : null,
            `applied: ${applied}`,
          ].filter(Boolean).join(' · '),
        });
        renderThoughts();
      }

      return intent;
    },
    // The mock provider answers instantly; a real one takes 300ms-2s. Either
    // way the brain paces itself from completion, so requests never stack up.
    intervalMs: 2000,
  });
  window.bounce.brain = brain;

  // Space still cycles presets. Ask the model for a new character without
  // letting the brain keep steering the one that just left.
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyN') { e.preventDefault(); brainQuieted = true; brain.quiet(); return; }
    // R: skip to the next maze without waiting for the reward.
    if (e.code === 'KeyR') { e.preventDefault(); advanceLoop({ newCharacter: false }); }
  });

  /**
   * End the current run and start the next one: new maze, new goal, new
   * character.
   *
   * The maze and the character are handled separately on purpose. A new maze is
   * free and instant; a new character is a model call that takes 14-58s on the
   * free tier. Awaiting it before starting the next maze would mean the player
   * watches a finished board for most of a minute — so the maze advances at once
   * and the character catches up when the model answers, which is the same
   * "a redesign is not a restart" rule the manual swaps follow.
   */
  function advanceLoop({ newCharacter = true } = {}) {
    const finished = sim.reward;
    const next = sim.newMaze(mazeSeed + 1);
    if (!next) return;

    mazeSeed = next.seed;
    loggedReward = false;
    placeMarkers();

    // Keep the URL shareable and reproducible across the whole session.
    const url = new URL(location.href);
    url.searchParams.set('seed', String(mazeSeed));
    history.replaceState(null, '', url);

    logEvent('advance', {
      seed: next.seed,
      maze: `${next.dims}x${next.dims}`,
      finished: finished ? `solved in ${finished.pathLength} cells` : 'skipped',
      generation: sim.generation,
    });

    // Nudge the brain: the goal it was told about no longer exists, so the
    // intent it is holding is stale. Without this it would keep steering at the
    // old goal's coordinates until the intent lapsed.
    brain.poke();

    if (newCharacter) void askForCharacter();
  }

  // --- loop --------------------------------------------------------------
  const clock = new THREE.Clock();
  let fps = 0;
  let steps = 0;

  /**
   * A short event log on the debug seam.
   *
   * Written because "it took 4x longer than it should" has at least four
   * candidate causes — slow simulation, a character swap resetting progress, the
   * model overriding manual steering, a rate limit — and a screenshot cannot
   * tell them apart. With this, `scripts/maze-browser-check.mjs` prints the
   * actual sequence and the guessing stops.
   */
  const events = [];
  let lastIntentKey = '';
  let loggedReward = false;
  let overrideSeen = false;
  // Set by the N key so the HUD can say "you stopped it" rather than leaving
  // "the model is not answering" as the only explanation for a wander.
  let brainQuieted = false;
  let lastOverridePoll = 0;
  function logEvent(kind, detail = {}) {
    events.push({ t: Number(sim.simTime.toFixed(2)), wall: Number(clock.elapsedTime.toFixed(2)), kind, ...detail });
    if (events.length > 300) events.shift();
  }
  window.bounce.events = events;

  renderer.setAnimationLoop(() => {
    const frameDt = clock.getDelta();

    // Brain first: it applies forces that this frame's step will integrate.
    const intent = brain.update(frameDt);
    steps = sim.advance(frameDt);
    if (steps > 0) fps = 1 / frameDt;
    window.bounce.stats.fps = fps;
    window.bounce.stats.substeps = steps;
    window.bounce.stats.lastIntent = intent;

    // Log only on change, so the timeline reads as a sequence of decisions
    // rather than one line per frame.
    const intentKey = `${intent.action}:${intent.target ?? '-'}`;
    if (intentKey !== lastIntentKey) {
      lastIntentKey = intentKey;
      logEvent('intent', { action: intent.action, target: intent.target, source: status.source });
    }
    if (sim.reached && !loggedReward) {
      loggedReward = true;
      logEvent('reward', { maze: sim.reward?.maze, path: sim.reward?.pathLength });
      // The loop: a collected reward ends the run, and the next one starts
      // immediately with a new maze, a new goal, and a new character.
      advanceLoop();
    }

    // Read physics → drive the mesh. Never the other way round.
    const body = sim.character.body;
    const p = body.translation();
    const r = body.rotation();
    characterMesh.position.set(p.x, p.y, p.z);
    characterMesh.quaternion.set(r.x, r.y, r.z, r.w);
    // The locator tracks position only — it is a glow, not a solid, so spinning
    // it with the body would read as a different object.
    locatorMesh.position.set(p.x, p.y, p.z);

    controls.update();

    // --- manual override watcher ------------------------------------------
    // The brain paces its own requests from completion, so with a 20s model
    // call in flight it issues no requests at all — and a manual intent posted
    // in that window sat in a queue behind it. Measured: 22 of the 30 seconds of
    // a maze run were spent waiting for a request nobody wanted any more.
    //
    // /api/health is cheap, carries no credentials, and already reports
    // override_active, so watching it is enough to make the manual channel
    // instant without letting the client hammer the intent endpoint.
    if (clock.elapsedTime * 1000 - lastOverridePoll >= OVERRIDE_POLL_MS) {
      lastOverridePoll = clock.elapsedTime * 1000;
      void fetchHealth()
        .then((h) => {
          // Keep the provider line live rather than a startup snapshot. It used to
          // be fetched once, on load, which meant `offline` was permanent and
          // indistinguishable from "the proxy is down" — a page opened before the
          // proxy came up never recovered, and said so forever.
          status.provider = h.provider;
          status.providerOk = true;
          if (h.override_active && !overrideSeen) {
            overrideSeen = true;
            logEvent('override', { action: 'manual override appeared' });
            brain.interrupt();
          } else if (!h.override_active) {
            overrideSeen = false;
          }
        })
        // A health blip must never break the render loop. But a *sustained*
        // failure is the single most useful thing to surface, so record it: the
        // intent requests are about to start failing too, and "error" without a
        // reason is what made this undiagnosable from the HUD.
        .catch((err) => {
          status.providerOk = false;
          status.providerError = err?.message ?? 'health check failed';
        });
    }

    // Keep the drawn walls in step with the colliders. The maze advances on every
    // reward, so without this the scene keeps showing the maze the character has
    // already left.
    if (sim.staticsVersion !== staticsVersion) rebuildStatics();

    // Pulse the reward so it reads as interactive, and brighten it once won.
    if (goalMarker && goalMat) {
      goalMat.opacity = sim.reached ? 0.95 : 0.42 + Math.sin(clock.elapsedTime * 2.4) * 0.12;
      goalMat.color.setHex(sim.reached ? 0xffe066 : 0x7ef2a0);
      goalMat.emissive.setHex(sim.reached ? 0xb8860b : 0x3fa860);
      goalMarker.rotation.y += 0.004;
    }

    renderer.render(scene, camera);

    const v = body.linvel();
    const s = sim.character.spec;
    const dGoal = sim.goal
      ? Math.hypot(p.x - sim.goal.x, p.z - sim.goal.z)
      : null;

    // The reward wins the HUD when it happens, so the loop's end is unmissable.
    const banner = sim.reached
      ? `\n*** REWARD COLLECTED ***\n    maze ${sim.reward.maze}, path ${sim.reward.pathLength} cells\n`
      : '';

    // Who is actually driving, right now.
    //
    // The character moves in every one of these cases, so motion proves nothing.
    // The question is only answerable by asking whether the *current intent* came
    // from the model, and that is what this reports. Ordered by how much the
    // answer matters, not by how often it happens.
    const control = (() => {
      if (overrideSeen) return 'manual override (agent/human)';
      if (brain.state.status === 'error') return 'FALLBACK — model not answering';
      if (brainQuieted) return 'off (N pressed) — wandering';
      if (brain.state.status === 'asking') {
        return intent.target ? 'model (asking…)' : 'FALLBACK — model not answering';
      }
      // A `wander` with no target is exactly what the fallback produces, so it is
      // the shape to distrust even when the last ask succeeded: the model may have
      // answered `wander` legitimately, and this says so rather than claiming the
      // model is driving.
      if (!intent.target && intent.action === 'wander') {
        return 'fallback (model said wander)';
      }
      // A real, targeted intent means the model is answering again, so a previous
      // N is no longer the explanation.
      brainQuieted = false;
      return 'model';
    })();

    hud.textContent =
      `${s.name}\n` +
      `${'-'.repeat(34)}\n` +
      `fps        ${fps.toFixed(0).padStart(3)}\n` +
      `substeps   ${String(steps).padStart(3)} / frame\n` +
      `position   ${p.x.toFixed(2).padStart(6)}, ${p.y.toFixed(2).padStart(6)}, ${p.z.toFixed(2).padStart(6)}\n` +
      `speed      ${Math.hypot(v.x, v.y, v.z).toFixed(2).padStart(6)} m/s\n` +
      `timestep   1/${Math.round(1 / FIXED_TIMESTEP)} s fixed\n` +
      `${'-'.repeat(34)}\n` +
      `radius     ${s.radius.toFixed(2)}   mass ${s.mass.toFixed(2)}\n` +
      `restitution${s.restitution.toFixed(2).padStart(6)}\n` +
      `roughness  ${s.roughness.toFixed(2)}   ${s.color}\n` +
      `${'-'.repeat(34)}\n` +
      (sim.maze
        ? `maze       ${sim.maze.dims}x${sim.maze.dims}  seed ${sim.maze.seed}`
          + `  #${sim.generation + 1}\n`
        : 'maze       off (open arena)\n') +
      (dGoal === null ? '' : `to reward  ${dGoal.toFixed(2).padStart(6)} m\n`) +
      `provider   ${status.provider}\n` +
      `last spec  ${status.state === 'loading' ? 'asking…' : status.source}\n` +
      `${'-'.repeat(34)}\n` +
      `intent     ${intent.action}${intent.target ? ` -> ${intent.target}` : ''}\n` +
      `intensity  ${intent.intensity.toFixed(2)}  for ${intent.duration_s.toFixed(1)}s\n` +
      // The one line that answers "is the AI driving, or am I watching a fallback
      // wander?". `brain: ok` alone was not enough: the character kept moving
      // either way, so a dead provider looked exactly like a working one. The
      // tell is whether the current intent came from the model.
      `control    ${control}\n` +
      `brain      ${brain.state.status} (${brain.state.requests} asks`
      + `${brain.state.avgLatencyMs !== null
        ? `, ${(brain.state.avgLatencyMs / 1000).toFixed(1)}s avg round trip`
        : ''})\n` +
      // The reason, not just the fact. `brain error` with no cause sent the last
      // session looking for a dead proxy when the actual cause was a 403 from the
      // origin guard.
      (brain.state.lastError
        ? `reason     ${String(brain.state.lastError).slice(0, 170)}\n`
        : '') +
      `\n[space] preset  [A] new character  [N] stop steering  [R] skip maze` +
      banner;
  });

  // Signal for automated checks.
  document.body.dataset.ready = '1';
  window.__bounce.ready = true;
  console.log('[bounce] ready', {
    statics: sim.statics.length,
    spec: sim.character.spec,
  });
}
