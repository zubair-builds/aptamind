import { describe, expect, it } from 'vitest';
import { GITHUB_HANDLE_PATTERN, normalizeSourceUrl, SOURCE_KIND_POLICIES } from './policies';
import { SOURCE_KINDS } from './source.schema';

describe('source kind policies (§5.1)', () => {
  it('covers every kind; LinkedIn is upload-only (PL-11)', () => {
    expect(Object.keys(SOURCE_KIND_POLICIES).sort()).toEqual([...SOURCE_KINDS].sort());
    expect(SOURCE_KIND_POLICIES.linkedin_export.acquisitions).toEqual(['upload']);
    for (const k of SOURCE_KINDS) {
      const p = SOURCE_KIND_POLICIES[k];
      if (p.acquisitions.includes('fetch')) expect(p.reference, k).not.toBe('none');
    }
  });

  it('matches the documented authorship', () => {
    expect(SOURCE_KIND_POLICIES.github.authorship).toBe('platform');
    expect(SOURCE_KIND_POLICIES.certificate.authorship).toBe('issuer');
    expect(SOURCE_KIND_POLICIES.cv.authorship).toBe('subject');
  });

  it('normalizes stated URLs for idempotent registration', () => {
    expect(normalizeSourceUrl('HTTPS://Persona.Example:443/Work/#top')).toBe('https://persona.example/Work');
    expect(normalizeSourceUrl('https://persona.example/')).toBe('https://persona.example/');
    expect(normalizeSourceUrl('https://persona.example/a/?x=1')).toBe('https://persona.example/a?x=1');
  });

  it('accepts GitHub handles only in GitHub form', () => {
    for (const ok of ['persona', 'Persona-Alpha', 'a1', 'a'.repeat(39)])
      expect(GITHUB_HANDLE_PATTERN.test(ok), ok).toBe(true);
    for (const bad of ['-a', 'a-', 'a--b', 'a_b', 'a'.repeat(40), 'a b', '../x'])
      expect(GITHUB_HANDLE_PATTERN.test(bad), bad).toBe(false);
  });
});
