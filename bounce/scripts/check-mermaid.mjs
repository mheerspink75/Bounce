// Parse every ```mermaid block in README.md and docs/*.md with mermaid's own
// parser. A diagram that fails to parse renders as an error box on GitHub, and
// nothing else in CI would notice.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchor on the script's own location rather than process.cwd(), so this runs
// from the repo root (CI) or from bounce/ (locally) without either failing.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = repo;
const files = ['README.md',
  ...readdirSync(join(root, 'docs')).filter(n => n.endsWith('.md')).map(n => `docs/${n}`)];

// mermaid sanitises labels through DOMPurify, which needs a real DOM -- a stub
// makes every diagram "fail" with a DOMPurify error rather than a syntax one.
// jsdom is only installed in CI, so degrade to a clear skip rather than a
// misleading pass.
let mermaid;
try {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
    // Node 22+ defines globalThis.navigator as a getter-only accessor, so plain
    // assignment throws. defineProperty with configurable:true is the way in.
    for (const [k, v] of Object.entries({
      navigator: dom.window.navigator,
      Element: dom.window.Element,
      SVGElement: dom.window.SVGElement,
      DOMParser: dom.window.DOMParser,
    })) {
      Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    }
  ({ default: mermaid } = await import('mermaid'));
} catch (e) {
  console.log(`SKIP: jsdom/mermaid not usable (${String(e.message).split('\n')[0]})`);
  console.log('     npm i -D jsdom mermaid  to enable this check');
  process.exit(0);
}

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });

let total = 0, bad = 0;
for (const f of files) {
  const abs = join(root, f);
  if (!existsSync(abs)) continue;
  const text = readFileSync(abs, 'utf8');
    // These files are checked out with CRLF on Windows, so a bare \n after the
    // fence would never match and the check would silently report zero diagrams.
    const re = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g;
  let m, i = 0;
  while ((m = re.exec(text))) {
    i++; total++;
    const before = text.slice(0, m.index).split('\n').length;
    try {
      await mermaid.parse(m[1]);
    } catch (e) {
      bad++;
      console.log(`INVALID  ${f} block ${i} (line ${before}): ${String(e.message).split('\n')[0]}`);
    }
  }
}
console.log(bad === 0
  ? `OK: all ${total} mermaid blocks parse`
  : `${bad} of ${total} mermaid blocks failed to parse`);
process.exit(bad === 0 ? 0 : 1);