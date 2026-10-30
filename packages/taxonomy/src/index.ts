/**
 * @aptamind/taxonomy — versioned, dependency-free vocabularies (context doc §21).
 *
 * Every derived intelligence record stores `TAXONOMY_VERSION` so interpretations can be
 * recomputed and compared when the vocabularies change. Bump it on any data or rule change.
 */
export const TAXONOMY_VERSION = '2026-09-27.1';

export * from './text';
export * from './geo/countries';
export * from './geo/places';
export * from './geo/regions';
export * from './geo/match';
export * from './timezones';
export * from './currencies';
export * from './roles';
export * from './employment';
export * from './skills';
