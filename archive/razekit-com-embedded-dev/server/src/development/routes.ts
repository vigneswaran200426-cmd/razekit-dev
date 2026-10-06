// The RazeKit Development area's API.
//
// One product area inside the RazeKit application — a sibling of the contest,
// brand and creator areas, sharing their accounts and sessions but none of
// their domain logic. Every route is for a signed-in account, scoped to that
// account's own builds; the operator routes are for administrators only.
//
// Mounted only when DEV_AREA_ENABLED is on (see ../index.ts). The engine behind
// it is built on first request, so a deployment with the area switched off
// never touches the DEV schema, a model provider or a workspace.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAdmin, requireAuth } from '../auth/middleware.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getEngine, type DevEngine } from './bootstrap.js';
import { DevError } from './engine/errors.js';
import { DevService } from './service.js';

type ServiceFactory = () => Promise<DevService>;

let defaultService: Promise<DevService> | null = null;
const lazyService: ServiceFactory = () => {
  defaultService ??= getEngine()
    .then((engine: DevEngine) => new DevService(engine))
    .catch((e) => {
      defaultService = null;
      throw e;
    });
  return defaultService;
};

const createLimiter = rateLimit('dev-create', 10, 10 * 60_000, true);
const analyzeLimiter = rateLimit('dev-analyze', 30, 60_000, true);
const commandLimiter = rateLimit('dev-command', 30, 60_000, true);

export function createDevelopmentRouter(getService: ServiceFactory = lazyService): Router {
  const router = Router();

  /** Wraps a handler: resolves the service, maps DEV errors onto HTTP. */
  const handle =
    (fn: (svc: DevService, req: Request, res: Response) => Promise<unknown>, status = 200) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const svc = await getService();
        const body = await fn(svc, req, res);
        if (!res.headersSent) res.status(status).json(body);
      } catch (e) {
        if (e instanceof DevError) {
          res.status(e.httpStatus).json({ error: e.message, code: e.code });
          return;
        }
        next(e);
      }
    };

  // The one thing anyone may ask, signed in or not: whether the public site
  // should offer the DEV entry. It says nothing else about the deployment.
  router.get('/visibility', handle(async (svc) => ({ visible: (await svc.visibility()).visible })));

  router.use(requireAuth);

  const caller = (req: Request) => ({ id: req.user!.id, role: req.user!.role, email: req.appUser?.email ?? null });

  router.get('/engines', handle(async (svc) => svc.engines()));
  router.get('/status', handle(async (svc, req) => ({ ...svc.status(caller(req)), ...(await svc.entry(caller(req))) })));
  router.get('/budget', handle(async (svc, req) => svc.balances(caller(req))));

  /** Pre-flight: complexity, predicted tools, estimated budget. Creates nothing. */
  router.post('/tasks/analyze', analyzeLimiter, handle(async (svc, req) => svc.analyze(req.body)));

  router.get('/tasks', handle(async (svc, req) => svc.list(caller(req))));
  router.post(
    '/tasks',
    createLimiter,
    handle(async (svc, req) => svc.create(caller(req), req.body, { idempotencyKey: req.get('idempotency-key') ?? null }), 201)
  );
  router.get('/tasks/:id', handle(async (svc, req) => svc.get(caller(req), req.params.id)));
  router.patch('/tasks/:id', handle(async (svc, req) => svc.update(caller(req), req.params.id, req.body)));

  /** The Control Center projection: status, progress, budget, deliverables, chat. */
  router.get('/tasks/:id/dashboard', handle(async (svc, req) => svc.dashboard(caller(req), req.params.id)));
  router.get('/tasks/:id/events', handle(async (svc, req) => svc.events(caller(req), req.params.id)));
  router.get('/tasks/:id/acceptance', handle(async (svc, req) => svc.acceptance(caller(req), req.params.id)));
  router.get('/tasks/:id/artifact', handle(async (svc, req) => svc.artifact(caller(req), req.params.id)));

  /**
   * Something the user says mid-build. In-scope refinements are applied at the
   * next step; anything that crosses a boundary comes back as a decision.
   */
  router.post('/tasks/:id/commands', commandLimiter, handle(async (svc, req) => svc.command(caller(req), req.params.id, req.body?.content)));
  router.post('/tasks/:id/changes/:changeId/approve', handle(async (svc, req) => svc.approve(caller(req), req.params.id, req.params.changeId, req.body)));
  router.post('/tasks/:id/changes/:changeId/deny', handle(async (svc, req) => svc.deny(caller(req), req.params.id, req.params.changeId, req.body?.reason)));
  router.post('/tasks/:id/cancel', handle(async (svc, req) => svc.cancel(caller(req), req.params.id)));
  router.post('/tasks/:id/deliver', commandLimiter, handle(async (svc, req) => svc.deliver(caller(req), req.params.id, req.body)));

  // ── Operators ───────────────────────────────────────────────────────────────
  router.get('/admin/health', requireAdmin, handle(async (svc) => svc.health()));
  // ── Kit ─────────────────────────────────────────────────────────────────────
  const kit = (fn: (k: any, req: Request) => Promise<unknown>, status = 200) => handle(async (svc, req) => fn(svc.kit, req), status);
  router.get('/kit/accounts', kit((k, req) => k.accounts(caller(req))));
  router.get('/kit/posts', kit((k, req) => k.list(caller(req))));
  router.post('/kit/posts', commandLimiter, kit((k, req) => k.create(caller(req), req.body), 201));
  router.patch('/kit/posts/:id', kit((k, req) => k.update(caller(req), req.params.id, req.body)));
  router.post('/kit/posts/:id/submit', commandLimiter, kit((k, req) => k.submit(caller(req), req.params.id)));
  router.post('/kit/posts/:id/refresh', commandLimiter, kit((k, req) => k.refresh(caller(req), req.params.id)));
  router.post('/kit/posts/:id/abandon', kit((k, req) => k.abandon(caller(req), req.params.id)));
  router.post('/kit/posts/:id/cancel', kit((k, req) => k.cancel(caller(req), req.params.id)));
  router.post('/admin/kit/profiles', requireAdmin, kit((k, req) => k.linkProfile(caller(req), req.body?.userId, req.body?.profileId)));

  router.get('/admin/battle', requireAdmin, handle(async (svc) => svc.battleOverview()));
  router.post('/admin/battle/settings', requireAdmin, handle(async (svc, req) => svc.setBattleSettings(caller(req), req.body)));
  router.post('/admin/battle/benchmark', requireAdmin, handle(async (svc, req) => svc.runBenchmark(caller(req)), 201));
  router.post('/admin/battle/:id/decision', requireAdmin, handle(async (svc, req) => svc.decideBattle(caller(req), req.params.id, req.body)));
  router.get('/admin/incidents', requireAdmin, handle(async (svc) => svc.incidents()));
  router.post('/admin/incidents', requireAdmin, handle(async (svc, req) => svc.fileIncident(caller(req), req.body), 201));
  router.post('/admin/incidents/action', requireAdmin, handle(async (svc, req) => svc.actOnIncident(caller(req), String(req.body?.fingerprint ?? ''), req.body)));
  router.post('/admin/visibility', requireAdmin, handle(async (svc, req) => svc.setVisibility(caller(req), req.body?.visible, req.body?.reason)));
  router.post('/admin/execution', requireAdmin, handle(async (svc, req) => svc.setPaused(caller(req), req.body?.paused === true, req.body?.reason)));
  router.post('/admin/budget-purchases', requireAdmin, handle(async (svc, req) => svc.recordPurchase(caller(req), req.body), 201));

  return router;
}

export const developmentRouter = createDevelopmentRouter();
