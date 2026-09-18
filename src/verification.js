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
  if (!workspace?.isolated) {
    return persistVerification(db, agent, task, {
      status: VERIFICATION_STATUS.FAILED,
      checks: [{
        key: "isolation",
        passed: false,
        category: FAILURE_CATEGORIES.ISOLATION,
        reason: "Agent workspace is not isolated"
      }],
      failures: ["Agent workspace is not isolated"]
    });
  }

  if (Number(agent.budgetUsed || 0) > Number(agent.budgetLimit)) {
    return persistVerification(db, agent, task, {
      status: VERIFICATION_STATUS.FAILED,
      checks: [{
        key: "budget",
        passed: false,
        category: FAILURE_CATEGORIES.BUDGET,
        reason: "Agent spend exceeds hard budget limit"
      }],
      failures: ["Agent spend exceeds hard budget limit"]
    });
  }

  const run = latestExecutionRun(db, agentInstanceId);
  const checks = requiredExecutionChecks(task, run);
  const failures = [];

  for (const check of checks) {
    if (!check.passed) failures.push(check.reason);
  }

  const artifactSteps = run?.result?.plan?.steps?.filter(step =>
    [APP_WEB_STEP_KINDS.PACKAGE, GAME_STEP_KINDS.PACKAGE].includes(step.kind) &&
    step.state === "passed"
  ) || [];

  if (requireArtifact && run && artifactSteps.length > 0) {
    const artifactEvidence = artifactSteps
      .flatMap(step => {
        const result = step.result || {};
        return [
          ...(Array.isArray(result.files) ? result.files.map(file => ({ path: file })) : []),
          result.manifest ? { manifest: result.manifest, outputDir: result.outputDir } : null,
          result.path ? { path: result.path } : null
        ].filter(Boolean);
      });

    let artifactCheck = { passed: false, reason: "No artifact evidence recorded" };
    for (const evidence of artifactEvidence) {
      artifactCheck = await verifyArtifact(workspace.path, evidence);
      if (artifactCheck.passed) break;
    }

    checks.push({
      key: "artifact",
      passed: artifactCheck.passed,
      category: FAILURE_CATEGORIES.ARTIFACT,
      reason: artifactCheck.reason,
      evidence: artifactCheck.passed ? passEvidence("artifact", artifactCheck) : null
    });
    if (!artifactCheck.passed) failures.push(artifactCheck.reason);
  }

  const criteria = db.acceptanceCriteria.filter(x => x.taskId === task.id);
  for (const criterion of criteria) {
    const normalized = criterion.text.toLowerCase();
    let passed = false;
    let evidence = null;

    if (failures.length === 0) {
      passed = true;
      evidence = passEvidence("task-execution", {
        executionRunId: run?.id || null,
        taskId: task.id
      });
    } else if (criterion.status === "passed" && criterion.evidence?.verifier === "razekit-dev-verification") {
      passed = true;
      evidence = criterion.evidence;
    }

    if (normalized.includes("deploy") && !checks.some(x => x.key === "deployment" && x.passed)) {
      passed = false;
      evidence = null;
    }

    if (passed) {
      criterion.status = "passed";
      criterion.evidence = evidence;
    } else if (criterion.status !== "skipped") {
      criterion.status = "failed";
      criterion.evidence = {
        verifier: "razekit-dev-verification",
        failures,
        verifiedAt: new Date().toISOString()
      };
    }
    criterion.updatedAt = new Date().toISOString();
  }

  const finalFailures = [];
  for (const check of checks) {
    if (!check.passed) finalFailures.push({
      category: check.category,
      reason: check.reason
    });
  }

  return persistVerification(db, agent, task, {
    status: finalFailures.length === 0 ? VERIFICATION_STATUS.PASSED : VERIFICATION_STATUS.FAILED,
    checks,
    failures: finalFailures,
    executionRunId: run?.id || null
  });
}

function persistVerification(_db, agent, task, result) {
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
