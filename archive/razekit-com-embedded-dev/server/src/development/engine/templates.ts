// What the deterministic builder writes.
//
// These are complete, working projects — semantic markup, responsive styles,
// real logic, real tests, a real build script — not stubs that exist to make a
// pipeline look green. The verifier treats them exactly as it treats a real
// model's output: it re-runs their tests and checks the built HTML.
//
// Three shapes: a landing page (website), a small stateful app, and a game on
// the RazeKit Game Runtime (the Endless Runner Kit). Which sections, colours
// and headings appear follows the request and any refinements, by rule rather
// than by reasoning — that is the whole difference from a real model.
import { GAME_RUNTIME_ID, GAME_RUNTIME_PATH } from './gameRuntime.js';
import type { AcceptanceCheck, PlannedFile, TaskType } from './types.js';

export interface SiteSection {
  id: string;
  label: string;
}

export interface TemplateSpec {
  taskType: TaskType;
  title: string;
  tagline: string;
  sections: SiteSection[];
  colors: Record<string, string>;
  headline: string | null;
}

// ── Reading a request ─────────────────────────────────────────────────────────

const OPTIONAL_SECTIONS: { id: string; label: string; pattern: RegExp }[] = [
  { id: 'features', label: 'Features', pattern: /\bfeatures?\b/i },
  { id: 'pricing', label: 'Pricing', pattern: /\bpric(e|es|ing)\b/i },
  { id: 'gallery', label: 'Gallery', pattern: /\b(gallery|portfolio|showcase)\b/i },
  { id: 'testimonials', label: 'Testimonials', pattern: /\b(testimonials?|reviews?)\b/i },
  { id: 'faq', label: 'FAQ', pattern: /\b(faq|questions)\b/i },
  { id: 'contact', label: 'Contact', pattern: /\b(contact|form|get in touch)\b/i },
];

const COLOR_WORDS: Record<string, string> = {
  'dark blue': '#0b1f4d',
  navy: '#0b1f4d',
  blue: '#1d4ed8',
  'light blue': '#7dd3fc',
  red: '#b91c1c',
  green: '#15803d',
  teal: '#0f766e',
  purple: '#6d28d9',
  pink: '#be185d',
  orange: '#c2410c',
  yellow: '#ca8a04',
  black: '#0a0a0a',
  white: '#ffffff',
  gray: '#4b5563',
  grey: '#4b5563',
};

const COLOR_TARGETS: Record<string, string> = {
  hero: 'hero',
  header: 'nav',
  nav: 'nav',
  navigation: 'nav',
  footer: 'footer',
  button: 'accent',
  buttons: 'accent',
  cta: 'accent',
  accent: 'accent',
  background: 'page',
  page: 'page',
  sky: 'page',
  player: 'accent',
};

const DEFAULT_COLORS: Record<string, string> = {
  page: '#ffffff',
  hero: '#0f172a',
  nav: '#ffffff',
  footer: '#0f172a',
  accent: '#4f46e5',
};

/** Colour instructions in plain English: "make the hero dark blue". */
export function readColors(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const words = Object.keys(COLOR_WORDS).sort((a, b) => b.length - a.length).join('|');
  const targets = Object.keys(COLOR_TARGETS).join('|');
  const re = new RegExp(`\\b(${targets})\\b[^.;,\\n]{0,24}?\\b(${words})\\b`, 'gi');
  for (const m of text.matchAll(re)) out[COLOR_TARGETS[m[1].toLowerCase()]] = COLOR_WORDS[m[2].toLowerCase()];
  return out;
}

