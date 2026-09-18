import { id, transact, loadDb } from "./store.js";
import { recordSpend } from "./agent-manager.js";
import { readBlackboard, writeBlackboard, snapshotBlackboard } from "./blackboard.js";
import { listModelSessions, provisionModelSessions, recordModelUsage, updateModelSession } from "./model-sessions.js";
import {
  MODEL_ROLES,
  MODEL_PROVIDERS,
  callModel,
  ModelRuntimeError
} from "./model-runtime.js";
import {
  ORCHESTRATION_STATUS,
  REVIEW_DECISIONS
} from "./orchestrator-domain.js";

const MAX_CONTEXT_CHARS = Number(process.env.RAZEKIT_MODEL_CONTEXT_CHARS || 30000);
const MAX_REVIEW_CYCLES = Number(process.env.RAZEKIT_MAX_REVIEW_CYCLES || 5);

function buildTaskContext(task, agent, blackboard, recentMessages) {
  return {
    task: {
      id: task.id,
      type: task.taskType,
      title: task.title,
      request: task.originalRequest,
      specification: task.specification
    },
    agent: {
      id: agent.id,
      type: agent.agentType
    },
    blackboard,
    recentMessages
  };
}

function estimateContextSize(context) {
  return JSON.stringify(context).length;
}

export class ModelOrchestrator {
  constructor({ registry } = {}) {
    if (!registry) throw new Error("Model adapter registry is required");
    this.registry = registry;
  }

