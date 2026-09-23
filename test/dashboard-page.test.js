import { strict as assert } from "node:assert";
import test from "node:test";

const { dashboardPage } = await import("../src/dashboard-page.js");

test("standalone frontend contains the complete task control surface", () => {
  assert.match(dashboardPage, /RazeKit DEV — Control Center/);
  assert.match(dashboardPage, /\+ New task/);
  assert.match(dashboardPage, /Review task/);
  assert.match(dashboardPage, /Authorize & create/);
  // The preview is not optional decoration: a task created without one cannot
  // be authorized, so a frontend without it is a frontend that cannot create
  // tasks at all.
  assert.match(dashboardPage, /\/api\/tasks\/preview/);
  assert.match(dashboardPage, /previewFingerprint/);
  assert.match(dashboardPage, /Will stop and ask you for/);
  assert.match(dashboardPage, /Nothing runs and nothing is authorized until you confirm/);
  assert.match(dashboardPage, /WORKING|DECISION NEEDED|IMPORTANT UPDATE|BLOCKED|COMPLETED/);
  assert.match(dashboardPage, /Tell the agent what to change/);
  assert.match(dashboardPage, /Approve/);
  assert.match(dashboardPage, /Decline/);
  assert.match(dashboardPage, /Cancel task/);
  assert.match(dashboardPage, /Deliverables/);
  assert.match(dashboardPage, /Important updates/);
});

test("frontend uses API-backed controls instead of prototype JSON dumps", () => {
  assert.match(dashboardPage, /\/api\/tasks\/.*\/dashboard/);
  assert.match(dashboardPage, /\/api\/tasks\/.*\/commands/);
  assert.match(dashboardPage, /\/api\/tasks\/.*\/changes\/.*\/approve/);
  assert.match(dashboardPage, /\/api\/tasks\/.*\/changes\/.*\/deny/);
  assert.match(dashboardPage, /\/api\/tasks\/.*\/cancel/);
  assert.doesNotMatch(dashboardPage, /<pre id="tasks">/);
  assert.doesNotMatch(dashboardPage, /JSON\.stringify\(await api\("\/api\/tasks"/);
});

test("frontend supports automatic refresh and responsive mobile controls", () => {
  assert.match(dashboardPage, /setInterval\(\(\) =>/);
  assert.match(dashboardPage, /mobileTasksBtn/);
  assert.match(dashboardPage, /@media\(max-width:820px\)/);
  assert.match(dashboardPage, /mobile-open/);
});
