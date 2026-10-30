import type { AiProvider } from './gateway';

/**
 * Deterministic provider for tests, golden evaluations and credential-less development.
 * Responses are produced by a handler keyed on the rendered prompt, so fixtures are
 * reproducible and never touch the network.
 */
export class FixtureAiProvider implements AiProvider {
  readonly name = 'fixture';
  readonly calls: Array<{ system: string; user: string }> = [];

  constructor(
    private readonly handler: (req: {
      system: string;
      user: string;
      jsonSchema: Record<string, unknown>;
    }) => unknown,
    readonly model = 'fixture-model-v1',
  ) {}

  async generateJson(req: {
    system: string;
    user: string;
    jsonSchema: Record<string, unknown>;
    maxTokens: number;
  }) {
    this.calls.push({ system: req.system, user: req.user });
    const out = await this.handler(req);
    return {
      text: typeof out === 'string' ? out : JSON.stringify(out),
      servedByModel: this.model,
      inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
      outputTokens: 50,
      requestId: null,
    };
  }
}
