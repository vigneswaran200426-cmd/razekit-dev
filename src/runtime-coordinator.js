import { processReadyTasks, heartbeatAgent, completeAgent, failAgent } from "./agent-manager.js";
import { recoverExpiredJobs, recoverExpiredWorkers } from "./reliability.js";
import { recoverProductionAssignments } from "./production-runtime.js";
import { evaluateInfrastructureAlerts, recordObservabilityEvent } from "./observability.js";
import { advanceAllAgents } from "./autonomous-loop.js";

export class RuntimeCoordinator {
  constructor({
    tickMs = Number(process.env.RAZEKIT_TICK_MS || 15000),
    orchestrator = null
  } = {}) {
    if (!Number.isFinite(tickMs) || tickMs < 100) {
      throw new Error("tickMs must be at least 100 milliseconds");
    }
    this.tickMs = tickMs;
    // Without an orchestrator the coordinator still recovers workers and starts
    // agents; it just cannot drive them. That is the shape the tests use.
    this.orchestrator = orchestrator;
    this.timer = null;
    this.running = false;
  }

  async tick() {
    try {
      const workerRecovery = await recoverExpiredWorkers();
      const jobRecovery = await recoverExpiredJobs();
      const productionRecovery = await recoverProductionAssignments();
      const alerts = await evaluateInfrastructureAlerts();
      const agents = await processReadyTasks();
      const advanced = this.orchestrator
        ? await advanceAllAgents({ orchestrator: this.orchestrator })
        : [];
      return {
        ok: true,
        started: agents.length,
        advanced: advanced.length,
        stages: advanced.map(item => item.stage),
        recoveredWorkers: workerRecovery.length,
        recoveredJobs: jobRecovery.length,
        recoveredProductionAssignments: productionRecovery.length,
        openInfrastructureAlerts: alerts.length
      };
    } catch (error) {
      try {
        await recordObservabilityEvent({
          type: "runtime.coordinator.failure",
          severity: "critical",
          message: error.message || "Runtime coordinator tick failed"
        });
      } catch {}
      return {ok: false, error: error.message};
    }
  }

  /**
   * Runs a tick unless one is already in flight.
   *
   * A tick advances real builds, and a build step — npm install, a test run, a
   * compile — routinely outlasts the tick interval. setInterval does not care:
   * it fires again regardless, and two overlapping ticks both see the same
   * agent waiting to execute and both start it. The work is then done twice,
   * concurrently, in one workspace, and the retry ceiling trips on failures
   * that were really collisions.
   */
  async tickIfIdle() {
    if (this.running) return { ok: true, skipped: true };
    this.running = true;
    try {
      return await this.tick();
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return;
    this.tickIfIdle().catch(() => {});
    this.timer = setInterval(() => {
      this.tickIfIdle().catch(() => {});
    }, this.tickMs);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export function createRuntimeCoordinator(options) {
  return new RuntimeCoordinator(options);
}

export async function executeWithRuntime(adapter, agentContext) {
  if (!adapter || typeof adapter.execute !== "function") {
    throw new Error("No execution runtime adapter is configured");
  }
  try {
    const result = await adapter.execute(agentContext);
    await completeAgent(agentContext.agent.id, result?.summary || "Execution completed");
    return result;
  } catch (error) {
    await failAgent(agentContext.agent.id, error.message || "Execution failed");
    throw error;
  }
}
