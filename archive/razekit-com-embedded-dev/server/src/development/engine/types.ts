// The vocabulary of RazeKit DEV.
//
// Everything a build is — its request, its state, its money, its evidence — is
// described here once, so the store, the orchestrator, the API and the tests
// cannot each grow their own slightly different idea of a task.
//
// Nothing in this file knows what a contest is. That is not an accident; see
// server/test/dev-boundary.test.ts.

export const TASK_TYPES = ['website', 'app', 'game'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const AGENT_TYPES = ['niomi', 'konami'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const TASK_STATE = {
  /** Created, money not yet secured. Never runnable. */
  AWAITING_FUNDING: 'awaiting_funding',
  QUEUED: 'queued',
  PLANNING: 'planning',
  IMPLEMENTING: 'implementing',
  EXECUTING: 'executing',
  REVIEWING: 'reviewing',
  VERIFYING: 'verifying',
  /** Stopped on a question only the user can answer. */
  WAITING_USER: 'waiting_user',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type TaskState = (typeof TASK_STATE)[keyof typeof TASK_STATE];

/** The coarse status the build list shows. Derived, never stored. */
export type TaskStatus = 'queued' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled';

/** The headline the Control Center shows. Derived, never stored. */
export type DashboardStatus = 'WORKING' | 'DECISION NEEDED' | 'IMPORTANT UPDATE' | 'BLOCKED' | 'COMPLETED' | 'STOPPED';

// ── Acceptance ────────────────────────────────────────────────────────────────

/**
 * A machine-checkable definition of one part of "done".
 *
 * Deliberately a closed set of structural checks rather than a pattern a model
 * writes. A regular expression authored by a model is a denial-of-service
 * waiting for a pathological input; these are all linear-time lookups.
 */
export type AcceptanceCheck =
  | { type: 'file_exists'; path: string }
  | { type: 'html_has'; path: string; tag?: string; id?: string; text?: string }
  | { type: 'tests_pass' }
  | { type: 'artifact_packaged' };

export interface AcceptanceCriterion {
  id: string;
  text: string;
  /** Who asked for it: the user at creation, or the plan. */
  source: 'user' | 'plan';
  check: AcceptanceCheck | null;
  status: 'pending' | 'passed' | 'failed';
  evidence?: string;
}

// ── Plans and results ────────────────────────────────────────────────────────

export interface ArchitecturePlan {
  summary: string;
  stack: string;
  files: { path: string; purpose: string }[];
  acceptance: { text: string; check: AcceptanceCheck | null }[];
  /** Where the build writes its output, and the file that must exist in it. */
  output: { dir: string; entry: string };
}

export const TOOL_NAMES = ['files', 'node', 'test', 'build', 'package', 'engine', 'browser', 'deploy-web', 'npm'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface PlannedFile {
  path: string;
  content: string;
}

export interface ExecutionStep {
  id: string;
  tool: ToolName;
  /** For node/build: the script, relative to the workspace. For test: test paths. */
  args?: string[];
  dependsOn?: string[];
  timeoutMs?: number;
  description?: string;
}

export interface ExecutionPlan {
  files: PlannedFile[];
  steps: ExecutionStep[];
  output: { dir: string; entry: string };
  /** What the implementer wants the user to know. Shown, never executed. */
  notes?: string;
}

export interface StepResult {
  id: string;
  tool: ToolName;
  status: 'passed' | 'failed' | 'skipped';
  exitCode: number | null;
  durationMs: number;
  /** Truncated and redacted. Never a secret, never unbounded. */
  output: string;
  error?: string;
}

export interface FileRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ExecutionResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  steps: StepResult[];
  filesWritten: FileRecord[];
  artifact: FileRecord | null;
}

export interface ReviewVerdict {
  decision: 'pass' | 'revise' | 'block';
  summary: string;
  issues: string[];
  /**
   * The reviewer's judgement on criteria no machine check can settle. Shown
   * as the reviewer's opinion, never as verified.
   */
  criteria: { id: string; met: boolean; note: string }[];
}

export interface VerificationFailure {
  check: string;
  reason: string;
}

export interface VerificationReport {
  status: 'not_run' | 'passed' | 'failed';
  failures: VerificationFailure[];
  checks: { check: string; passed: boolean; evidence: string }[];
  checkedAt: string | null;
}

// ── Preflight ────────────────────────────────────────────────────────────────

export interface Preflight {
  taskType: TaskType;
  predictedAgentType: AgentType;
  complexity: 'low' | 'medium' | 'high';
  predictedTools: ToolName[];
  unavailableTools: { tool: ToolName; reason: string }[];
  externalServices: string[];
  /** Dollars, for the form. The minor-unit value is authoritative. */
  estimatedBudget: number;
  estimatedBudgetMinor: number;
  breakdown: { phase: string; minor: number }[];
  currency: string;
  warnings: string[];
}

// ── The task ─────────────────────────────────────────────────────────────────

export interface Decision {
  kind: 'budget' | 'change' | 'review_block' | 'funding';
  message: string;
  changeId?: string;
  /** Minor units the build needs to carry on, when the question is money. */
  requiredMinor?: number;
}

export interface Reservation {
  id: string;
  amountMinor: number;
}

export interface Funding {
  mode: 'none' | 'ledger';
  /** Ledger reservations backing this task's budget, in the order taken. */
  reservations: Reservation[];
  settlement: null | {
    status: 'pending' | 'settled';
    consumedMinor?: number;
    creditedMinor?: number;
    settledAt?: string;
    error?: string;
  };
}

export interface Blackboard {
  architecturePlan: ArchitecturePlan | null;
  executionPlan: ExecutionPlan | null;
  lastResult: ExecutionResult | null;
  lastReview: ReviewVerdict | null;
  /** In-scope refinements the user asked for, applied at the next implement. */
  refinements: { changeId: string; content: string; at: string }[];
  /** What the last failure said, fed to the next implement as repair context. */
  repairNotes: string[];
}

export interface DeliveryRecord {
  repository: string;
  branch: string;
  baseBranch: string;
  commitSha: string;
  pullRequest: { number: number; url: string; draft: boolean };
  deliveredAt: string;
}

export interface DevTask {
  id: string;
  tenantId: string;
  userId: string;
  taskType: TaskType;
  agentType: AgentType;
  title: string;
  originalRequest: string;
  state: TaskState;
  /** Where a waiting task goes back to once the user has answered. */
  resumeState: TaskState | null;
  /** The pipeline stage a failed or cancelled build had reached. */
  stoppedFrom: TaskState | null;
  maxBudgetMinor: number;
  /** Written only by the governor, never by a state transition. */
  spentMinor: number;
  reservedMinor: number;
  currency: string;
  /** Optimistic concurrency: bumped on every state/data write. */
  revision: number;
  workspaceId: string;
  acceptance: AcceptanceCriterion[];
  preflight: Preflight;
  authorization: { acceptedAt: string; acceptedBy: string; statement: string };
  /**
   * implement/review/verify count completed passes through each phase.
   * transient counts back-to-back retries of one tick after a failure outside
   * our control; invalidOutput counts unusable model answers. Both reset when
   * the build moves on.
   */
  attempts: { implement: number; review: number; verify: number; transient: number; invalidOutput: number };
  blackboard: Blackboard;
  verification: VerificationReport;
  deliverables: FileRecord[];
  /** The packaged build. storageUri is set once it is in private object storage. */
  artifact: (FileRecord & { storageUri?: string | null }) | null;
  decision: Decision | null;
  failure: { code: string; message: string } | null;
  /** Where the owner is told about decisions and outcomes. From their session, never from input. */
  notifyEmail?: string | null;
  /** Where this verified build was delivered, once the owner asked for it. */
  delivery?: DeliveryRecord | null;
  funding: Funding;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** When a worker should next pick this task up. Null: nothing to do. */
  nextRunAt: string | null;
}

export interface DevEvent {
  id: string;
  taskId: string;
  tenantId: string;
  /** update: shown in Updates. chat: shown in Conversation. audit: never shown. */
  kind: 'update' | 'chat' | 'audit';
  status: DashboardStatus | null;
  role: 'user' | 'assistant' | 'system' | null;
  title: string;
  message: string;
  createdAt: string;
}

export interface DevChange {
  id: string;
  taskId: string;
  tenantId: string;
  content: string;
  classification: 'refinement' | 'boundary' | 'out_of_scope';
  status: 'applied' | 'pending' | 'approved' | 'denied';
  reason: string;
  budgetSnapshot: { projectedSpend: number; projectedSpendMinor: number; remainingMinor: number; withinBudget: boolean };
  createdAt: string;
  resolvedAt: string | null;
}

export interface SpendRecord {
  reservationId: string;
  taskId: string;
  kind: 'model' | 'compute';
  provider: string;
  operation: string;
  reservedMinor: number;
  actualMinor: number | null;
  /** What the provider billed beyond the reservation. RazeKit's cost, never the customer's. */
  overrunMinor: number;
  status: 'reserved' | 'captured' | 'released';
  createdAt: string;
  settledAt: string | null;
}

export interface WorkerRecord {
  id: string;
  hostname: string;
  capabilities: string[];
  capacity: number;
  status: 'online' | 'draining' | 'offline';
  startedAt: string;
  lastHeartbeatAt: string;
}
