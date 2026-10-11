/**
 * Throwaway experiment: which prompt shape makes a SMALL model emit target="goal"?
 *
 * Not part of the suite. This exists to answer one question with numbers before
 * changing the real prompt: the 1.5B scored 1/3 on goal-prompt-check while the 7B
 * scored 5/5, and both read the same prompt.
 *
 * Run:  node scripts/prompt-lab.mjs <model> [runs]
 */
const MODEL = process.argv[2] ?? 'qwen2.5:1.5b-instruct';
const RUNS = Number(process.argv[3] ?? 12);
const BASE = process.env.LOCAL_BASE_URL ?? 'http://127.0.0.1:11435/v1';
const KEY = 'local-no-key';

const INTENTS = ['seek', 'wander', 'charge_target', 'rest'];

const SHOTS = [
  { path_cells: 9, maze: '5x5' },
  { path_cells: 5, maze: '5x5' },
  { path_cells: 2, maze: '5x5' },
  { path_cells: 13, maze: '5x5' },
];

/** The prompt as it stands today, verbatim in structure. */
function current(targets, goal) {
  const lines = [
    'You control a bouncing character in a small 3D toy. Reply with ONE JSON object and nothing else.',
    '',
    'Fields:',
    `  action      one of ${INTENTS.join(', ')}`,
    '  target      the id of what to head toward, or null',
    '  intensity   number, 0 to 1',
    '  duration_s  number, 1 to 5',
    '',
    `Valid target ids: ${targets.join(', ')}.`,
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
  ];
  return lines.join('\n');
}

/** A: just drop the self-contradicting last line. Nothing else changes. */
function noVary(targets, goal) {
  return current(targets, goal).replace(
    '\n\nVary the action between calls. Do not repeat the same action every time.',
    '',
  );
}

/** B: A, plus one worked example. Small models imitate far better than they obey. */
function example(targets, goal) {
  return [
    'You control a bouncing character in a small 3D toy. Reply with ONE JSON object and nothing else.',
    '',
    'Fields:',
    `  action      one of ${INTENTS.join(', ')}`,
    `  target      the id to head toward. Valid ids: ${targets.join(', ')}.`,
    '  intensity   number, 0 to 1',
    '  duration_s  number, 1 to 5',
    '',
    `There is a reward at the far corner of a maze, and reaching it is the whole point of`,
    'the run. The character finds its own way through the corridors, so all you owe it is',
    'the decision to go. While the reward is uncollected, head for the goal.',
    `It is currently ${goal.path_cells} corridor turns away, in a ${goal.maze} maze.`,
    '',
    'Example answer:',
    '{"action":"charge_target","target":"goal","intensity":1,"duration_s":5}',
  ].join('\n');
}

/** C: B, and say the action explicitly for the post-goal case too. */
function exampleTwoState(targets, goal) {
  return [
    'You control a bouncing character in a small 3D toy. Reply with ONE JSON object and nothing else.',
    '',
    'Fields:',
    `  action      one of ${INTENTS.join(', ')}`,
    `  target      the id to head toward. Valid ids: ${targets.join(', ')}.`,
    '  intensity   number, 0 to 1',
    '  duration_s  number, 1 to 5',
    '',
    'A reward is waiting at the far corner of a maze and reaching it is the whole point of',
    'the run. The character finds its own way through the corridors, so all you owe it is',
    'the decision to go.',
    '',
    'While the reward is uncollected, answer exactly this shape, with "goal" as the target:',
    '{"action":"charge_target","target":"goal","intensity":1,"duration_s":5}',
    '',
    'Only after the reward is collected may you wander or rest.',
    `It is currently ${goal.path_cells} corridor turns away, in a ${goal.maze} maze.`,
  ].join('\n');
}

const VARIANTS = { current, noVary, example, exampleTwoState };

async function ask(prompt) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: 'The character has not reached the reward yet. What should it do?' },
      ],
      temperature: 0.9,
      max_tokens: 120,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return { err: `HTTP ${res.status}` };
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content ?? '';
  let p = null;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    p = m ? JSON.parse(m[0]) : null;
  } catch { p = null; }
  return { p, ms: data.usage ? 0 : 0 };
}

console.log(`model: ${MODEL}   runs per variant: ${RUNS}\n`);
const targets = ['block_a', 'block_b', 'ramp', 'goal'];
const summary = [];

for (const [name, build] of Object.entries(VARIANTS)) {
  let goal = 0, nav = 0, unparsed = 0;
  const seen = new Map();
  const t0 = Date.now();
  for (let i = 0; i < RUNS; i += 1) {
    const goalInfo = SHOTS[i % SHOTS.length];
    const { p, err } = await ask(build(targets, goalInfo));
    if (err || !p) { unparsed += 1; continue; }
    const key = `${p.action}:${p.target}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (p.target === 'goal') goal += 1;
    // What the brain actually needs: a navigating action AND a resolvable target.
    if (p.target === 'goal' && (p.action === 'charge_target' || p.action === 'seek')) nav += 1;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const top = [...seen.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`).join('  ');
  summary.push({ name, goal, nav, unparsed });
  console.log(
    `${name.padEnd(16)} goal=${String(goal).padStart(2)}/${RUNS}  `
    + `navigates=${String(nav).padStart(2)}/${RUNS}  unparsed=${unparsed}  ${secs}s`,
  );
  console.log(`${''.padEnd(16)} ${top}\n`);
}

console.log('navigates = the combination brain.js needs: charge_target|seek + target "goal".');
console.log('A model can score goal=100% and still not navigate if it pairs the goal with wander.');
