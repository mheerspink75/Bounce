/**
 * Does the model actually choose the goal when the prompt describes one?
 *
 * The whole point of reporting the world to the proxy is that a model told
 * "there is a reward, it is 9 turns away" picks the reward instead of wandering.
 * That claim is worth checking against a real model rather than assuming, and it
 * cannot be checked through /api/intent — the intent timeout is 20s and the free
 * tier's median is 37s, so that endpoint always times out first.
 *
 * So this calls the provider directly, with a timeout the free tier can meet.
 *
 *   node scripts/goal-prompt-check.mjs [n]
 */
import { createProviderFromEnv } from '../server/providers.js';
import { extractJsonObject } from '../server/extract.js';
import { INTENTS } from '../public/intent.js';

const RUNS = Number(process.argv[2] ?? 5);

// The provider picks its budget by *purpose*: `intent` uses intentTimeoutMs and
// ignores timeoutMs, which is deliberate (the two jobs have opposite
// requirements). So the override has to go through the environment, not the
// per-call option.
const provider = createProviderFromEnv({
  ...process.env,
  NIM_INTENT_TIMEOUT_MS: '120000',
  OPENROUTER_INTENT_TIMEOUT_MS: '120000',
  LOCAL_INTENT_TIMEOUT_MS: '120000',
});

if (provider.name === 'mock') {
  console.log('provider is mock — this check is only meaningful against a real model.');
  process.exit(0);
}

/** Mirror of the server's `intentPrompt`, so this measures what is really sent. */
function prompt(goal) {
  return [
    'You control a bouncing character in a small 3D toy. Reply with ONE JSON object and nothing else.',
    '',
    'Fields:',
    `  action      one of ${INTENTS.join(', ')}`,
    '  target      the id of what to head toward, or null',
    '  intensity   number, 0 to 1',
    '  duration_s  number, 1 to 5',
    '',
    'Valid target ids: block_a, block_b, ramp, goal.',
    '',
    'There is a reward at the far corner of a maze, and reaching it is the whole',
    'point of the run. `charge_target` with target "goal" is what actually gets',
    'it there — the character navigates the corridors itself, so all you owe it',
    'is the decision to go.',
    `It is currently ${goal.path_cells} corridor turns away, in a ${goal.maze} maze.`,
    '',
    'So: head for the goal. Wander or rest only once it has been reached, and',
    'prefer charge_target over seek for the same target — seek is the weaker,',
    'vaguer version of the same request.',
    '',
    'Vary the action between calls. Do not repeat the same action every time.',
  ].join('\n');
}

// Farthest first: the interesting case is a goal that looks expensive.
const SCENARIOS = [
  { distance_m: 17.9, path_cells: 9, maze: '5x5' },
  { distance_m: 9.4, path_cells: 5, maze: '5x5' },
  { distance_m: 3.1, path_cells: 2, maze: '5x5' },
];

let choseGoal = 0;
let asked = 0;
const rows = [];

for (let i = 0; i < RUNS; i += 1) {
  const goal = SCENARIOS[i % SCENARIOS.length];
  const started = Date.now();
  try {
    const { raw, model } = await provider.complete({
      system: prompt(goal),
      user: 'The character has not reached the reward yet. What should it do?',
      purpose: 'intent',
    });
    const parsed = extractJsonObject(raw);
    asked += 1;
    const hit = parsed?.target === 'goal';
    if (hit) choseGoal += 1;
    rows.push(`  ${String(goal.path_cells).padStart(2)} turns away -> ${String(parsed?.action).padEnd(14)} target=${String(parsed?.target).padEnd(6)} ${hit ? 'GOAL' : '---'} ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (err) {
    rows.push(`  ${String(goal.path_cells).padStart(2)} turns away -> ERROR ${err.message}`);
  }
  console.log(rows.at(-1));
}

console.log(`\npicked the goal: ${choseGoal}/${asked} answered  (${RUNS - asked} failed)`);
console.log('The point is not 100% — a small model will sometimes wander. It is that');
console.log('wandering is no longer the *only* option it is being offered.');
