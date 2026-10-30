import { z } from 'zod';
import { defineCollection } from '@aptamind/db';
import { confidenceSchema } from '@aptamind/provenance';
import { OBSERVATION_MODES } from '../contracts/basis';
import { CLAIM_TYPES, CLAIM_VALUE_SCHEMAS, type ClaimType } from '../contracts/claims';
import { actorRefSchema, codeSchema, documentMetaFields } from '../documents';
import { idSchema } from '../contracts/ids';
import { EXTRACTOR_KINDS } from '../extraction/extraction.schema';
import { professionalValidator } from '../validators';
import { normalizeClaimPayload } from './payload';

export const OBSERVATION_SCHEMA_VERSION = 1;

export const OBSERVATION_STATUSES = ['current', 'superseded', 'quarantined'] as const;
export const RESOLUTION_STATES = ['pending', 'resolved', 'skipped'] as const;

/** Extractor metadata (R-7); AI observations also carry provider/model/prompt/schema metadata. */
export const observationExtractorSchema = z.object({
  kind: z.enum(EXTRACTOR_KINDS),
  name: z.string().min(1).max(80),
  version: z.number().int().positive(),
  ai: z
    .object({
      provider: z.string().min(1),
      model: z.string().min(1),
      servedModel: z.string().min(1).optional(),
      promptId: z.string().min(1),
      promptVersion: z.string().min(1),
      schemaVersion: z.string().min(1),
      aiExtractionId: idSchema('aiExtraction'),
    })
    .optional(),
});

/**
 * One extracted statement about a subject, with verbatim evidence. Append-only: the content
 * never changes after insert; `status` and `resolution` are the only state. The id is
 * `det(snapshotId, extractor@version, claimType, locator, payloadHash)`, so re-running the same
 * extractor on the same snapshot writes nothing new (R-6). `payload` is the claim type's
 * normalized value, validated against its schema at the application boundary.
 */
export const observationDocSchema = z
  .strictObject({
    _id: idSchema('observation'),
    subjectId: idSchema('subject'),
    sourceId: idSchema('source'),
    snapshotId: idSchema('snapshot'),
    extractionId: idSchema('extraction'),
    claimType: z.enum(CLAIM_TYPES as [ClaimType, ...ClaimType[]]),
    payload: z.record(z.string(), z.unknown()),
    mode: z.enum(OBSERVATION_MODES),
    extractor: observationExtractorSchema,
    evidence: z.object({
      artifactId: z.string().regex(/^art_[A-Za-z0-9]+$/),
      /** Where in the artifact: section id + character span, CSV row, JSON pointer, form field. */
      locator: z.string().min(1).max(200),
      /** Verbatim excerpt (≤ 300 chars) for `extracted` claims. */
      quote: z.string().max(300).optional(),
      spanVerified: z.boolean(),
    }),
    confidence: confidenceSchema,
    warnings: z.array(codeSchema),
    /** Source chronology of the snapshot this came from (ADR-0019). */
    sourceAsOf: z.date(),
    status: z.enum(OBSERVATION_STATUSES),
    quarantine: z.object({ reasonCode: codeSchema, by: actorRefSchema, at: z.date() }).optional(),
    resolution: z.object({
      state: z.enum(RESOLUTION_STATES),
      itemId: idSchema('item').optional(),
      assertionId: idSchema('assertion').optional(),
      resolverVersion: z.string().min(1).optional(),
      resolvedAt: z.date().optional(),
    }),
    runId: z.string().optional(),
    ...documentMetaFields,
  })
  .superRefine((doc, ctx) => {
    const parsed = CLAIM_VALUE_SCHEMAS[doc.claimType].safeParse(doc.payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 5)) {
        // Paths and codes only: never the offending value (it may be personal data).
        ctx.addIssue({ code: 'custom', path: ['payload', ...issue.path], message: issue.code });
      }
    }
    // Provenance invariants (PL-7, R-7, R-9). Messages are fixed codes, never values.
    const rule = (ok: boolean, path: (string | number)[], message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path, message });
    };
    if (doc.extractor.kind === 'ai') {
      rule(doc.extractor.ai !== undefined, ['extractor', 'ai'], 'ai_metadata_required');
      rule(doc.mode !== 'stated', ['mode'], 'ai_cannot_state');
    }
    if (doc.mode === 'extracted') {
      rule(doc.evidence.spanVerified, ['evidence', 'spanVerified'], 'extracted_requires_verified_span');
      rule(Boolean(doc.evidence.quote), ['evidence', 'quote'], 'extracted_requires_quote');
    }
    rule(
      !(doc.claimType === 'preference.compensation' && doc.mode === 'inferred'),
      ['mode'],
      'compensation_never_inferred',
    );
    rule(
      !(doc.claimType === 'skill' && doc.payload.proficiency !== undefined && doc.mode !== 'stated'),
      ['payload', 'proficiency'],
      'proficiency_only_when_stated',
    );
  })
  // Store the normalized value (the claim schema's output), never the raw extractor output.
  .transform((doc) => ({
    ...doc,
    payload: normalizeClaimPayload(doc.claimType, doc.payload) as Record<string, unknown>,
  }));
export type ObservationDoc = z.infer<typeof observationDocSchema>;

export const observationsCollection = defineCollection<ObservationDoc>({
  name: 'professional_observations',
  description:
    'Append-only statements a source made about a subject, with extractor metadata and verbatim evidence.',
  schema: observationDocSchema,
  schemaVersion: OBSERVATION_SCHEMA_VERSION,
  validator: professionalValidator(observationDocSchema),
  indexes: [
    {
      key: { subjectId: 1, 'resolution.state': 1, createdAt: 1 },
      options: { name: 'by_subject_resolution' },
      rationale: "Resolver input: a subject's pending observations, oldest first.",
    },
    {
      key: { 'resolution.assertionId': 1, status: 1 },
      options: { name: 'by_assertion_status' },
      rationale: "An assertion's current support (basis, corroboration, withdrawal).",
    },
    {
      key: { subjectId: 1, createdAt: -1, _id: -1 },
      options: { name: 'by_subject_created' },
      rationale: "A subject's evidence, newest first (cursor pagination; source/claim-type filters).",
    },
    {
      key: { snapshotId: 1, 'extractor.name': 1, 'extractor.version': 1 },
      options: { name: 'by_snapshot_extractor' },
      rationale: 'Supersession of an older extractor version for the same snapshot only (R-10).',
    },
  ],
});
