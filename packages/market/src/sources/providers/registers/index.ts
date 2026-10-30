import type { RegisterAdapter } from './adapter';
import { nlIndRegisterAdapter } from './nl-ind';
import { ukSponsorRegisterAdapter } from './uk';
import { usH1bEmployerDataHubAdapter } from './us-h1b';

export * from './adapter';
export * from './history-periods';
export * from './nl-ind';
export * from './uk';
export * from './us-h1b';

/**
 * The register adapters, registered as Market source providers: a source whose `provider` is an
 * adapter's `provider` is imported by `market.sponsor_register.import` with that adapter. Adding a
 * register means adding its adapter here (and its values to the enum catalog, which reads this
 * list).
 */
export const REGISTER_ADAPTERS: readonly RegisterAdapter[] = [
  ukSponsorRegisterAdapter,
  nlIndRegisterAdapter,
  usH1bEmployerDataHubAdapter,
];

export const REGISTER_IDS = REGISTER_ADAPTERS.map((a) => a.id);
export const REGISTER_PROVIDERS = REGISTER_ADAPTERS.map((a) => a.provider);

export function registerAdapterForProvider(provider: string): RegisterAdapter | null {
  const p = provider.trim().toLowerCase();
  return REGISTER_ADAPTERS.find((a) => a.provider === p) ?? null;
}

export function registerAdapterById(id: string): RegisterAdapter | null {
  return REGISTER_ADAPTERS.find((a) => a.id === id) ?? null;
}
