// The two agents, and which one a build gets.
//
//   website, app → Niomi   (web: pages, state, logic, a static bundle)
//   game         → Konami  (game: a runtime, a scene, input, a playable bundle)
//
// Routing is by task type and nothing else. A user cannot ask for "Konami, but
// for my landing page", and a model cannot re-route a build mid-flight: the
// agent is fixed when the task is created, and it decides the tool manifest,
// which decides what any step in that build is allowed to do.
import type { AgentType, TaskType, ToolName } from './types.js';
import { validation } from './errors.js';

export interface AgentDefinition {
  type: AgentType;
  label: string;
  taskTypes: readonly TaskType[];
  /** Everything this agent may ever use. The runtime may still lack some of it. */
  tools: readonly ToolName[];
  /** What a worker must declare before it is given this agent's builds. */
  requires: readonly string[];
  /** One line for the model: who it is building as. */
  brief: string;
}

export const AGENTS: Readonly<Record<AgentType, AgentDefinition>> = {
  niomi: {
    type: 'niomi',
    label: 'Niomi',
    taskTypes: ['website', 'app'],
    tools: ['files', 'node', 'test', 'build', 'package', 'browser', 'deploy-web'],
    requires: ['web'],
    brief:
      'Niomi builds websites and web apps: semantic, accessible, responsive HTML, CSS and dependency-free JavaScript, with tests and a static build.',
  },
  konami: {
    type: 'konami',
    label: 'Konami',
    taskTypes: ['game'],
    // Games get the engine check and never the web deployment tool: a game is
    // packaged, not deployed as a site.
    tools: ['files', 'node', 'test', 'build', 'package', 'engine'],
    requires: ['game'],
    brief:
      'Konami builds small, complete, playable browser games on the RazeKit game runtime: a fixed-step loop, input, collision, scoring and a restartable game-over state, with tests for the game logic.',
  },
};

export function agentForTaskType(taskType: TaskType): AgentDefinition {
  for (const agent of Object.values(AGENTS)) {
    if (agent.taskTypes.includes(taskType)) return agent;
  }
  throw validation(`No agent builds ${JSON.stringify(taskType)}.`);
}

export function agentDefinition(type: AgentType): AgentDefinition {
  const agent = AGENTS[type];
  if (!agent) throw validation(`Unknown agent ${JSON.stringify(type)}.`);
  return agent;
}
