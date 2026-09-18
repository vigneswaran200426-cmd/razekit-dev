import { getAgent, recordSpend } from "./agent-manager.js";

export async function checkBudget(agentId, amount) {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error("Agent instance not found");

  const spend = Number(amount);
  if (!Number.isFinite(spend) || spend < 0) {
    throw new Error("Budget amount must be a non-negative number");
  }

  const remaining = Number(agent.budgetLimit) - Number(agent.budgetUsed || 0);
  return {
    allowed: spend <= remaining,
    requested: spend,
    remaining,
    budgetLimit: Number(agent.budgetLimit),
    budgetUsed: Number(agent.budgetUsed || 0)
  };
}

export async function charge(agentId, amount, reason) {
  return recordSpend(agentId, amount, reason);
}
