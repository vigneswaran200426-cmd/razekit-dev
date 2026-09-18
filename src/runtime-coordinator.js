import { processReadyTasks, heartbeatAgent, completeAgent, failAgent } from "./agent-manager.js";

export class RuntimeCoordinator {
  constructor({tickMs = Number(process.env.RAZEKIT_TICK_MS || 15000)} = {}) {
    this.tickMs = tickMs;
    this.timer = null;
  }

  async tick() {
    try {
      const agents = await processReadyTasks();
      return {ok:true, started:agents.length};
    } catch (error) {
      return {ok:false, error:error.message};
    }
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
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

// This adapter boundary is intentionally small. The real model/tool runner will plug in here.
// It must return only after the external worker has either completed or failed.
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
