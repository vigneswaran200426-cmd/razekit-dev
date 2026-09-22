import test from "node:test";
import assert from "node:assert/strict";

import { APP_WEB_STEP_KINDS } from "../src/app-web-domain.js";
import { GAME_STEP_KINDS } from "../src/game-domain.js";
import {
  graphFromExecutionPlan,
  distributeBudgetMinor,
  scopesForStep
} from "../src/jev-planner.js";
import { topologicalOrder, checkNodeToolScope, parseToolScope } from "../src/jev-domain.js";

const write = (id, path) => ({ id, kind: APP_WEB_STEP_KINDS.WORKSPACE_WRITE_FILE, path, content: "x" });
const command = (id, executable, args) => ({ id, kind: APP_WEB_STEP_KINDS.COMMAND, executable, args });

const plan = steps => ({ id: "plan-1", version: 1, steps });

const byKey = (nodes, key) => nodes.find(node => node.key === key);

test("independent file writes become parallel nodes", () => {
  const nodes = graphFromExecutionPlan(plan([
    write("a", "src/a.js"),
    write("b", "src/b.js"),
    write("c", "src/c.js")
  ]));

  // Nothing observes the workspace between them, so nothing orders them.
  for (const key of ["a", "b", "c"]) {
    assert.deepEqual(byKey(nodes, key).dependsOn, [], key + " has no dependency");
  }
});

test("writes to the same path stay ordered", () => {
  const nodes = graphFromExecutionPlan(plan([
    write("first", "package.json"),
    write("second", "package.json"),
    write("other", "src/index.js")
  ]));

  assert.deepEqual(byKey(nodes, "first").dependsOn, []);
  assert.deepEqual(byKey(nodes, "second").dependsOn, ["first"], "the later write must win");
  assert.deepEqual(byKey(nodes, "other").dependsOn, []);
});

test("a write inside a directory another step created stays ordered behind it", () => {
  const nodes = graphFromExecutionPlan(plan([
    { id: "mkdir", kind: APP_WEB_STEP_KINDS.WORKSPACE_MKDIR, path: "src/lib" },
    write("file", "src/lib/thing.js")
  ]));

  assert.deepEqual(byKey(nodes, "file").dependsOn, ["mkdir"]);
});

test("a command is a barrier: it depends on every step before it", () => {
  const nodes = graphFromExecutionPlan(plan([
    write("a", "src/a.js"),
    write("b", "src/b.js"),
    command("test", "npm", ["test"]),
    write("c", "src/c.js")
  ]));

  assert.deepEqual(byKey(nodes, "test").dependsOn.sort(), ["a", "b"]);
  // After a barrier, a write only needs the barrier — everything earlier is
  // already ordered through it.
  assert.deepEqual(byKey(nodes, "c").dependsOn, ["test"]);
});

test("the sequential guarantee of the original flat plan is never weakened", () => {
  const steps = [
    write("w1", "package.json"),
    write("w2", "src/index.js"),
    command("install", "npm", ["install"]),
    write("w3", "src/extra.js"),
    command("test", "npm", ["test"]),
    command("build", "npm", ["run", "build"]),
    { id: "pack", kind: APP_WEB_STEP_KINDS.PACKAGE, outputDir: "artifacts" }
  ];
  const nodes = graphFromExecutionPlan(plan(steps));
  const order = topologicalOrder(nodes);
  const at = key => order.indexOf(key);

  // Every barrier must still come after everything that preceded it in the list.
  for (const barrier of ["install", "test", "build", "pack"]) {
    const listIndex = steps.findIndex(s => s.id === barrier);
    for (const earlier of steps.slice(0, listIndex)) {
      assert.ok(at(earlier.id) < at(barrier), earlier.id + " must precede " + barrier);
    }
  }
});

test("a step's own dependsOn overrides the derivation", () => {
  const nodes = graphFromExecutionPlan(plan([
    write("a", "src/a.js"),
    write("b", "src/b.js"),
    { ...command("test", "npm", ["test"]), dependsOn: ["a"] }
  ]));

  assert.deepEqual(byKey(nodes, "test").dependsOn, ["a"], "not every prior step");
});

test("a declared dependency that does not exist is rejected", () => {
  assert.throws(
    () => graphFromExecutionPlan(plan([{ ...write("a", "x.js"), dependsOn: ["ghost"] }])),
    /depends on unknown node: ghost/
  );
});

test("a declared cycle is rejected", () => {
  assert.throws(
    () => graphFromExecutionPlan(plan([
      { ...write("a", "a.js"), dependsOn: ["b"] },
      { ...write("b", "b.js"), dependsOn: ["a"] }
    ])),
    /dependency cycle/
  );
});

test("a duplicate step id is rejected", () => {
  assert.throws(
    () => graphFromExecutionPlan(plan([write("a", "a.js"), write("a", "b.js")])),
    /duplicate step id: a/
  );
});

test("retries convert to total attempts without granting an extra try", () => {
  const nodes = graphFromExecutionPlan(plan([
    { ...command("none", "npm", ["test"]), retries: 0 },
    { ...command("two", "npm", ["test"]), retries: 2 },
    { ...command("unset", "npm", ["test"]) }
  ]));

  assert.equal(byKey(nodes, "none").maxAttempts, 1, "retries:0 means one attempt total");
  assert.equal(byKey(nodes, "two").maxAttempts, 3);
  assert.equal(byKey(nodes, "unset").maxAttempts, 1);
});

