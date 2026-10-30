import Anthropic from '@anthropic-ai/sdk';
import { AiProviderError, AiRefusalError, type AiProvider } from './gateway';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /**
   * Server-side refusal fallbacks (`fallbacks: "default"`): if the primary model declines,
   * the API re-runs the request on a fallback model within the same call. The model that
   * actually served the response is recorded as `servedByModel`.
   */
  serverSideFallbacks?: boolean;
}

/** Claude implementation of the provider contract (structured outputs via `output_config.format`). */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly fallbacks: boolean;

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model;
    // SDK-level retries are disabled: retries are owned by the workflow runtime so every
    // attempt is visible in node-run history.
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: 0 });
    this.fallbacks = opts.serverSideFallbacks ?? true;
  }

  async generateJson(req: {
    system: string;
    user: string;
    jsonSchema: Record<string, unknown>;
    maxTokens: number;
    signal?: AbortSignal;
  }) {
    try {
      const response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          output_config: { format: { type: 'json_schema', schema: req.jsonSchema } },
          ...(this.fallbacks
            ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
            : {}),
        },
        { signal: req.signal },
      );
      if (response.stop_reason === 'refusal') {
        throw new AiRefusalError(response.stop_details?.category ?? null);
      }
      if (response.stop_reason === 'max_tokens') {
        throw new AiProviderError('Structured output truncated at max_tokens', false);
      }
      const text = response.content
        .filter((b): b is Extract<(typeof response.content)[number], { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return {
        text,
        servedByModel: response.model,
        inputTokens: response.usage.input_tokens ?? null,
        outputTokens: response.usage.output_tokens ?? null,
        requestId: (response as { _request_id?: string | null })._request_id ?? null,
      };
    } catch (err) {
      if (err instanceof AiRefusalError || err instanceof AiProviderError) throw err;
      if (err instanceof Anthropic.RateLimitError)
        throw new AiProviderError('Rate limited by provider', true, 429);
      if (err instanceof Anthropic.AuthenticationError)
        throw new AiProviderError('Provider authentication failed', false, 401);
      if (err instanceof Anthropic.BadRequestError)
        throw new AiProviderError(`Bad request: ${err.message}`, false, 400);
      if (err instanceof Anthropic.APIConnectionError)
        throw new AiProviderError('Provider connection failed', true);
      if (err instanceof Anthropic.APIError) {
        const status = err.status ?? 0;
        throw new AiProviderError(
          `Provider error ${status}`,
          status >= 500 || status === 408 || status === 409,
          status,
        );
      }
      throw err;
    }
  }
}
