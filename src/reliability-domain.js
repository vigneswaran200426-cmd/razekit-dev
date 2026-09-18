export const RECOVERY_STATES = {
  HEALTHY: "healthy",
  RECOVERING: "recovering",
  BLOCKED: "blocked",
  DEAD_LETTER: "dead_letter"
};

export const RECOVERY_EVENT_TYPES = {
  WORKER_LEASE_EXPIRED: "worker_lease_expired",
  JOB_LEASE_EXPIRED: "job_lease_expired",
  AGENT_RECREATED: "agent_recreated",
  CHECKPOINT_RESTORED: "checkpoint_restored"
};
