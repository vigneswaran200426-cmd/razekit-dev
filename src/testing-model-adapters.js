export class DeterministicFableAdapter {
  async generate(request) {
    return {
      output: "Fable implementation pass for " + request.context.task.title,
      implementation: {
        status: "implemented",
        filesChanged: 1
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
        plan: {
          steps: [
            { id: "implement-1", kind: "implementation", description: "Implement requested functionality" },
            { id: "review-1", kind: "review", description: "Review implementation against criteria" }
          ]
        },
        usage: {
          inputTokens: 120,
          outputTokens: 90,
          cost: 0.03
        }
      };
    }

    return {
      output: "Astra review pass",
      review: {
        decision: "pass",
        findings: []
      },
      usage: {
        inputTokens: 140,
        outputTokens: 70,
        cost: 0.035
      }
    };
  }
}
