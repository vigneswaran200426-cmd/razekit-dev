// The deterministic Astra and Fable.
//
// Used when no provider keys are configured, outside production. This is not a
// mock of the pipeline: the plan is a real plan, the files are real files, the
// tests really run, the build really builds, the artifact is really packaged,
// and completion is still gated on verification. Only the reasoning is
// rule-based instead of a model's — so it builds three well-defined shapes
// (a landing page, a small app, an endless-runner game) and says plainly when a
// request or a refinement asks for something it cannot reason about.
//
// It costs nothing and reports usage of zero. It never claims otherwise.
import { GAME_RUNTIME_DESCRIPTION, GAME_RUNTIME_PATH } from './gameRuntime.js';
import type { ImplementRequest, PlanRequest, ReviewRequest } from './prompts.js';
import type { AstraProvider, FableProvider, PreparedCall, ProviderResult } from './providers.js';
import { checkForCriterion, readColors, readHeadline, specFor, templateAcceptance, templateFiles } from './templates.js';
import type { AcceptanceCheck } from './types.js';

const FREE = { inputMinorPerMTok: 0, outputMinorPerMTok: 0 };

function free(raw: () => unknown): PreparedCall {
  return {
    ceilingMinor: 0,
    run: async (): Promise<ProviderResult> => ({ raw: raw(), usage: { inputTokens: 0, outputTokens: 0 }, costMinor: 0, model: 'razekit-deterministic' }),
  };
}

export function deterministicAstra(): AstraProvider {
  return {
    info: { role: 'astra', vendor: 'razekit', mode: 'deterministic', model: 'razekit-deterministic', available: true, price: FREE },
    preparePlan(req: PlanRequest) {
      return free(() => {
        const spec = specFor(req.task.taskType, req.task.title, req.task.originalRequest, []);
        const files = templateFiles(spec).map((f) => ({ path: f.path, purpose: purposeOf(f.path) }));
        const shape = req.task.taskType === 'game' ? 'an endless-runner game on the RazeKit game runtime' : req.task.taskType === 'app' ? 'a single-page app with tested state logic' : 'a responsive, accessible landing page';
        return {
          summary: `Build ${shape}: ${spec.tagline}`,
          stack: 'HTML, CSS and dependency-free ES modules; node:test; static build to dist/',
          files,
          acceptance: [
            ...templateAcceptance(spec),
            // The customer's own criteria, mapped to a check where a rule
            // recognises them and left unchecked (for review) where none does.
            ...req.task.acceptance
              .filter((c) => c.source === 'user')
              .map((c) => ({ text: c.text, check: checkForCriterion(c.text, 'dist/index.html') })),
          ].map((a) => ({ text: a.text, check: a.check ? toWire(a.check) : null })),
          output: { dir: 'dist', entry: 'index.html' },
        };
      });
    },
    prepareReview(req: ReviewRequest) {
      return free(() => {
        const failed = req.result.steps.filter((s) => s.status !== 'passed');
        const criteria = req.criteria
          .filter((c) => !c.check)
          .map((c) => ({
            id: c.id,
            met: false,
            note: 'The deterministic reviewer cannot judge a criterion that has no machine check. A real reviewer is needed for this one.',
          }));
        if (failed.length) {
          return {
            decision: 'revise',
            summary: `${failed.length} step(s) did not pass.`,
            issues: failed.map((s) => `${s.id} (${s.tool}) ${s.status}: ${(s.error || s.output).slice(-400)}`),
            criteria,
          };
        }
        return { decision: 'pass', summary: 'Every step passed.', issues: [], criteria };
      });
    },
  };
}

export function deterministicFable(): FableProvider {
  return {
    info: { role: 'fable', vendor: 'razekit', mode: 'deterministic', model: 'razekit-deterministic', available: true, price: FREE },
    prepareImplement(req: ImplementRequest) {
      return free(() => {
        const refinements = req.refinements.map((r) => r.content);
        const spec = specFor(req.task.taskType, req.task.title, req.task.originalRequest, refinements);
        const files = templateFiles(spec);
        const game = req.task.taskType === 'game';
        const testFiles = files.filter((f) => f.path.startsWith('tests/')).map((f) => f.path);
        const steps = [
          { id: 'test', tool: 'test', args: testFiles, dependsOn: [], description: 'Run the tests' },
          { id: 'build', tool: 'build', args: ['build.mjs'], dependsOn: ['test'], description: 'Build into dist/' },
          ...(game ? [{ id: 'engine', tool: 'engine', args: [], dependsOn: ['build'], description: 'Check the game manifest' }] : []),
          { id: 'package', tool: 'package', args: [], dependsOn: [game ? 'engine' : 'build'], description: 'Package the output' },
        ];
        // Say which refinements were applied and which were beyond a
        // rule-based builder, rather than silently ignoring the second kind.
        const understood = refinements.filter((r) => Object.keys(readColors(r)).length > 0 || readHeadline(r));
        const ignored = refinements.filter((r) => !understood.includes(r));
        const notes = [
          understood.length ? `Applied: ${understood.join('; ')}.` : '',
          ignored.length ? `The deterministic builder cannot apply: ${ignored.join('; ')}. A real model is needed for those.` : '',
        ].filter(Boolean).join(' ');
        return { files, steps, output: { dir: 'dist', entry: 'index.html' }, notes };
      });
    },
  };
}

/** A check in the flat shape the plan schema uses on the wire. */
function toWire(c: AcceptanceCheck) {
  return {
    type: c.type,
    path: 'path' in c ? c.path : null,
    tag: c.type === 'html_has' ? c.tag ?? null : null,
    id: c.type === 'html_has' ? c.id ?? null : null,
    text: c.type === 'html_has' ? c.text ?? null : null,
  };
}

function purposeOf(path: string): string {
  if (path === 'index.html') return 'The page';
  if (path === 'styles.css') return 'Responsive styles';
  if (path === 'build.mjs') return 'Copies the site into dist/';
  if (path === 'game.json') return 'Game manifest for the RazeKit runtime';
  if (path === 'game.mjs') return 'Game rules, no DOM';
  if (path === 'store.mjs') return 'Application state, no DOM';
  if (path === GAME_RUNTIME_PATH) return GAME_RUNTIME_DESCRIPTION;
  if (path.startsWith('tests/')) return 'Tests';
  return 'Browser wiring';
}
