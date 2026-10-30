import { z } from 'zod';
import { contentHash } from '@aptamind/contracts';

/**
 * Provider-neutral AI gateway.
 *
 * Domain code depends only on `AiGateway`. Every call:
 *  - requests schema-constrained structured output;
 *  - validates the result against the caller's Zod schema (never trusted blindly);
 *  - returns provenance metadata (provider, model, prompt/template version, schema version,
 *    input references, latency, token usage, estimated cost) to be stored alongside any
 *    derived data.
 *
 * AI output is a *proposal*. It never writes canonical truth; domain policy and
 * reconciliation decide what, if anything, becomes canonical.
 */

export interface PromptTemplate {
  id: string;
  version: string;
  system: string;
  /** Renders the user message from the input variables. */
  render(vars: Record<string, string>): string;
}

export function definePrompt(t: PromptTemplate): PromptTemplate {
  return t;
}

export interface AiInputRef {
  kind: 'artifact' | 'observation' | 'entity' | 'text';
  id: string;
}

export interface StructuredExtractRequest<T> {
  /** Stable task name used in metrics, e.g. `market.job.requirements`. */
  task: string;
  prompt: PromptTemplate;
  vars: Record<string, string>;
  schema: z.ZodType<T>;
  schemaVersion: string;
  inputRefs: AiInputRef[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface AiCallMeta {
  provider: string;
  model: string;
  /** Model that actually served the request (may differ if a server-side fallback ran). */
  servedByModel: string;
  promptId: string;
  promptVersion: string;
  schemaVersion: string;
  inputRefs: AiInputRef[];
  inputHash: string;
  latencyMs: number;
  usage: { inputTokens: number | null; outputTokens: number | null };
  estimatedCostUsd: number | null;
  requestId: string | null;
  generatedAt: Date;
}

export interface AiResult<T> {
  data: T;
  meta: AiCallMeta;
}

export interface AiGateway {
  readonly provider: string;
  readonly available: boolean;
  structuredExtract<T>(req: StructuredExtractRequest<T>): Promise<AiResult<T>>;
}

/** Low-level provider contract implemented per vendor. */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  generateJson(req: {
    system: string;
    user: string;
    jsonSchema: Record<string, unknown>;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    servedByModel: string;
    inputTokens: number | null;
    outputTokens: number | null;
    requestId: string | null;
  }>;
}

export class AiUnavailableError extends Error {
  readonly retryable = false;
  readonly code = 'unavailable';
  constructor(message = 'No AI provider is configured (AI_PROVIDER=none)') {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

export class AiRefusalError extends Error {
  readonly retryable = false;
  constructor(public readonly category: string | null) {
    super(`Model declined the request${category ? ` (${category})` : ''}`);
    this.name = 'AiRefusalError';
  }
}

export class AiOutputValidationError extends Error {
  /** A second sample may well validate, so allow one bounded retry. */
  readonly retryable = true;
  constructor(
    public readonly issues: string[],
    public readonly rawPreview: string,
  ) {
    super(`AI output failed schema validation: ${issues.join('; ')}`);
    this.name = 'AiOutputValidationError';
  }
}

/** Approximate list prices (USD per 1M tokens) for cost metadata. */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
};

export function estimateCostUsd(
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  const p = PRICING[model];
  if (!p || inputTokens === null || outputTokens === null) return null;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export interface AiCallObserver {
  onCall(task: string, meta: AiCallMeta, outcome: 'ok' | 'error', error?: unknown): void;
}

export class DefaultAiGateway implements AiGateway {
  constructor(
    private readonly providerImpl: AiProvider | null,
    private readonly observer?: AiCallObserver,
  ) {}

  get provider(): string {
    return this.providerImpl?.name ?? 'none';
  }

  get available(): boolean {
    return this.providerImpl !== null;
  }

  async structuredExtract<T>(req: StructuredExtractRequest<T>): Promise<AiResult<T>> {
    if (!this.providerImpl) throw new AiUnavailableError();
    const user = req.prompt.render(req.vars);
    const jsonSchema = z.toJSONSchema(req.schema, { target: 'draft-2020-12' }) as Record<string, unknown>;
    const started = Date.now();
    const baseMeta = {
      provider: this.providerImpl.name,
      model: this.providerImpl.model,
      promptId: req.prompt.id,
      promptVersion: req.prompt.version,
      schemaVersion: req.schemaVersion,
      inputRefs: req.inputRefs,
      inputHash: contentHash({ system: req.prompt.system, user }),
    };
    try {
      const res = await this.providerImpl.generateJson({
        system: req.prompt.system,
        user,
        jsonSchema,
        maxTokens: req.maxTokens ?? 16_000,
        signal: req.signal,
      });
      const meta: AiCallMeta = {
        ...baseMeta,
        servedByModel: res.servedByModel,
        latencyMs: Date.now() - started,
        usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens },
        estimatedCostUsd: estimateCostUsd(res.servedByModel, res.inputTokens, res.outputTokens),
        requestId: res.requestId,
        generatedAt: new Date(),
      };
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(res.text);
      } catch {
        throw new AiOutputValidationError(['output is not valid JSON'], res.text.slice(0, 500));
      }
      const parsed = req.schema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new AiOutputValidationError(
          parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
          res.text.slice(0, 500),
        );
      }
      this.observer?.onCall(req.task, meta, 'ok');
      return { data: parsed.data, meta };
    } catch (err) {
      this.observer?.onCall(
        req.task,
        {
          ...baseMeta,
          servedByModel: this.providerImpl.model,
          latencyMs: Date.now() - started,
          usage: { inputTokens: null, outputTokens: null },
          estimatedCostUsd: null,
          requestId: null,
          generatedAt: new Date(),
        },
        'error',
        err,
      );
      throw err;
    }
  }
}
