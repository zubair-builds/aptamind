import { ApiError, FinishReason, GoogleGenAI } from '@google/genai';
import { AiProviderError, AiRefusalError, type AiProvider } from './gateway';

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** Google Gemini implementation of the provider contract (structured output via `responseJsonSchema`). */
export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';
  readonly model: string;
  private readonly client: GoogleGenAI;

  constructor(opts: GeminiProviderOptions) {
    this.model = opts.model;
    // SDK-level retries are disabled: retries are owned by the workflow runtime so every
    // attempt is visible in node-run history.
    this.client = new GoogleGenAI({
      apiKey: opts.apiKey,
      httpOptions: { timeout: opts.timeoutMs, retryOptions: { attempts: 1 } },
    });
  }

  async generateJson(req: {
    system: string;
    user: string;
    jsonSchema: Record<string, unknown>;
    maxTokens: number;
    signal?: AbortSignal;
  }) {
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: req.user,
        config: {
          systemInstruction: req.system,
          responseMimeType: 'application/json',
          responseJsonSchema: req.jsonSchema,
          maxOutputTokens: req.maxTokens,
          ...(req.signal ? { abortSignal: req.signal } : {}),
        },
      });
      const block = response.promptFeedback?.blockReason;
      if (block) throw new AiRefusalError(String(block));
      const finish = response.candidates?.[0]?.finishReason;
      if (
        finish === FinishReason.SAFETY ||
        finish === FinishReason.RECITATION ||
        finish === FinishReason.PROHIBITED_CONTENT ||
        finish === FinishReason.BLOCKLIST ||
        finish === FinishReason.SPII
      ) {
        throw new AiRefusalError(String(finish));
      }
      if (finish === FinishReason.MAX_TOKENS) {
        throw new AiProviderError('Structured output truncated at max_tokens', false);
      }
      return {
        text: response.text ?? '',
        servedByModel: response.modelVersion ?? this.model,
        inputTokens: response.usageMetadata?.promptTokenCount ?? null,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
        requestId: response.responseId ?? null,
      };
    } catch (err) {
      if (err instanceof AiRefusalError || err instanceof AiProviderError) throw err;
      if (err instanceof ApiError) {
        const status = err.status ?? 0;
        if (status === 429) throw new AiProviderError('Rate limited by provider', true, 429);
        if (status === 401 || status === 403)
          throw new AiProviderError('Provider authentication failed', false, status);
        if (status === 400) throw new AiProviderError(`Bad request: ${err.message}`, false, 400);
        throw new AiProviderError(
          `Provider error ${status}`,
          status >= 500 || status === 408 || status === 409,
          status,
        );
      }
      if (err instanceof Error && err.name === 'AbortError') throw err;
      if (err instanceof TypeError) throw new AiProviderError('Provider connection failed', true);
      throw err;
    }
  }
}
