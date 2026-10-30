import { z } from 'zod';

/**
 * Professional id prefixes (domain doc §2). All ids are prefixed and opaque; no id is ever
 * derived from a bare personal identifier (an email, name, handle or URL).
 */
export const PROFESSIONAL_ID_PREFIX = {
  subject: 'psub',
  source: 'psrc',
  snapshot: 'psnap',
  acquisition: 'pacq',
  extraction: 'pext',
  aiExtraction: 'paix',
  observation: 'pobs',
  item: 'pitm',
  assertion: 'pasr',
  profile: 'ppro',
  profileVersion: 'ppv',
  confirmationRequest: 'pcrq',
  confirmationOperation: 'pcop',
  careerTarget: 'ptgt',
  careerTargetVersion: 'ptgv',
  event: 'pevt',
  reviewItem: 'prvw',
} as const;
export type ProfessionalIdKind = keyof typeof PROFESSIONAL_ID_PREFIX;

/** An id of the given kind: `<prefix>_<opaque>`. */
export function idSchema(kind: ProfessionalIdKind) {
  return z.string().regex(new RegExp(`^${PROFESSIONAL_ID_PREFIX[kind]}_[A-Za-z0-9]+$`), {
    message: `not a ${kind} id`,
  });
}
