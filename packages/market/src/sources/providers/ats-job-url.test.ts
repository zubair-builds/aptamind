import { describe, expect, it } from 'vitest';
import { urlHasContactValue } from './directory-values';

/** OPS-5: ATS job links keep their posting id; phone-shaped values are still refused. */
describe('ATS job URL contact guard', () => {
  it('accepts posting ids on ATS job hosts', () => {
    for (const u of [
      'https://job-boards.greenhouse.io/acme/jobs/4012345001',
      'https://boards.greenhouse.io/acme/jobs/5123456789?gh_src=abc',
      'https://jobs.lever.co/acme/1b2c3d4e-1234-4abc-9def-0123456789ab',
      'https://jobs.ashbyhq.com/acme/12345678-1234-4123-8123-123456789012/application',
    ])
      expect(urlHasContactValue(u, { atsJobIds: true }), u).toBe(false);
  });
  it('company-file URL cells keep the strict rule', () => {
    expect(urlHasContactValue('https://boards.greenhouse.io/acme/jobs/4012345678')).toBe(true);
  });
  it('still refuses phone-shaped and contact values', () => {
    for (const u of [
      'https://job-boards.greenhouse.io/acme/jobs/07700900123',
      'https://job-boards.greenhouse.io/acme/jobs/7700900123',
      'https://job-boards.greenhouse.io/acme/call/4012345001',
      'https://job-boards.greenhouse.io/jane@acme.com/jobs/4012345001',
      'https://example.com/acme/jobs/4012345001',
      'https://jobs.lever.co/acme/1b2c3d4e-1234-4abc-9def-0123456789ab/07700-900123',
    ])
      expect(urlHasContactValue(u, { atsJobIds: true }), u).toBe(true);
  });
});
