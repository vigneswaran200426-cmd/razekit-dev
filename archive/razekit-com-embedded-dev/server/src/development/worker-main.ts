// The DEV worker process.
//
//   npm run dev:worker            (development, from server/)
//   npm run start:dev-worker      (production, after npm run build)
//
// Runs builds, and nothing else: it serves no HTTP and shares nothing with the
// marketplace API process except the database. That separation is the point —
// a build that exhausts memory or hangs takes this process down, not the
// contest API.
//
// It refuses to start unless the Development area is on and the engine is
// ready, and says why. SIGTERM finishes the steps in flight and exits.
import { config } from '../config.js';
import { getEngine, startWorker } from './bootstrap.js';

if (!config.development.enabled) {
  console.error('[dev-worker] DEV_AREA_ENABLED is not "true"; there is nothing for a worker to do.');
  process.exit(1);
}

const engine = await getEngine();
if (!engine.readiness.ready) {
  console.error('[dev-worker] Development is not ready on this deployment:');
  for (const p of engine.readiness.problems) console.error(`  - ${p}`);
  await engine.store.close();
  process.exit(1);
}

const worker = startWorker(engine);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[dev-worker] ${signal}: finishing the steps in flight`);
  await worker.stop();
  await engine.store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
