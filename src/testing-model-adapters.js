// Deterministic stand-ins for Fable and Astra.
//
// These are not placeholders for the real adapters — they are how CI and local
// development exercise the entire autonomous loop with no network, no API key
// and no bill. They return the same response *shape* the production adapters
// return, including a genuinely runnable execution plan, so a task driven by
// these adapters really does write files, run tests, build and package. The
// only thing that is fake is the reasoning.

const PACKAGE_JSON = JSON.stringify(
  {
    name: "razekit-dev-deterministic-build",
    version: "1.0.0",
    private: true,
    scripts: {
      test: "node --test",
      build: "node build.mjs"
    }
  },
  null,
  2
);

const BUILD_SCRIPT = `import { mkdir, copyFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await copyFile("index.html", "dist/index.html");
console.log("build ok");
`;

const SMOKE_TEST = `import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

test("the page renders its landmarks", async () => {
  const html = await readFile("index.html", "utf8");
  assert.ok(html.includes("<nav"), "expected a navigation landmark");
  assert.ok(html.includes("<main"), "expected a main landmark");
  assert.ok(html.includes("<footer"), "expected a footer landmark");
});
`;

function indexHtml(title) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body>
    <nav><a href="#hero">Home</a></nav>
    <main>
      <section id="hero"><h1>${title}</h1><a href="#cta">Get started</a></section>
      <section id="cta"><h2>Ready when you are</h2></section>
    </main>
    <footer><p>Built by RazeKit DEV.</p></footer>
  </body>
</html>
`;
}

export class DeterministicFableAdapter {
  async generate(request) {
    const title = request.context?.task?.title || "RazeKit build";

    return {
      output: "Fable implementation pass for " + title,
      implementation: {
        status: "implemented",
        summary: "Wrote the page, a build script and a test, then packaged it.",
        filesChanged: 4
      },
      plan: {
        id: "deterministic-fable-plan",
        version: 1,
        steps: [
          {
            id: "repo-init",
            kind: "command",
            phase: "repository",
            executable: "git",
            args: ["init"],
            retries: 1,
            timeoutMs: 30000
          },
          {
            id: "write-package-json",
            kind: "workspace_write_file",
            phase: "implementation",
            path: "package.json",
            content: PACKAGE_JSON
          },
          {
            id: "write-index",
            kind: "workspace_write_file",
            phase: "implementation",
            path: "index.html",
            content: indexHtml(title)
          },
          {
            id: "write-build",
            kind: "workspace_write_file",
            phase: "implementation",
            path: "build.mjs",
            content: BUILD_SCRIPT
          },
          {
            id: "write-test",
            kind: "workspace_write_file",
            phase: "test",
            path: "test/page.test.mjs",
            content: SMOKE_TEST
          },
          {
            id: "run-tests",
            kind: "command",
            phase: "test",
            executable: "npm",
            args: ["test"],
            retries: 1,
            timeoutMs: 120000
          },
          {
            id: "run-build",
            kind: "command",
            phase: "build",
            executable: "npm",
            args: ["run", "build"],
            retries: 1,
            timeoutMs: 120000
          },
          {
            id: "package",
            kind: "package",
            phase: "package",
            outputDir: "artifacts",
            retries: 1,
            timeoutMs: 120000
          }
        ]
      },
      usage: {
        inputTokens: 100,
        outputTokens: 80,
        cost: 0.02
      }
    };
  }
}

export class DeterministicAstraAdapter {
  async generate(request) {
    if (request.role === "planner") {
      return {
        output: "Astra planning pass",
        architecture: {
          summary: "A single static page with a build step and a smoke test.",
          steps: [
            { id: "implement-1", kind: "implementation", description: "Build the page and its tooling" },
            { id: "review-1", kind: "review", description: "Review the implementation against the criteria" }
          ],
          files: [
            { path: "index.html", purpose: "The page itself" },
            { path: "build.mjs", purpose: "Emits dist/" }
          ],
          acceptanceCriteria: ["Tests pass", "Build produces dist/index.html"],
          risks: []
        },
        usage: {
          inputTokens: 120,
          outputTokens: 90,
          cost: 0.03
        }
      };
    }

    // The reviewer passes only when the execution evidence says the run
    // completed — the same bar the real Astra prompt sets. A deterministic
    // adapter that always passed would make the review stage decorative.
    const execution = request.context?.blackboard?.find?.(
      entry => entry.key === "execution.lastResult"
    );
    const completed = execution?.value?.status === "completed";

    return {
      output: completed ? "Astra review pass" : "Astra review: execution has not succeeded yet",
      review: completed
        ? { decision: "pass", reason: "Execution completed with every step passed.", findings: [] }
        : {
            decision: "revise",
            reason: "The execution plan has not completed successfully.",
            findings: [{ severity: "high", detail: execution?.value?.error || "No successful execution run recorded." }]
          },
      usage: {
        inputTokens: 140,
        outputTokens: 70,
        cost: 0.035
      }
    };
  }
}
