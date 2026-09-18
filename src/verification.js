import path from "node:path";
import { access } from "node:fs/promises";
import { id, loadDb, transact } from "./store.js";
import { TASK_STATUS } from "./domain.js";
import { GAME_STEP_KINDS } from "./game-domain.js";
import { APP_WEB_STEP_KINDS } from "./app-web-domain.js";
import {
  VERIFICATION_STATUS,
  FAILURE_CATEGORIES,
  classifyStepFailure
} from "./verification-domain.js";

const TERMINAL_EXECUTION_STATUSES = new Set(["completed", "failed", "cancelled"]);

function passEvidence(check, evidence = {}) {
  return {
    verifier: "razekit-dev-verification",
    check,
    verifiedAt: new Date().toISOString(),
    ...evidence
  };
}

function latestExecutionRun(db, agentInstanceId) {
  const runs = db.executionRuns
    .filter(x => x.agentInstanceId === agentInstanceId)
    .sort((a, b) => Date.parse(b.startedAt || b.createdAt || 0) - Date.parse(a.startedAt || a.createdAt || 0));
  return runs[0] || null;
}

function allStepsPassed(run) {
  return Boolean(
    run?.result?.plan?.steps?.length &&
    run.result.plan.steps.every(step => step.state === "passed")
  );
}

async function verifyArtifact(workspaceRoot, artifact) {
  if (!artifact) return { passed: false, reason: "No artifact evidence recorded" };
  const candidatePaths = [
    artifact.path,
    artifact.manifest,
    artifact.outputDir
  ].filter(Boolean);

  for (const relativePath of candidatePaths) {
    const resolved = path.resolve(workspaceRoot, relativePath);
    const relative = path.relative(workspaceRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { passed: false, reason: "Artifact path escapes workspace" };
    }
    try {
      await access(resolved);
      return { passed: true, path: relative };
    } catch {
      // Try the next evidence path.
    }
  }

  return {
    passed: false,
    reason: "Recorded artifact evidence does not exist in the workspace"
  };
}

function requiredExecutionChecks(task, run) {
  const steps = run?.result?.plan?.steps || [];
  const kinds = new Set(steps.map(step => step.kind));
  const checks = [
    {
      key: "execution",
      passed: run?.status === "completed" && allStepsPassed(run),
      category: FAILURE_CATEGORIES.EXECUTION,
      reason: "Execution run must be completed with every step passed"
    }
  ];

  const addKindCheck = (key, kind, category, reason) => {
    if (!kinds.has(kind)) return;
    const matching = steps.filter(step => step.kind === kind);
    checks.push({
      key,
      passed: matching.every(step => step.state === "passed"),
      category,
      reason
    });
  };

  addKindCheck(
    "tests",
    APP_WEB_STEP_KINDS.COMMAND,
    FAILURE_CATEGORIES.TEST,
    "All test/build command steps must pass"
  );
  addKindCheck(
    "smoke",
    APP_WEB_STEP_KINDS.BROWSER_SMOKE,
    FAILURE_CATEGORIES.SMOKE,
    "All browser smoke steps must pass"
  );
  addKindCheck(
    "deployment",
    APP_WEB_STEP_KINDS.DEPLOY,
    FAILURE_CATEGORIES.DEPLOYMENT,
    "All deployment steps must pass"
  );
  addKindCheck(
    "game-playtest",
    GAME_STEP_KINDS.PLAYTEST,
    FAILURE_CATEGORIES.TEST,
    "All game playtest steps must pass"
  );
  addKindCheck(
    "game-build",
    GAME_STEP_KINDS.BUILD,
    FAILURE_CATEGORIES.BUILD,
    "All game build steps must pass"
  );
  addKindCheck(
    "package",
    APP_WEB_STEP_KINDS.PACKAGE,
    FAILURE_CATEGORIES.ARTIFACT,
    "The App/Web package step must pass"
  );
  addKindCheck(
    "game-package",
    GAME_STEP_KINDS.PACKAGE,
    FAILURE_CATEGORIES.ARTIFACT,
    "The game package step must pass"
  );

  return checks;
}

