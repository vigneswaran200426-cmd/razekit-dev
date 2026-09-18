export const ORCHESTRATION_STATUS = {
  READY: "ready",
  PLANNING: "planning",
  IMPLEMENTING: "implementing",
  REVIEWING: "reviewing",
  ITERATING: "iterating",
  BLOCKED: "blocked",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
};

export const ORCHESTRATION_PHASES = [
  ORCHESTRATION_STATUS.PLANNING,
  ORCHESTRATION_STATUS.IMPLEMENTING,
  ORCHESTRATION_STATUS.REVIEWING
];

export const REVIEW_DECISIONS = {
  PASS: "pass",
  REVISE: "revise",
  BLOCK: "block"
};

export function createDefaultModelSessions(agent) {
  return [
    {
      id: null,
      agentInstanceId: agent.id,
      provider: agent.modelConfig?.primaryProvider || "fable",
      model: agent.modelConfig?.primary || "fable-5.1",
      role: "implementer",
      state: "ready",
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0
    },
    {
      id: null,
      agentInstanceId: agent.id,
      provider: agent.modelConfig?.reviewerProvider || "astra",
      model: agent.modelConfig?.reasoningReviewer || "gpt-astra",
      role: "planner_reviewer",
      state: "ready",
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0
    }
  ];
}
