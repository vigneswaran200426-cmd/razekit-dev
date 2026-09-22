import { AGENT_TYPES } from "./domain.js";
import { AppWebRuntime, buildAppWebExecutionPlan } from "./app-web-executor.js";
import { normalizeModelExecutionPlan, APP_WEB_STEP_KINDS } from "./app-web-domain.js";
import { GameRuntime, buildGameExecutionPlan } from "./game-executor.js";
import { normalizeGamePlan, GAME_STEP_KINDS } from "./game-domain.js";

// What differs between Niomi and Konami, in one place.
//
// The JEV executor is deliberately agent-agnostic: claim, reserve, execute,
// settle, complete is the same sequence whether the node writes a React
// component or initialises a Godot project. Everything that is NOT the same
// lives here, so adding a third production system later means adding a profile
// rather than threading `if (agentType === ...)` through the executor.
//
// The differences are smaller than they look. Both runtimes already expose the
// same `execute(step, context)` shape, which is why no wrapper is needed around
// the runtimes themselves. What actually differs:
//
//   1. which adapters the runtime is constructed with
//   2. which blackboard keys the orchestrator reads and writes
//   3. how a raw model plan is normalised and validated
//   4. what an execution run is called
//   5. game plans carry a top-level `engine` that individual steps depend on

const APP_WEB_PROFILE = {
  agentType: AGENT_TYPES.NIOMI,
  taskType: "app",
  runKind: "jev_graph",
  // The orchestrator has always used unprefixed keys for App/Web. Keeping them
  // means moving Konami onto JEV does not rename Niomi's state and break the
  // guard in the autonomous loop that decides whether a plan is fresh.
  keys: {
    plan: "execution.plan",
    lastResult: "execution.lastResult",
    lastEvent: "execution.lastEvent"
  },
  packageKinds: [APP_WEB_STEP_KINDS.PACKAGE],
  buildPlan: buildAppWebExecutionPlan,
  normalizePlan: normalizeModelExecutionPlan,
  createRuntime({ workspaceRoot, adapters = {} }) {
    return new AppWebRuntime({
      workspaceRoot,
      serviceAdapter: adapters.serviceAdapter ?? null,
      browserAdapter: adapters.browserAdapter ?? null,
      deploymentAdapter: adapters.deploymentAdapter ?? null
    });
  },
  planContext() {
    return {};
  }
};

const GAME_PROFILE = {
  agentType: AGENT_TYPES.KONAMI,
  taskType: "game",
  runKind: "jev_game_graph",
  keys: {
    plan: "game.execution.plan",
    lastResult: "game.execution.lastResult",
    lastEvent: "game.execution.lastEvent"
  },
  packageKinds: [GAME_STEP_KINDS.PACKAGE],
  buildPlan: buildGameExecutionPlan,
  normalizePlan: normalizeGamePlan,
  createRuntime({ workspaceRoot, adapters = {} }) {
    // Adapters are supplied by the caller exactly as the flat executor required
    // them. When none are configured an engine or build step fails with the
    // same "No game engine adapter is configured" it has always failed with —
    // moving onto JEV does not invent engine support that was never there.
    return new GameRuntime({
      workspaceRoot,
      engineAdapters: adapters.engineAdapters ?? new Map(),
      playtestAdapter: adapters.playtestAdapter ?? null,
      packagerAdapter: adapters.packagerAdapter ?? null
    });
  },
  /**
   * A game plan's engine is declared once, at the top of the plan, but the
   * steps that need it read `step.engine || context.engine`. The graph stores
   * nodes, not plans, so the engine has to travel with the execution context or
   * a build node would come to rest with no idea which engine to build.
   */
  planContext(plan) {
    return plan?.engine ? { engine: plan.engine } : {};
  }
};

const PROFILES = new Map([
  [AGENT_TYPES.NIOMI, APP_WEB_PROFILE],
  [AGENT_TYPES.KONAMI, GAME_PROFILE]
]);

/**
 * The execution profile for an agent.
 *
 * Throws on an unknown agent type rather than defaulting to App/Web: silently
 * running a new agent type through the wrong runtime would produce a confusing
 * failure deep inside a step instead of a clear one at the boundary.
 */
export function profileForAgentType(agentType) {
  const profile = PROFILES.get(agentType);
  if (!profile) throw new Error("No JEV execution profile for agent type: " + agentType);
  return profile;
}

export function profileForAgent(agent) {
  if (!agent?.agentType) throw new Error("Agent has no agentType");
  return profileForAgentType(agent.agentType);
}

export { APP_WEB_PROFILE, GAME_PROFILE };