export async function verifyTask(agentInstanceId, { requireArtifact = true } = {}) {
  const db = await loadDb();
  const agent = db.agentInstances.find(x => x.id === agentInstanceId);
  if (!agent) throw new Error("Agent instance not found");

  const task = db.tasks.find(x => x.id === agent.taskId);
  if (!task) throw new Error("Task not found");

  const workspace = db.workspaces.find(x => x.id === agent.workspaceId);
  const run = latestExecutionRun(db, agentInstanceId);
  const checks = [];

  if (!workspace?.isolated) {
    checks.push({
      key: "isolation",
      passed: false,
      category: FAILURE_CATEGORIES.ISOLATION,
      reason: "Agent workspace is not isolated"
    });
  }

  if (Number(agent.budgetUsed || 0) > Number(agent.budgetLimit)) {
    checks.push({
      key: "budget",
      passed: false,
      category: FAILURE_CATEGORIES.BUDGET,
      reason: "Agent spend exceeds hard budget limit"
    });
  }

  if (workspace?.isolated && Number(agent.budgetUsed || 0) <= Number(agent.budgetLimit)) {
    checks.push({
      key: "workspace-budget",
      passed: true,
      category: null,
      reason: null,
      evidence: passEvidence("workspace-budget", {
        isolatedWorkspace: true,
        budgetUsed: Number(agent.budgetUsed || 0),
        budgetLimit: Number(agent.budgetLimit)
      })
    });
  }

  checks.push(...requiredExecutionChecks(task, run));

  const artifactSteps = run?.result?.plan?.steps?.filter(step =>
    [APP_WEB_STEP_KINDS.PACKAGE, GAME_STEP_KINDS.PACKAGE].includes(step.kind) &&
    step.state === "passed"
  ) || [];

  if (requireArtifact && run && artifactSteps.length > 0) {
    const artifactEvidence = artifactSteps
      .flatMap(step => {
        const result = step.result || {};
        return [
          ...(Array.isArray(result.files) ? result.files.map(file => ({
            path: typeof file === "string" ? path.join(result.outputDir || "", file) : file.path
          })) : []),
          result.manifest ? { manifest: result.manifest, outputDir: result.outputDir } : null,
          result.path ? { path: result.path } : null
        ].filter(Boolean);
      });

    let artifactCheck = { passed: false, reason: "No artifact evidence recorded" };
    if (artifactEvidence.length === 0 && artifactSteps.length > 0) {
      artifactCheck = { passed: true, reason: null };
    } else {
      for (const evidence of artifactEvidence) {
        artifactCheck = await verifyArtifact(workspace.path, evidence);
        if (artifactCheck.passed) break;
      }
    }

    checks.push({
      key: "artifact",
      passed: artifactCheck.passed,
      category: FAILURE_CATEGORIES.ARTIFACT,
      reason: artifactCheck.reason,
      evidence: artifactCheck.passed ? passEvidence("artifact", artifactCheck) : null
    });
  }

  const failures = checks.filter(check => !check.passed);
  const criteria = db.acceptanceCriteria.filter(x => x.taskId === task.id);
  const criterionUpdates = criteria.map(criterion => {
    const normalized = String(criterion.text || "").toLowerCase();
    const deploymentCheck = checks.find(x => x.key === "deployment");
    const passed = failures.length === 0 && (!normalized.includes("deploy") || deploymentCheck?.passed);
    return {
      id: criterion.id,
      status: passed ? "passed" : criterion.status === "skipped" ? "skipped" : "failed",
      evidence: passed
        ? passEvidence("task-verification", {
            executionRunId: run?.id || null,
            taskId: task.id
          })
        : {
            verifier: "razekit-dev-verification",
            failures: failures.map(x => ({ category: x.category, reason: x.reason })),
            verifiedAt: new Date().toISOString()
          }
    };
  });

  const verification = {
    status: failures.length === 0 ? VERIFICATION_STATUS.PASSED : VERIFICATION_STATUS.FAILED,
    checks,
    failures: failures.map(check => ({
      category: check.category,
      reason: check.reason
    })),
    executionRunId: run?.id || null
  };

  return persistVerification(agent, task, verification, criterionUpdates);
}

function persistVerification(agent, task, result, criterionUpdates = []) {
  return transact(db => {
    const now = new Date().toISOString();
    const record = {
      id: id("verify"),
      taskId: task.id,
      agentInstanceId: agent.id,
      executionRunId: result.executionRunId || null,
      status: result.status,
      checks: result.checks || [],
      failures: result.failures || [],
      createdAt: now
    };

    for (const update of criterionUpdates) {
      const criterion = db.acceptanceCriteria.find(x => x.id === update.id && x.taskId === task.id);
      if (!criterion) continue;
      criterion.status = update.status;
      criterion.evidence = update.evidence;
      criterion.updatedAt = now;
    }

    db.verificationRuns.push(record);

    return record;
  });
}

export async function latestVerification(agentInstanceId) {
  const db = await loadDb();
  return db.verificationRuns
    .filter(x => x.agentInstanceId === agentInstanceId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] || null;
}

export function verificationSummary(record) {
  if (!record) return null;
  return {
    status: record.status,
    passed: record.status === VERIFICATION_STATUS.PASSED,
    failures: record.failures || [],
    checkCount: (record.checks || []).length
  };
}
