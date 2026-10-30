import { AnthropicProvider } from './anthropic-provider';
import { type AiCallObserver, type AiGateway, DefaultAiGateway } from './gateway';

export * from './gateway';
export * from './anthropic-provider';
export * from './fixture-provider';

export interface AiGatewayConfig {
  provider: 'none' | 'anthropic' | 'fixture';
  model: string;
  apiKeyEnv: string;
  timeoutMs: number;
}

/**
 * Build the process-wide gateway from configuration. Without credentials the gateway is
 * "unavailable": AI-dependent steps fail visibly (and deterministic fallbacks keep working)
 * rather than silently fabricating output.
 */
export function createAiGateway(
  cfg: AiGatewayConfig,
  env: Record<string, string | undefined> = process.env,
  observer?: AiCallObserver,
): AiGateway {
  if (cfg.provider === 'anthropic') {
    const apiKey = env[cfg.apiKeyEnv];
    if (!apiKey) return new DefaultAiGateway(null, observer);
    return new DefaultAiGateway(
      new AnthropicProvider({ apiKey, model: cfg.model, timeoutMs: cfg.timeoutMs }),
      observer,
    );
  }
  return new DefaultAiGateway(null, observer);
}
