// Verify every relative link and anchor in README.md and docs/*.md resolves.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const root = process.cwd();
const files = ['README.md', ...['architecture', 'local-models', 'testing',
  'debugging-lessons', 'performance-analysis', 'security-notes', 'gotchas', 'roadmap']
  .map(n => `docs/${n}.md`)];

// GitHub's slugger: strip punctuation, lowercase, then turn each space into a
// hyphen WITHOUT collapsing runs -- an em dash between words leaves two spaces
// and therefore a double hyphen in the anchor.
const slug = h => h.toLowerCase()
  .replace(/[^\w\s-]/g, '').trim().replace(/\s/g, '-');

const headings = new Map();
for (const f of files) {
  const abs = join(root, f);
  if (!existsSync(abs)) { console.log(`MISSING FILE ${f}`); continue; }
  const set = new Set();
  let inFence = false;
  for (const line of readFileSync(abs, 'utf8').split(/\r?\n/)) {
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) set.add(slug(m[2]));
  }
  headings.set(resolve(abs).replace(/\\/g, '/'), set);
}

let bad = 0;
for (const f of files) {
  if (!existsSync(join(root, f))) continue;
  const text = readFileSync(join(root, f), 'utf8');
  const re = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text))) {
    const href = m[1];
    if (/^(https?:|mailto:)/.test(href)) continue;
    const [target, anchor] = href.split('#');
    const dir = dirname(join(root, f));
    const path = target === '' ? join(root, f) : join(dir, target);
    if (!existsSync(path)) {
      console.log(`BROKEN PATH  ${f} -> ${href}`); bad++; continue;
    }
    if (anchor) {
          const set = headings.get(path.replace(/\\/g, '/'));
          if (!set) { console.log(`NO HEADINGS  ${f} -> ${href}`); bad++; continue; }
          if (!set.has(anchor.toLowerCase())) {
            console.log(`BROKEN ANCHOR ${f} -> ${href}`);
            bad++;
          }
        }
  }
}
console.log(bad === 0 ? 'OK: all links and anchors resolve' : `${bad} broken`);
process.exit(bad === 0 ? 0 : 1);