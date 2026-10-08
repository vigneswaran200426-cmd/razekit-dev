// A DEV worker: claims builds from the shared queue and runs their ticks.
//
// Any number of workers poll the same store; claiming is SKIP LOCKED under a
// lease, so they never take the same build and never wait on each other. A
// worker declares what it can build (web, game) and its capacity, heartbeats
// so an operator can see it, and honours the pause switch. A worker that dies
// simply stops heartbeating: it is marked offline and the leases it held
// expire, so its builds are picked up elsewhere without it cooperating.
//
// No address is configured and none is recorded — workers dial out to the
// store. Adding a worker, or moving to another provider, is a deployment
// change, not a configuration change here.
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AGENTS } from './engine/agents.js';
import type { AgentType } from './engine/types.js';
import type { Orchestrator } from './orchestrator.js';
import type { DevStore } from './store/types.js';

export const CONTROL_EXECUTION = 'execution';

export interface ExecutionControl {
  paused: boolean;
  reason?: string;
  by?: string;
  at?: string;
}

export interface WorkerOptions {
  store: DevStore;
  orchestrator: Orchestrator;
  capabilities: string[];
  capacity: number;
  leaseMs: number;
  pollMs?: number;
  heartbeatMs?: number;
  id?: string;
  log?: (message: string) => void;
  /**
   * Platform work run between polls (Battle Mode's pass). It never delays
   * builds: it runs detached, one at a time, and a failure is only logged.
   */
  periodic?: { everyMs: number; run: () => Promise<unknown> };
}

export function agentTypesFor(capabilities: string[]): AgentType[] {
  return (Object.values(AGENTS) as { type: AgentType; requires: readonly string[] }[])
    .filter((a) => a.requires.every((r) => capabilities.includes(r)))
    .map((a) => a.type);
}

export class DevWorker {
  readonly id: string;
  private running = false;
  private inFlight = new Set<Promise<unknown>>();
  private loop: Promise<void> | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private startedAt = new Date().toISOString();
  private agentTypes: AgentType[];
  private wake: (() => void) | null = null;
  private periodicAt = 0;
  private periodicRunning = false;

  constructor(private opts: WorkerOptions) {
    this.id = opts.id ?? `wkr_${os.hostname().replace(/[^a-z0-9-]/gi, '').slice(0, 20)}_${randomUUID().slice(0, 8)}`;
    this.agentTypes = agentTypesFor(opts.capabilities);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.heartbeat('online');
    this.heartbeatTimer = setInterval(() => void this.heartbeat('online'), this.opts.heartbeatMs ?? 15_000);
    this.heartbeatTimer.unref?.();
    this.loop = this.run();
    this.opts.log?.(`[dev-worker] ${this.id} online: ${this.agentTypes.join(', ') || 'no agents'} × ${this.opts.capacity}`);
  }

  /** Stops claiming, waits for the ticks in flight, and goes offline. */
  async stop() {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.heartbeat('draining');
    await this.loop;
    await Promise.allSettled([...this.inFlight]);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.heartbeat('offline');
    this.opts.log?.(`[dev-worker] ${this.id} stopped`);
  }

  /** Claims and runs at most one tick. Used by tests and the end-to-end check. */
  async runOnce(): Promise<boolean> {
    if (await this.paused()) return false;
    const claim = await this.opts.store.claimTask(this.id, { leaseMs: this.opts.leaseMs, agentTypes: this.agentTypes });
    if (!claim) return false;
    await this.opts.orchestrator.run(claim);
    return true;
  }

  private async run() {
    const poll = this.opts.pollMs ?? 1_000;
    while (this.running) {
      try {
        if (await this.paused()) {
          await this.sleep(poll * 5);
          continue;
        }
        let claimed = false;
        while (this.running && this.inFlight.size < this.opts.capacity) {
          const claim = await this.opts.store.claimTask(this.id, { leaseMs: this.opts.leaseMs, agentTypes: this.agentTypes });
          if (!claim) break;
          claimed = true;
          const p = this.opts.orchestrator.run(claim).finally(() => {
            this.inFlight.delete(p);
            this.wake?.();
          });
          this.inFlight.add(p);
        }
        this.maybePeriodic();
        if (!claimed) await this.sleep(poll);
        else if (this.inFlight.size >= this.opts.capacity) await this.sleep(poll * 10);
      } catch (e) {
        this.opts.log?.(`[dev-worker] ${this.id} poll failed: ${(e as Error).message.split('\n')[0]}`);
        await this.sleep(poll * 5);
      }
    }
  }

  private maybePeriodic() {
    const p = this.opts.periodic;
    if (!p || this.periodicRunning || Date.now() - this.periodicAt < p.everyMs) return;
    this.periodicAt = Date.now();
    this.periodicRunning = true;
    p.run()
      .catch((e) => this.opts.log?.(`[dev-worker] ${this.id} periodic work failed: ${(e as Error).message.split('\n')[0]}`))
      .finally(() => (this.periodicRunning = false));
  }

  private async paused(): Promise<boolean> {
    const control = await this.opts.store.getControl<ExecutionControl>(CONTROL_EXECUTION).catch(() => null);
    return Boolean(control?.paused);
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
    });
  }

  private async heartbeat(status: 'online' | 'draining' | 'offline') {
    try {
      await this.opts.store.heartbeat({
        id: this.id,
        hostname: os.hostname(),
        capabilities: this.opts.capabilities,
        capacity: this.opts.capacity,
        status,
        startedAt: this.startedAt,
        lastHeartbeatAt: new Date().toISOString(),
      });
      await this.opts.store.markSilentWorkersOffline(Math.max(60_000, (this.opts.heartbeatMs ?? 15_000) * 4));
    } catch {
      // A missed heartbeat is visible to operators as staleness; it must not
      // stop the worker from finishing the builds it holds.
    }
  }
}
