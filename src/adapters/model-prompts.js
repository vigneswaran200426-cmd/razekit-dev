import { APP_WEB_STEP_KINDS } from "../app-web-domain.js";
import { GAME_STEP_KINDS, GAME_ENGINES } from "../game-domain.js";

// The response contracts the orchestrator depends on, written once and shared
// by both providers. These live outside the adapters because the contract
// belongs to the orchestrator, not to Anthropic or OpenAI — swapping a provider
// must not change what a planner or a reviewer is expected to return.

const APP_WEB_STEP_REFERENCE = `
Allowed step kinds for an App/Website plan:
- ${APP_WEB_STEP_KINDS.WORKSPACE_MKDIR}   { "path": "<relative dir>" }
- ${APP_WEB_STEP_KINDS.WORKSPACE_WRITE_FILE} { "path": "<relative file>", "content": "<full file contents>" }
- ${APP_WEB_STEP_KINDS.COMMAND}           { "executable": "node"|"npm"|"git", "args": [...], "cwd": "." }
- ${APP_WEB_STEP_KINDS.BROWSER_SMOKE}     { "checks": [...] }
- ${APP_WEB_STEP_KINDS.DEPLOY}            { "target": "<adapter target>" }
- ${APP_WEB_STEP_KINDS.PACKAGE}           { "outputDir": "artifacts" }

Rules:
- "executable" may ONLY be node, npm or git. There is no shell. Never use sh,
  bash, cmd, curl, wget, sudo, or any other program.
- Every path is relative to the task workspace. Never use "..", never use an
  absolute path, never reference anything outside the workspace.
- A ${APP_WEB_STEP_KINDS.PACKAGE} step requires a package.json with a name and a
  version, so write one before packaging.
- "npm test" and "npm run build" must correspond to scripts you actually wrote
  into package.json, or the step will fail.
- Prefer zero third-party dependencies: the workspace may have no network access
  for installs.`;

const GAME_STEP_REFERENCE = `
Allowed step kinds for a Game plan:
- ${GAME_STEP_KINDS.PROJECT_INIT} { "engine": "${Object.values(GAME_ENGINES).join('"|"')}" }
- ${GAME_STEP_KINDS.ASSET_WRITE}  { "path": "<relative file>", "content": "<contents>" }
- ${GAME_STEP_KINDS.ASSET_COPY}   { "source": "<relative>", "destination": "<relative>" }
- ${GAME_STEP_KINDS.COMMAND}      { "executable": "node"|"npm"|"git", "args": [...] }
- ${GAME_STEP_KINDS.ENGINE_ACTION} { "action": "<engine action>" }
- ${GAME_STEP_KINDS.PLAYTEST}     { "checks": [...] }
- ${GAME_STEP_KINDS.BUILD}        { "target": "<build target>" }
- ${GAME_STEP_KINDS.PACKAGE}      { "outputDir": "artifacts" }

The plan object itself must carry a top-level "engine" field.
Every path is relative to the task workspace; "..", absolute paths and anything
outside the workspace are rejected.`;

export function stepReferenceFor(taskType) {
  return taskType === "game" ? GAME_STEP_REFERENCE : APP_WEB_STEP_REFERENCE;
}

export const SYSTEM_PROMPT =
  "You are part of an isolated autonomous software development agent running " +
  "inside RazeKit. You work only inside the task workspace you are given. You " +
  "have no access to the host machine, to other tasks, or to any credential " +
  "that has not been explicitly provided to you. Never invent a credential, a " +
  "URL or a service you were not given. Answer with JSON only — no prose " +
  "outside the JSON object, no markdown fences.";

export function plannerPrompt(context) {
  return `You are ASTRA, the planning and architecture model for this task.

TASK
type: ${context.task.type}
title: ${context.task.title}
request: ${context.task.request}
specification: ${context.task.specification}

Produce the architecture and the ordered work plan. You do NOT write the code
and you do NOT write the execution steps — FABLE does that from your plan. Be
concrete about structure, files and acceptance, not about syntax.

Respond with exactly this JSON object:
{
  "summary": "<one paragraph describing the architecture you chose and why>",
  "steps": [
    { "id": "<slug>", "kind": "implementation", "description": "<what FABLE must build>" }
  ],
  "files": [ { "path": "<relative path>", "purpose": "<what it holds>" } ],
  "acceptanceCriteria": [ "<objectively checkable statement>" ],
  "risks": [ "<what could make this fail>" ]
}`;
}

export function implementerPrompt(context) {
  const architecture = context.blackboard?.find?.(entry => entry.key === "architecture.plan");
  const review = context.blackboard?.find?.(entry => entry.key === "review.result");

  return `You are FABLE, the implementation model for this task.

TASK
type: ${context.task.type}
title: ${context.task.title}
request: ${context.task.request}
specification: ${context.task.specification}

ASTRA'S ARCHITECTURE PLAN
${architecture ? JSON.stringify(architecture.value, null, 2) : "(none yet — derive a minimal one yourself)"}

${review ? `PREVIOUS REVIEW — you are fixing these findings, not starting over:
${JSON.stringify(review.value, null, 2)}` : ""}

Write the complete implementation as an executable plan. Every file you want to
exist must appear as its own step with its FULL final contents — there is no
patching and no partial file. Order the steps so that the workspace is valid at
every point: write files, then test, then build, then package.
${stepReferenceFor(context.task.type)}

Respond with exactly this JSON object:
{
  "summary": "<what you implemented and how>",
  "filesChanged": <integer>,
  "plan": {
    "id": "fable-plan-1",
    "version": 1,${context.task.type === "game" ? '\n    "engine": "<engine>",' : ""}
    "steps": [ { "id": "<slug>", "kind": "<allowed kind>", "phase": "<phase>", ... } ]
  }
}`;
}

export function reviewerPrompt(context) {
  const implementation = context.blackboard?.find?.(entry => entry.key === "implementation.result");
  const execution = context.blackboard?.find?.(entry => entry.key === "execution.lastResult");
  const lastEvent = context.blackboard?.find?.(entry => entry.key === "execution.lastEvent");

  return `You are ASTRA, reviewing the implementation for this task.

TASK
type: ${context.task.type}
title: ${context.task.title}
request: ${context.task.request}
specification: ${context.task.specification}

FABLE'S IMPLEMENTATION
${implementation ? JSON.stringify(implementation.value, null, 2) : "(none recorded)"}

EXECUTION RESULT
${execution ? JSON.stringify(execution.value, null, 2) : "(the plan has not been executed yet)"}

LAST EXECUTION EVENT
${lastEvent ? JSON.stringify(lastEvent.value, null, 2) : "(none)"}

Decide one of:
- "pass"   the work satisfies the request and the execution evidence supports it
- "revise" something is wrong or missing that FABLE can fix in another pass
- "block"  progress requires something only the user can supply — a credential,
           an external service, a decision, or authorisation beyond this task

Do not answer "pass" because the plan looks reasonable. Pass only when the
execution actually succeeded. If the execution failed, say what to change.

Respond with exactly this JSON object:
{
  "decision": "pass" | "revise" | "block",
  "reason": "<why, in one or two sentences>",
  "findings": [ { "severity": "high"|"medium"|"low", "detail": "<what is wrong>" } ],
  "blockedOn": "<what the user must supply, or null>"
}`;
}