test("an unknown step kind is treated as a barrier, not parallelised", () => {
  const nodes = graphFromExecutionPlan(plan([
    write("a", "a.js"),
    { id: "mystery", kind: "something_new" }
  ]));

  assert.deepEqual(byKey(nodes, "mystery").dependsOn, ["a"]);
});

test("a game plan uses the game barriers", () => {
  const nodes = graphFromExecutionPlan({
    id: "g", version: 1, engine: "godot",
    steps: [
      { id: "init", kind: GAME_STEP_KINDS.PROJECT_INIT, engine: "godot" },
      { id: "asset-a", kind: GAME_STEP_KINDS.ASSET_WRITE, path: "assets/a.png", content: "x" },
      { id: "asset-b", kind: GAME_STEP_KINDS.ASSET_WRITE, path: "assets/b.png", content: "x" },
      { id: "playtest", kind: GAME_STEP_KINDS.PLAYTEST, checks: [] }
    ]
  }, { taskType: "game" });

  assert.deepEqual(byKey(nodes, "asset-a").dependsOn, ["init"]);
  assert.deepEqual(byKey(nodes, "asset-b").dependsOn, ["init"], "two assets are independent");
  assert.deepEqual(byKey(nodes, "playtest").dependsOn.sort(), ["asset-a", "asset-b", "init"]);
});

// ── Tool scopes ──────────────────────────────────────────────────────────────

test("each step kind gets only the scopes its own work needs", () => {
  assert.deepEqual(scopesForStep(write("a", "x.js")), ["filesystem:workspace:write"]);
  assert.deepEqual(scopesForStep(command("c", "npm", ["test"])),
    ["shell:process:execute", "filesystem:workspace:read"]);
  // git is named as git, so a node that only inits a repo carries no shell.
  assert.deepEqual(scopesForStep(command("g", "git", ["init"])), ["git:git:read", "git:git:write"]);
  assert.ok(!scopesForStep(command("g", "git", ["init"])).some(s => s.startsWith("shell:")));
});

test("a scope with a colon inside it parses correctly", () => {
  assert.deepEqual(parseToolScope("filesystem:workspace:write"),
    { toolKey: "filesystem", scope: "workspace:write" });
  assert.throws(() => parseToolScope("nocolon"), /Malformed tool scope/);
  assert.throws(() => parseToolScope("trailing:"), /Malformed tool scope/);
});

test("a node may not reach a tool it did not declare", () => {
  const node = { toolScopes: ["filesystem:workspace:write"] };

  assert.equal(checkNodeToolScope(node, "filesystem", ["workspace:write"]).allowed, true);
  const denied = checkNodeToolScope(node, "shell", ["process:execute"]);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /does not use the shell tool/);
});

test("a node may not reach a wider scope on a tool it did declare", () => {
  const node = { toolScopes: ["filesystem:workspace:read"] };
  const denied = checkNodeToolScope(node, "filesystem", ["workspace:read", "workspace:write"]);
  assert.equal(denied.allowed, false);
  assert.deepEqual(denied.missing, ["workspace:write"]);
});

test("absent scopes narrow nothing; an empty list forbids everything", () => {
  assert.equal(checkNodeToolScope({}, "shell", ["process:execute"]).allowed, true);
  assert.equal(checkNodeToolScope({ toolScopes: null }, "shell", ["process:execute"]).allowed, true);
  assert.equal(checkNodeToolScope({ toolScopes: [] }, "shell", ["process:execute"]).allowed, false);
});

// ── Budget distribution ──────────────────────────────────────────────────────

test("budget goes to the steps that actually spend, and the parts sum to the whole", () => {
  const nodes = graphFromExecutionPlan(plan([
    write("a", "a.js"),
    write("b", "b.js"),
    command("test", "npm", ["test"]),
    command("build", "npm", ["run", "build"]),
    { id: "pack", kind: APP_WEB_STEP_KINDS.PACKAGE }
  ]));

  distributeBudgetMinor(nodes, 1000);

  assert.equal(byKey(nodes, "a").budgetMinor, 0, "a local file write costs nothing");
  assert.equal(byKey(nodes, "b").budgetMinor, 0);

  const spenders = ["test", "build", "pack"].map(k => byKey(nodes, k).budgetMinor);
  assert.equal(spenders.reduce((a, b) => a + b, 0), 1000, "no minor unit is lost to rounding");
});

test("a remainder that does not divide evenly is still fully assigned", () => {
  const nodes = graphFromExecutionPlan(plan([
    command("one", "npm", ["test"]),
    command("two", "npm", ["test"]),
    command("three", "npm", ["test"])
  ]));

  distributeBudgetMinor(nodes, 100);
  const total = nodes.reduce((sum, node) => sum + node.budgetMinor, 0);
  assert.equal(total, 100);
  assert.equal(byKey(nodes, "three").budgetMinor, 34, "the remainder lands on the last node");
});

test("a plan with no spending steps still distributes rather than dropping the budget", () => {
  const nodes = graphFromExecutionPlan(plan([write("a", "a.js"), write("b", "b.js")]));
  distributeBudgetMinor(nodes, 50);
  assert.equal(nodes.reduce((sum, node) => sum + node.budgetMinor, 0), 50);
});

test("a zero budget assigns nothing", () => {
  const nodes = graphFromExecutionPlan(plan([command("test", "npm", ["test"])]));
  distributeBudgetMinor(nodes, 0);
  assert.equal(byKey(nodes, "test").budgetMinor, 0);
});