  async provision(agentId) {
    const db = await loadDb();
    const agent = db.agentInstances.find(x => x.id === agentId);
    if (!agent) throw new Error("Agent instance not found");

    const sessions = await provisionModelSessions(agent);

    await transact(state => {
      let run = state.orchestrationRuns.find(x => x.agentInstanceId === agent.id);
      if (!run) {
        run = {
          id: id("orch"),
          agentInstanceId: agent.id,
          status: ORCHESTRATION_STATUS.READY,
          cycle: 0,
          phase: null,
          contextVersion: 1,
          contextCompactions: 0,
          lastDecision: null,
          lastError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        state.orchestrationRuns.push(run);
      }
      return run;
    });

    return {
      run: await this.getRun(agent.id),
      sessions
    };
  }

  async step(agentId, { force = false } = {}) {
    const agent = await getAgent(agentId);
    if (!agent) throw new Error("Agent instance not found");

    const provisioned = await this.provision(agentId);
    let run = provisioned.run;

    if (["completed", "cancelled", "failed"].includes(run.status) && !force) {
      return { run, result: null };
    }

    const context = await this.buildContext(agent, run);
    if (estimateContextSize(context) > MAX_CONTEXT_CHARS) {
      await snapshotBlackboard(agent.id, "context_compaction");
      await transact(db => {
        const item = db.orchestrationRuns.find(x => x.id === run.id);
        item.contextVersion += 1;
        item.contextCompactions += 1;
        item.updatedAt = new Date().toISOString();
      });
      run = await this.getRun(agent.id);
    }

    if (run.phase === null || run.phase === "reviewing") {
      return this.runPlanning(agent, run, context);
    }

    if (run.phase === "planning") {
      return this.runImplementation(agent, run, context);
    }

    if (run.phase === "implementing") {
      return this.runReview(agent, run, context);
    }

    throw new Error("Unknown orchestration phase: " + run.phase);
  }

  async runPlanning(agent, run, context) {
    return this.runModelPhase({
      agent,
      run,
      phase: ORCHESTRATION_STATUS.PLANNING,
      sessionRole: MODEL_ROLES.PLANNER,
      provider: MODEL_PROVIDERS.ASTRA,
      prompt: "Create or refine the execution plan. Produce concrete next implementation steps.",
      context,
      nextPhase: ORCHESTRATION_STATUS.PLANNING
    });
  }

  async runImplementation(agent, run, context) {
    return this.runModelPhase({
      agent,
      run,
      phase: ORCHESTRATION_STATUS.IMPLEMENTING,
      sessionRole: MODEL_ROLES.IMPLEMENTER,
      provider: MODEL_PROVIDERS.FABLE,
      prompt: "Implement the current execution plan using the task workspace and approved tools.",
      context,
      nextPhase: ORCHESTRATION_STATUS.IMPLEMENTING
    });
  }

  async runReview(agent, run, context) {
    return this.runModelPhase({
      agent,
      run,
      phase: ORCHESTRATION_STATUS.REVIEWING,
      sessionRole: MODEL_ROLES.REVIEWER,
      provider: MODEL_PROVIDERS.ASTRA,
      prompt: "Review the implementation against the task and acceptance criteria. Decide pass, revise, or block.",
      context,
      nextPhase: ORCHESTRATION_STATUS.REVIEWING
    });
  }

  async runModelPhase({ agent, run, phase, sessionRole, provider, prompt, context }) {
    const sessions = await listModelSessions(agent.id);
    const session = sessions.find(s => {
      if (sessionRole === MODEL_ROLES.IMPLEMENTER) return s.provider === MODEL_PROVIDERS.FABLE;
      return s.provider === MODEL_PROVIDERS.ASTRA;
    });
    if (!session) throw new Error("Required model session is not provisioned");

    await updateModelSession(session.id, { state: "running", lastError: null });

    await transact(db => {
      const item = db.orchestrationRuns.find(x => x.id === run.id);
      item.phase = phase;
      item.status = phase;
      item.updatedAt = new Date().toISOString();
      return item;
    });

    const request = {
      provider,
      model: session.model,
      role: sessionRole,
      system: "You are part of an isolated autonomous development agent. Do not assume access to resources outside the task.",
      prompt,
      context
    };

    let response;
    try {
      response = await callModel(this.registry, request);
    } catch (error) {
      await updateModelSession(session.id, {
        state: error instanceof ModelRuntimeError && error.retryable ? "retryable_error" : "failed",
        lastError: error.message
      });
      await transact(db => {
        const item = db.orchestrationRuns.find(x => x.id === run.id);
        item.status = error instanceof ModelRuntimeError && error.retryable ? ORCHESTRATION_STATUS.BLOCKED : ORCHESTRATION_STATUS.FAILED;
        item.lastError = error.message;
        item.updatedAt = new Date().toISOString();
        return item;
      });
      throw error;
    }

    const usage = response.usage || {};
    await recordModelUsage(session.id, usage);
    if (Number(usage.cost || 0) > 0) {
      await recordSpend(agent.id, Number(usage.cost), "model:" + provider + ":" + session.model);
    }

    await updateModelSession(session.id, {
      state: "ready",
      lastError: null
    });

    await writeBlackboard(agent.id, "last." + phase + ".response", response.output || response.text || response, provider);
    if (response.plan) await writeBlackboard(agent.id, "execution.plan", response.plan, provider);
    if (response.implementation) await writeBlackboard(agent.id, "implementation.result", response.implementation, provider);
    if (response.review) await writeBlackboard(agent.id, "review.result", response.review, provider);

    const reviewDecision = response.review?.decision;
    const shouldComplete = phase === ORCHESTRATION_STATUS.REVIEWING && reviewDecision === REVIEW_DECISIONS.PASS;
    const shouldRevise = phase === ORCHESTRATION_STATUS.REVIEWING && reviewDecision === REVIEW_DECISIONS.REVISE;
    const shouldBlock = phase === ORCHESTRATION_STATUS.REVIEWING && reviewDecision === REVIEW_DECISIONS.BLOCK;

    await transact(db => {
      const item = db.orchestrationRuns.find(x => x.id === run.id);
      item.lastDecision = reviewDecision || null;
      item.lastError = null;

      if (shouldComplete) {
        item.status = ORCHESTRATION_STATUS.COMPLETED;
      } else if (shouldBlock) {
        item.status = ORCHESTRATION_STATUS.BLOCKED;
      } else if (shouldRevise) {
        item.status = ORCHESTRATION_STATUS.ITERATING;
        item.cycle += 1;
      } else if (phase === ORCHESTRATION_STATUS.PLANNING) {
        item.status = ORCHESTRATION_STATUS.IMPLEMENTING;
        item.phase = ORCHESTRATION_STATUS.PLANNING;
      } else if (phase === ORCHESTRATION_STATUS.IMPLEMENTING) {
        item.status = ORCHESTRATION_STATUS.REVIEWING;
        item.phase = ORCHESTRATION_STATUS.IMPLEMENTING;
      }

      item.updatedAt = new Date().toISOString();
      return item;
    });

    const updatedRun = await this.getRun(agent.id);

    if (updatedRun.cycle >= MAX_REVIEW_CYCLES && updatedRun.status === ORCHESTRATION_STATUS.ITERATING) {
      await transact(db => {
        const item = db.orchestrationRuns.find(x => x.id === run.id);
        item.status = ORCHESTRATION_STATUS.BLOCKED;
        item.lastError = "Maximum review cycles reached";
        item.updatedAt = new Date().toISOString();
      });
    }

    return {
      run: await this.getRun(agent.id),
      result: response
    };
  }

  async buildContext(agent, run) {
    const db = await loadDb();
    const task = db.tasks.find(x => x.id === agent.taskId);
    const messages = db.agentMessages
      .filter(x => x.agentInstanceId === agent.id)
      .slice(-20);
    const blackboard = await readBlackboard(agent.id);

    return buildTaskContext(task, agent, blackboard, messages);
  }

  async getRun(agentId) {
    const db = await loadDb();
    return db.orchestrationRuns.find(x => x.agentInstanceId === agentId) || null;
  }

  async getState(agentId) {
    return {
      run: await this.getRun(agentId),
      sessions: await listModelSessions(agentId),
      blackboard: await readBlackboard(agentId)
    };
  }
}