/** "change the headline to "X"" or "title should say X". */
export function readHeadline(text: string): string | null {
  const m = text.match(/\b(headline|heading|title)\b[^"“']{0,30}["“']([^"”']{1,80})["”']/i);
  return m ? m[2].trim() : null;
}

export function specFor(taskType: TaskType, title: string, request: string, refinements: string[]): TemplateSpec {
  const all = [request, ...refinements].join('\n');
  const sections = OPTIONAL_SECTIONS.filter((s) => s.pattern.test(request)).map(({ id, label }) => ({ id, label }));
  const colors = { ...DEFAULT_COLORS };
  for (const text of [request, ...refinements]) Object.assign(colors, readColors(text));
  const firstSentence = request.split(/(?<=[.!?])\s/)[0].slice(0, 160);
  return { taskType, title: title || 'Untitled build', tagline: firstSentence, sections, colors, headline: readHeadline(all) };
}

// ── Mapping plain-English criteria to machine checks ─────────────────────────

const CRITERION_CHECKS: { pattern: RegExp; check: (entry: string) => AcceptanceCheck }[] = [
  { pattern: /\b(nav|navigation|menu)\b/i, check: (p) => ({ type: 'html_has', path: p, tag: 'nav' }) },
  { pattern: /\bhero\b/i, check: (p) => ({ type: 'html_has', path: p, id: 'hero' }) },
  { pattern: /\b(call to action|cta)\b/i, check: (p) => ({ type: 'html_has', path: p, id: 'cta' }) },
  { pattern: /\bfooter\b/i, check: (p) => ({ type: 'html_has', path: p, tag: 'footer' }) },
  { pattern: /\bpricing\b/i, check: (p) => ({ type: 'html_has', path: p, id: 'pricing' }) },
  { pattern: /\b(gallery|portfolio)\b/i, check: (p) => ({ type: 'html_has', path: p, id: 'gallery' }) },
  { pattern: /\btestimonials?\b/i, check: (p) => ({ type: 'html_has', path: p, id: 'testimonials' }) },
  { pattern: /\b(contact|form)\b/i, check: (p) => ({ type: 'html_has', path: p, tag: 'form' }) },
  { pattern: /\bscore\b/i, check: (p) => ({ type: 'html_has', path: p, id: 'score' }) },
  { pattern: /\b(canvas|playable)\b/i, check: (p) => ({ type: 'html_has', path: p, tag: 'canvas' }) },
  { pattern: /\btests?\b/i, check: () => ({ type: 'tests_pass' }) },
];

export function checkForCriterion(text: string, entry: string): AcceptanceCheck | null {
  const hit = CRITERION_CHECKS.find((c) => c.pattern.test(text));
  return hit ? hit.check(entry) : null;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildScript(files: string[]) {
  return `// Build: copy the site into dist/. No bundler, no dependencies.
import { mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FILES = ${JSON.stringify(files)};
const OUT = 'dist';

rmSync(OUT, { recursive: true, force: true });
for (const file of FILES) {
  if (!existsSync(file)) throw new Error('Missing source file: ' + file);
  const target = join(OUT, file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
}
console.log('built ' + FILES.length + ' files into ' + OUT + '/');
`;
}

function baseCss(colors: Record<string, string>) {
  return `:root {
  --page: ${colors.page};
  --hero: ${colors.hero};
  --nav: ${colors.nav};
  --footer: ${colors.footer};
  --accent: ${colors.accent};
  --ink: #0f172a;
  --muted: #475569;
  --radius: 12px;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--page); line-height: 1.6; }
a { color: var(--accent); }
.container { width: min(1100px, 100% - 32px); margin-inline: auto; }
.button { display: inline-block; padding: 12px 22px; border-radius: var(--radius); background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; border: 0; cursor: pointer; font: inherit; }
.button:focus-visible, a:focus-visible, button:focus-visible, input:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.skip { position: absolute; left: -999px; }
.skip:focus { left: 16px; top: 16px; background: #fff; padding: 8px; z-index: 10; }
`;
}

// ── Website ───────────────────────────────────────────────────────────────────

function sectionBody(s: SiteSection): string {
  switch (s.id) {
    case 'features':
      return `<ul class="cards">
          <li><h3>Fast</h3><p>Loads instantly on any connection.</p></li>
          <li><h3>Accessible</h3><p>Usable with a keyboard and a screen reader.</p></li>
          <li><h3>Responsive</h3><p>Works from phones to wide screens.</p></li>
        </ul>`;
    case 'pricing':
      return `<ul class="cards">
          <li><h3>Starter</h3><p class="price">$0</p><p>Everything you need to begin.</p></li>
          <li><h3>Pro</h3><p class="price">$19</p><p>For teams that are growing.</p></li>
        </ul>`;
    case 'gallery':
      return `<div class="cards gallery">
          <figure><div class="tile" role="img" aria-label="Project one"></div><figcaption>Project one</figcaption></figure>
          <figure><div class="tile" role="img" aria-label="Project two"></div><figcaption>Project two</figcaption></figure>
          <figure><div class="tile" role="img" aria-label="Project three"></div><figcaption>Project three</figcaption></figure>
        </div>`;
    case 'testimonials':
      return `<blockquote><p>"Exactly what we needed."</p><cite>A happy customer</cite></blockquote>`;
    case 'faq':
      return `<details><summary>How do I get started?</summary><p>Use the button above.</p></details>`;
    case 'contact':
      return `<form class="contact" action="#" method="post" novalidate>
          <label for="contact-name">Name</label>
          <input id="contact-name" name="name" autocomplete="name" required>
          <label for="contact-email">Email</label>
          <input id="contact-email" name="email" type="email" autocomplete="email" required>
          <label for="contact-message">Message</label>
          <textarea id="contact-message" name="message" rows="4" required></textarea>
          <button class="button" type="submit">Send</button>
          <p class="form-status" role="status" aria-live="polite"></p>
        </form>`;
    default:
      return '';
  }
}

function websiteFiles(spec: TemplateSpec): PlannedFile[] {
  const heading = spec.headline || spec.title;
  const navLinks = [...spec.sections, { id: 'cta', label: 'Get started' }]
    .map((s) => `<li><a href="#${s.id}">${esc(s.label)}</a></li>`)
    .join('\n          ');
  const sections = spec.sections
    .map(
      (s) => `    <section id="${s.id}" class="section" aria-labelledby="${s.id}-title">
      <div class="container">
        <h2 id="${s.id}-title">${esc(s.label)}</h2>
        ${sectionBody(s)}
      </div>
    </section>`
    )
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(spec.title)}</title>
  <meta name="description" content="${esc(spec.tagline)}">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="site-header">
    <nav class="container nav" aria-label="Main">
      <a class="brand" href="#hero">${esc(spec.title)}</a>
      <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="nav-links">Menu</button>
      <ul id="nav-links" class="nav-links">
          ${navLinks}
      </ul>
    </nav>
  </header>
  <main id="main">
    <section id="hero" class="hero">
      <div class="container">
        <h1>${esc(heading)}</h1>
        <p class="lede">${esc(spec.tagline)}</p>
        <a class="button" href="#cta">Get started</a>
      </div>
    </section>
${sections}
    <section id="cta" class="section cta">
      <div class="container">
        <h2>Ready when you are</h2>
        <p>Start today. It takes a minute.</p>
        <a class="button" href="#hero">Start now</a>
      </div>
    </section>
  </main>
  <footer class="site-footer">
    <div class="container">
      <p>&copy; <span data-year></span> ${esc(spec.title)}</p>
    </div>
  </footer>
  <script type="module" src="main.mjs"></script>
</body>
</html>
`;

  const css = `${baseCss(spec.colors)}
.site-header { background: var(--nav); border-bottom: 1px solid #e2e8f0; position: sticky; top: 0; z-index: 5; }
.nav { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 64px; }
.brand { font-weight: 800; text-decoration: none; color: var(--ink); }
.nav-links { display: flex; gap: 20px; list-style: none; margin: 0; padding: 0; }
.nav-links a { text-decoration: none; color: var(--ink); font-weight: 500; }
.menu-toggle { display: none; background: none; border: 1px solid #cbd5e1; border-radius: 8px; padding: 6px 12px; font: inherit; }
.hero { background: var(--hero); color: #fff; padding: 96px 0; }
.hero h1 { font-size: clamp(2rem, 5vw, 3.5rem); line-height: 1.1; margin: 0 0 16px; }
.lede { font-size: 1.15rem; max-width: 60ch; opacity: .9; margin: 0 0 28px; }
.section { padding: 72px 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; list-style: none; padding: 0; }
.cards > * { border: 1px solid #e2e8f0; border-radius: var(--radius); padding: 20px; margin: 0; }
.tile { aspect-ratio: 4 / 3; border-radius: 8px; background: linear-gradient(135deg, var(--accent), var(--hero)); }
.price { font-size: 2rem; font-weight: 800; margin: 0; }
.contact { display: grid; gap: 8px; max-width: 480px; }
.contact input, .contact textarea { font: inherit; padding: 10px; border: 1px solid #cbd5e1; border-radius: 8px; }
.cta { background: #f1f5f9; text-align: center; }
.site-footer { background: var(--footer); color: #e2e8f0; padding: 32px 0; }
@media (max-width: 720px) {
  .menu-toggle { display: inline-block; }
  .nav-links { display: none; position: absolute; top: 64px; left: 0; right: 0; flex-direction: column; background: var(--nav); padding: 16px; border-bottom: 1px solid #e2e8f0; }
  .nav-links.open { display: flex; }
  .hero { padding: 64px 0; }
}
`;

  const main = `// Progressive enhancement only: the page works without this file.
const toggle = document.querySelector('.menu-toggle');
const links = document.getElementById('nav-links');
if (toggle && links) {
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  links.addEventListener('click', (e) => {
    if (e.target instanceof HTMLAnchorElement) {
      links.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
}
for (const el of document.querySelectorAll('[data-year]')) el.textContent = String(new Date().getFullYear());
const form = document.querySelector('form.contact');
if (form) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const status = form.querySelector('.form-status');
    if (!form.checkValidity()) { if (status) status.textContent = 'Please fill in every field.'; return; }
    if (status) status.textContent = 'Thanks - we will be in touch.';
    form.reset();
  });
}
`;

  const expectIds = ['hero', 'cta', ...spec.sections.map((s) => s.id)];
  const test = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const css = readFileSync('styles.css', 'utf8');

test('the page is a complete, localised HTML document', () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="[a-z-]+"/);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /<title>[^<]+<\\/title>/);
});

test('the page has navigation, a main landmark and a footer', () => {
  assert.match(html, /<nav[\\s>]/);
  assert.match(html, /<main[\\s>]/);
  assert.match(html, /<footer[\\s>]/);
});

test('every planned section is present exactly once', () => {
  for (const id of ${JSON.stringify(expectIds)}) {
    const count = html.split('id="' + id + '"').length - 1;
    assert.equal(count, 1, 'section #' + id);
  }
});

test('in-page links point at sections that exist', () => {
  for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) {
    assert.ok(html.includes('id="' + id + '"'), 'link target #' + id);
  }
});

test('there is exactly one h1', () => {
  assert.equal(html.split('<h1').length - 1, 1);
});

test('form fields are labelled', () => {
  for (const [, id] of html.matchAll(/<(?:input|textarea)[^>]*id="([^"]+)"/g)) {
    assert.ok(html.includes('for="' + id + '"'), 'label for ' + id);
  }
});

test('the layout adapts to small screens', () => {
  assert.match(css, /@media \\(max-width: \\d+px\\)/);
});
`;

  return [
    { path: 'index.html', content: html },
    { path: 'styles.css', content: css },
    { path: 'main.mjs', content: main },
    { path: 'tests/site.test.mjs', content: test },
    { path: 'build.mjs', content: buildScript(['index.html', 'styles.css', 'main.mjs']) },
  ];
}

// ── App ───────────────────────────────────────────────────────────────────────

function appFiles(spec: TemplateSpec): PlannedFile[] {
  const heading = spec.headline || spec.title;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(spec.title)}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="app-header"><div class="container"><h1>${esc(heading)}</h1><p class="lede">${esc(spec.tagline)}</p></div></header>
  <main id="app" class="container">
    <form id="add-form" class="add-form">
      <label for="new-item">New item</label>
      <input id="new-item" name="text" autocomplete="off" maxlength="200" required>
      <button class="button" type="submit">Add</button>
    </form>
    <div class="filters" role="group" aria-label="Show">
      <button type="button" data-filter="all" aria-pressed="true">All</button>
      <button type="button" data-filter="active" aria-pressed="false">Active</button>
      <button type="button" data-filter="done" aria-pressed="false">Done</button>
    </div>
    <ul id="items" class="items" aria-live="polite"></ul>
    <p id="summary" class="summary"></p>
  </main>
  <script type="module" src="app.mjs"></script>
</body>
</html>
`;

  const store = `// Pure application state. No DOM, so every rule here is testable.
export function createStore(initial = [], { now = () => Date.now() } = {}) {
  let items = initial.map((i) => ({ ...i }));
  let filter = 'all';
  let seq = items.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0);
  return {
    add(text) {
      const clean = String(text ?? '').trim().slice(0, 200);
      if (!clean) return null;
      const item = { id: String(++seq), text: clean, done: false, createdAt: now() };
      items = [...items, item];
      return item;
    },
    toggle(id) { items = items.map((i) => (i.id === id ? { ...i, done: !i.done } : i)); },
    remove(id) { items = items.filter((i) => i.id !== id); },
    setFilter(next) { if (['all', 'active', 'done'].includes(next)) filter = next; },
    get filter() { return filter; },
    visible() {
      if (filter === 'active') return items.filter((i) => !i.done);
      if (filter === 'done') return items.filter((i) => i.done);
      return items;
    },
    counts() { const done = items.filter((i) => i.done).length; return { total: items.length, done, active: items.length - done }; },
    toJSON() { return items; },
  };
}
`;

  const app = `import { createStore } from './store.mjs';

const KEY = 'razekit-app-items';
let saved = [];
try { saved = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { saved = []; }
const store = createStore(Array.isArray(saved) ? saved : []);

const form = document.getElementById('add-form');
const input = document.getElementById('new-item');
const list = document.getElementById('items');
const summary = document.getElementById('summary');

function persist() { try { localStorage.setItem(KEY, JSON.stringify(store.toJSON())); } catch { /* storage unavailable */ } }

function render() {
  list.replaceChildren(...store.visible().map((item) => {
    const li = document.createElement('li');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = item.done;
    box.id = 'item-' + item.id;
    box.addEventListener('change', () => { store.toggle(item.id); persist(); render(); });
    const label = document.createElement('label');
    label.htmlFor = box.id;
    label.textContent = item.text;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Remove';
    del.setAttribute('aria-label', 'Remove ' + item.text);
    del.addEventListener('click', () => { store.remove(item.id); persist(); render(); });
    li.append(box, label, del);
    return li;
  }));
  const c = store.counts();
  summary.textContent = c.total ? c.active + ' left, ' + c.done + ' done' : 'Nothing here yet.';
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (store.add(input.value)) { input.value = ''; persist(); render(); }
});
for (const b of document.querySelectorAll('[data-filter]')) {
  b.addEventListener('click', () => {
    store.setFilter(b.dataset.filter);
    for (const other of document.querySelectorAll('[data-filter]')) other.setAttribute('aria-pressed', String(other === b));
    render();
  });
}
render();
`;

  const css = `${baseCss(spec.colors)}
.app-header { background: var(--hero); color: #fff; padding: 40px 0; }
.app-header h1 { margin: 0; }
.add-form { display: flex; gap: 8px; align-items: end; flex-wrap: wrap; margin: 24px 0; }
.add-form label { width: 100%; font-weight: 600; }
.add-form input { flex: 1; min-width: 200px; font: inherit; padding: 10px; border: 1px solid #cbd5e1; border-radius: 8px; }
.filters { display: flex; gap: 8px; }
.filters button { font: inherit; padding: 6px 12px; border-radius: 999px; border: 1px solid #cbd5e1; background: #fff; }
.filters button[aria-pressed="true"] { background: var(--accent); color: #fff; border-color: var(--accent); }
.items { list-style: none; padding: 0; }
.items li { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
.items li label { flex: 1; }
.summary { color: var(--muted); }
@media (max-width: 600px) { .add-form { flex-direction: column; align-items: stretch; } }
`;

  const storeTest = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../store.mjs';

test('adding trims text and ignores empty input', () => {
  const s = createStore();
  assert.equal(s.add('   '), null);
  const item = s.add('  write tests  ');
  assert.equal(item.text, 'write tests');
  assert.equal(s.counts().total, 1);
});

test('toggling moves an item between active and done', () => {
  const s = createStore();
  const a = s.add('a');
  s.add('b');
  s.toggle(a.id);
  s.setFilter('done');
  assert.deepEqual(s.visible().map((i) => i.text), ['a']);
  s.setFilter('active');
  assert.deepEqual(s.visible().map((i) => i.text), ['b']);
});

test('removing deletes exactly one item', () => {
  const s = createStore();
  const a = s.add('a');
  s.add('b');
  s.remove(a.id);
  assert.deepEqual(s.toJSON().map((i) => i.text), ['b']);
});

test('ids stay unique after reloading saved items', () => {
  const s = createStore([{ id: '7', text: 'old', done: false }]);
  assert.equal(s.add('new').id, '8');
});

test('an unknown filter is ignored', () => {
  const s = createStore();
  s.setFilter('everything');
  assert.equal(s.filter, 'all');
});
`;

  const markupTest = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');

test('the app has a labelled input and a live list', () => {
  assert.match(html, /id="app"/);
  assert.match(html, /<form[\\s>]/);
  assert.match(html, /for="new-item"/);
  assert.match(html, /aria-live="polite"/);
});
`;

  return [
    { path: 'index.html', content: html },
    { path: 'styles.css', content: css },
    { path: 'store.mjs', content: store },
    { path: 'app.mjs', content: app },
    { path: 'tests/store.test.mjs', content: storeTest },
    { path: 'tests/markup.test.mjs', content: markupTest },
    { path: 'build.mjs', content: buildScript(['index.html', 'styles.css', 'store.mjs', 'app.mjs']) },
  ];
}

// ── Game: the Endless Runner Kit on the RazeKit Game Runtime ──────────────────

function gameFiles(spec: TemplateSpec): PlannedFile[] {
  const heading = spec.headline || spec.title;
  const manifest = {
    name: spec.title,
    entry: 'index.html',
    runtime: GAME_RUNTIME_ID,
    width: 800,
    height: 300,
    controls: { jump: ['Space', 'ArrowUp', 'KeyW', 'Pointer'], restart: ['Enter', 'KeyR'] },
    simulation: { module: 'game.mjs', factory: 'createGame' },
  };

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(spec.title)}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main class="stage">
    <h1>${esc(heading)}</h1>
    <p class="hud">Score: <strong id="score">0</strong> · Best: <strong id="best">0</strong></p>
    <canvas id="game" width="800" height="300" aria-label="${esc(spec.title)} game" role="img"></canvas>
    <p class="help">Space, Up or tap to jump. Enter to play again.</p>
  </main>
  <script type="module" src="main.mjs"></script>
</body>
</html>
`;

  const game = `// Game rules. No DOM and no clock: step() is given time and input, so every
// rule can be tested exactly, and the same seed replays the same run.
import { aabb, clamp, createRng } from './${GAME_RUNTIME_PATH}';

export const WORLD = { width: 800, height: 300, ground: 260, gravity: 2200, jump: 760, startSpeed: 320, maxSpeed: 720 };

export function createGame({ seed = 1 } = {}) {
  let rng = createRng(seed);
  const state = {};
  function reset() {
    rng = createRng(seed);
    Object.assign(state, {
      player: { x: 80, y: WORLD.ground - 40, w: 32, h: 40, vy: 0, grounded: true },
      obstacles: [],
      speed: WORLD.startSpeed,
      distance: 0,
      score: 0,
      spawnIn: 1.2,
      over: false,
    });
  }
  reset();

  function step(dt, input = {}) {
    if (state.over) {
      if (input.restart) reset();
      return state;
    }
    const p = state.player;
    if (input.jump && p.grounded) { p.vy = -WORLD.jump; p.grounded = false; }
    p.vy += WORLD.gravity * dt;
    p.y += p.vy * dt;
    if (p.y + p.h >= WORLD.ground) { p.y = WORLD.ground - p.h; p.vy = 0; p.grounded = true; }

    state.speed = clamp(state.speed + 8 * dt, WORLD.startSpeed, WORLD.maxSpeed);
    state.distance += state.speed * dt;
    state.score = Math.floor(state.distance / 10);

    state.spawnIn -= dt;
    if (state.spawnIn <= 0) {
      const h = rng.int(24, 56);
      state.obstacles.push({ x: WORLD.width + 20, y: WORLD.ground - h, w: rng.int(18, 30), h });
      state.spawnIn = rng.range(0.9, 1.8) * (WORLD.startSpeed / state.speed) + 0.35;
    }
    for (const o of state.obstacles) o.x -= state.speed * dt;
    state.obstacles = state.obstacles.filter((o) => o.x + o.w > -10);
    if (state.obstacles.some((o) => aabb(p, o))) state.over = true;
    return state;
  }

  return { state, step, reset };
}
`;

  const main = `import { createInput, createLoop } from './${GAME_RUNTIME_PATH}';
import { createGame, WORLD } from './game.mjs';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const bestEl = document.getElementById('best');
const game = createGame({ seed: Date.now() % 100000 });
const input = createInput({ jump: ['Space', 'ArrowUp', 'KeyW', 'Pointer'], restart: ['Enter', 'KeyR', 'Pointer'] });
input.attach(window);
let best = 0;
try { best = Number(localStorage.getItem('razekit-best') || 0); } catch { best = 0; }
bestEl.textContent = String(best);

const loop = createLoop({
  step(dt) {
    const wasOver = game.state.over;
    game.step(dt, { jump: input.isDown('jump'), restart: input.wasPressed('restart') });
    input.endFrame();
    if (!wasOver && game.state.over && game.state.score > best) {
      best = game.state.score;
      bestEl.textContent = String(best);
      try { localStorage.setItem('razekit-best', String(best)); } catch { /* storage unavailable */ }
    }
  },
  render() {
    const s = game.state;
    ctx.fillStyle = '${spec.colors.page === '#ffffff' ? '#e0f2fe' : spec.colors.page}';
    ctx.fillRect(0, 0, WORLD.width, WORLD.height);
    ctx.fillStyle = '#334155';
    ctx.fillRect(0, WORLD.ground, WORLD.width, WORLD.height - WORLD.ground);
    ctx.fillStyle = '${spec.colors.accent}';
    ctx.fillRect(s.player.x, s.player.y, s.player.w, s.player.h);
    ctx.fillStyle = '#0f172a';
    for (const o of s.obstacles) ctx.fillRect(o.x, o.y, o.w, o.h);
    scoreEl.textContent = String(s.score);
    if (s.over) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
      ctx.fillRect(0, 0, WORLD.width, WORLD.height);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 28px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Game over - press Enter or tap', WORLD.width / 2, WORLD.height / 2);
    }
  },
});
loop.start();
`;

  const css = `${baseCss(spec.colors)}
body { background: #0f172a; color: #e2e8f0; }
.stage { width: min(820px, 100% - 24px); margin: 32px auto; text-align: center; }
.hud { font-size: 1.1rem; }
canvas { width: 100%; height: auto; border-radius: var(--radius); background: #e0f2fe; touch-action: manipulation; }
.help { color: #94a3b8; }
`;

  const test = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, WORLD } from '../game.mjs';

const DT = 1 / 60;
const run = (g, seconds, input = {}) => { for (let t = 0; t < seconds; t += DT) g.step(DT, input); };

test('the player starts on the ground and the game is running', () => {
  const g = createGame();
  assert.equal(g.state.over, false);
  assert.equal(g.state.player.grounded, true);
  assert.equal(g.state.player.y + g.state.player.h, WORLD.ground);
});

test('jumping lifts the player and gravity brings them back', () => {
  const g = createGame();
  g.step(DT, { jump: true });
  run(g, 0.1);
  assert.ok(g.state.player.y + g.state.player.h < WORLD.ground, 'airborne after a jump');
  run(g, 1.5);
  assert.equal(g.state.player.grounded, true, 'landed again');
});

test('the player cannot jump again in mid-air', () => {
  const g = createGame();
  g.step(DT, { jump: true });
  const vy = g.state.player.vy;
  g.step(DT, { jump: true });
  assert.ok(g.state.player.vy > vy, 'a second press does not add lift');
});

test('the score grows with distance', () => {
  const g = createGame();
  g.state.spawnIn = 999;
  run(g, 1);
  assert.ok(g.state.score > 0);
});

test('hitting an obstacle ends the run, and restart begins a new one', () => {
  const g = createGame();
  const p = g.state.player;
  g.state.obstacles.push({ x: p.x, y: p.y, w: 20, h: 20 });
  g.step(DT);
  assert.equal(g.state.over, true);
  g.step(DT, { restart: true });
  assert.equal(g.state.over, false);
  assert.equal(g.state.score, 0);
});

test('the same seed replays the same run', () => {
  const a = createGame({ seed: 42 });
  const b = createGame({ seed: 42 });
  run(a, 3);
  run(b, 3);
  assert.deepEqual(a.state.obstacles, b.state.obstacles);
});
`;

  return [
    { path: 'index.html', content: html },
    { path: 'styles.css', content: css },
    { path: 'game.mjs', content: game },
    { path: 'main.mjs', content: main },
    { path: 'game.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: 'tests/game.test.mjs', content: test },
    {
      path: 'build.mjs',
      content: buildScript(['index.html', 'styles.css', 'game.mjs', 'main.mjs', 'game.json', GAME_RUNTIME_PATH]),
    },
  ];
}

export function templateFiles(spec: TemplateSpec): PlannedFile[] {
  if (spec.taskType === 'game') return gameFiles(spec);
  if (spec.taskType === 'app') return appFiles(spec);
  return websiteFiles(spec);
}

/** The checks a template is expected to satisfy, as the deterministic plan states them. */
export function templateAcceptance(spec: TemplateSpec): { text: string; check: AcceptanceCheck }[] {
  const entry = 'dist/index.html';
  const common = [
    { text: 'Its tests pass', check: { type: 'tests_pass' } as AcceptanceCheck },
    { text: 'It is packaged as a downloadable artifact', check: { type: 'artifact_packaged' } as AcceptanceCheck },
  ];
  if (spec.taskType === 'game') {
    return [
      { text: 'It builds to a playable page', check: { type: 'file_exists', path: entry } },
      { text: 'The game draws on a canvas', check: { type: 'html_has', path: entry, tag: 'canvas' } },
      { text: 'The score is shown', check: { type: 'html_has', path: entry, id: 'score' } },
      { text: 'It declares the RazeKit game runtime', check: { type: 'file_exists', path: 'dist/game.json' } },
      ...common,
    ];
  }
  if (spec.taskType === 'app') {
    return [
      { text: 'It builds to a static app', check: { type: 'file_exists', path: entry } },
      { text: 'Items can be added through a form', check: { type: 'html_has', path: entry, tag: 'form' } },
      { text: 'The app has a main view', check: { type: 'html_has', path: entry, id: 'app' } },
      ...common,
    ];
  }
  return [
    { text: 'It builds to a static site', check: { type: 'file_exists', path: entry } },
    { text: 'A navigation bar', check: { type: 'html_has', path: entry, tag: 'nav' } },
    { text: 'A hero section', check: { type: 'html_has', path: entry, id: 'hero' } },
    ...spec.sections.map((s) => ({ text: `A ${s.label.toLowerCase()} section`, check: { type: 'html_has', path: entry, id: s.id } as AcceptanceCheck })),
    { text: 'A call to action', check: { type: 'html_has', path: entry, id: 'cta' } },
    { text: 'A footer', check: { type: 'html_has', path: entry, tag: 'footer' } },
    ...common,
  ];
}
