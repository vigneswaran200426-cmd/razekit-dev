export class EchoToolAdapter {
  async execute({ tool, input, credential }) {
    return {
      tool: tool.key,
      input,
      credentialRef: credential?.secretRef || null
    };
  }
}
