// The wall between RazeKit DEV and the contest marketplace.
//
// Both live in this repository, and that is exactly why this test exists: in
// one codebase, the shortest path between two modules is always an import, and
// one careless import is how a build engine ends up knowing what a contest is —
// or how a contest screen ends up broken because a DEV module failed to load.
//
// The rule, checked on every file:
//
//   • The marketplace never imports DEV. The single exception is the API entry
//     point mounting the DEV router (and starting the in-process worker), both
//     of which are behind the DEV_AREA_ENABLED switch.
//   • DEV imports only the shared core — identity, config, the ledger
//     primitives, the fee engine, the rate limiter, error capture. Never a
//     contest, submission, scoring, payout or payment module.
//
// The same rule holds on the web side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = path.resolve(HERE, '..', 'src');
const DEV_DIR = path.join(SERVER_SRC, 'development');
const WEB_SRC = path.resolve(HERE, '..', '..', 'src');

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

/** Every module specifier a file imports, statically or dynamically. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const specs = new Set<string>();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) specs.add(m[1]);
  }
  return [...specs];
}

/** Resolves a relative specifier to a path under src, with the .js → .ts swap tsc expects. */
function resolveServer(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  return path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
}

const rel = (p: string) => path.relative(SERVER_SRC, p).split(path.sep).join('/');

// The shared core DEV may lean on. Adding to this list is a deliberate act that
// should be argued for in review, not something a refactor does in passing.
const DEV_ALLOWED_SHARED = new Set([
  'config.ts',
  // The platform database client, for ledger postings only. DEV's own state
  // has its own client and schema (development/store/postgres.ts).
  'db.ts',
  'auth/middleware.ts',
  'entities/rls.ts',
  'entities/service.ts',
  'ledger/accounts.ts',
  'ledger/post.ts',
  'money/fees.ts',
  'middleware/rateLimit.ts',
  'errors/capture.ts',
  // Private object storage and signed URLs, for build artifacts.
  'integrations/storage.ts',
  // The platform's email sender (Resend), so DEV tells owners about decisions
  // and outcomes through the same, already-configured channel.
  'integrations/email.ts',
]);

// Packages DEV may use. Anything the marketplace pulls in for its own features
// (image providers, social SDKs, payment gateways) is not on it.
// The AWS SDK is for the sandboxed runtime only (ECS tasks, the run bucket).
const DEV_ALLOWED_PACKAGES = [/^node:/, /^express$/, /^@prisma\/client$/, /^@anthropic-ai\/sdk$/, /^@aws-sdk\/(client-ecs|client-s3|s3-request-presigner)$/];

// Where the marketplace is allowed to know DEV exists at all.
const MARKETPLACE_ENTRY_ALLOWED = new Map([
  ['index.ts', new Set(['development/routes.ts', 'development/bootstrap.ts'])],
]);

test('the marketplace never imports RazeKit DEV', () => {
  const offenders: string[] = [];
  for (const file of walk(SERVER_SRC, ['.ts'])) {
    if (file.startsWith(DEV_DIR + path.sep)) continue;
    const allowed = MARKETPLACE_ENTRY_ALLOWED.get(rel(file)) ?? new Set<string>();
    for (const spec of importsOf(file)) {
      const target = resolveServer(file, spec);
      if (!target || !target.startsWith(DEV_DIR + path.sep)) continue;
      if (!allowed.has(rel(target))) offenders.push(`${rel(file)} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], 'marketplace modules must not depend on DEV');
});

test('RazeKit DEV imports only the shared core', () => {
  const offenders: string[] = [];
  const files = walk(DEV_DIR, ['.ts']);
  assert.ok(files.length > 0, 'the DEV subsystem should exist');
  for (const file of files) {
    for (const spec of importsOf(file)) {
      const target = resolveServer(file, spec);
      if (target) {
        if (target.startsWith(DEV_DIR + path.sep)) continue;
        if (!DEV_ALLOWED_SHARED.has(rel(target))) offenders.push(`${rel(file)} → ${spec}`);
      } else if (!DEV_ALLOWED_PACKAGES.some((re) => re.test(spec))) {
        offenders.push(`${rel(file)} → package ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'DEV must not reach into marketplace domain modules');
});

test('DEV code never names a marketplace entity', () => {
  // An import is not the only way to couple. A DEV module reading
  // svc.entities.Contest would compile without importing anything.
  const MARKETPLACE_ENTITIES = [
    'Contest', 'Submission', 'ContestFunding', 'Payout', 'WithdrawalRequest', 'Wallet',
    'Review', 'WinnerPublish', 'Poll', 'SocialAccount', 'Campaign',
  ];
  const offenders: string[] = [];
  for (const file of walk(DEV_DIR, ['.ts'])) {
    const src = readFileSync(file, 'utf8');
    for (const name of MARKETPLACE_ENTITIES) {
      if (new RegExp(`entities\\.${name}\\b`).test(src)) offenders.push(`${rel(file)} uses entities.${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the web marketplace never imports the Development pages', () => {
  const devPages = path.join(WEB_SRC, 'pages', 'development');
  const offenders: string[] = [];
  for (const file of walk(WEB_SRC, ['.js', '.jsx'])) {
    if (file.startsWith(devPages + path.sep)) continue;
    const relWeb = path.relative(WEB_SRC, file).split(path.sep).join('/');
    for (const spec of importsOf(file)) {
      if (!/pages\/development/.test(spec)) continue;
      // App.jsx is the router: it lazily mounts the pages behind the flag.
      if (relWeb === 'App.jsx') continue;
      offenders.push(`${relWeb} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the Development pages never import marketplace pages or features', () => {
  const devPages = path.join(WEB_SRC, 'pages', 'development');
  const offenders: string[] = [];
  for (const file of walk(devPages, ['.js', '.jsx'])) {
    for (const spec of importsOf(file)) {
      const fromAlias = spec.startsWith('@/') ? spec.slice(2) : null;
      if (spec.startsWith('.') && !path.resolve(path.dirname(file), spec).startsWith(devPages)) {
        offenders.push(`${path.basename(file)} → ${spec}`);
      }
      if (fromAlias && /^(pages|features)\//.test(fromAlias) && !fromAlias.startsWith('pages/development')) {
        offenders.push(`${path.basename(file)} → ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
