import { z } from 'zod';
import { definePrompt } from '@aptamind/ai';
import type { AiTaskDefinition } from '@aptamind/workflow-nodes';

/**
 * Versioned AI extraction tasks owned by the Market domain. Outputs are proposals that are
 * schema-validated and never written to canonical state without domain policy.
 */

export const jobPostingExtractSchema = z.object({
  isJobPosting: z.boolean(),
  title: z.string().nullable(),
  companyName: z.string().nullable(),
  locations: z.array(z.string()),
  employmentType: z.string().nullable(),
  salaryText: z.string().nullable().describe('Verbatim salary text if stated, else null. Never estimate.'),
  applyUrl: z.string().nullable(),
});

export const JOB_POSTING_EXTRACT_PROMPT = definePrompt({
  id: 'market.job_posting_extract',
  version: '1',
  system:
    'You extract facts from a single web page that may be a job posting. Report only what the page states. ' +
    'Use null when a field is not stated. Copy salary text verbatim; never estimate or convert. ' +
    'If the page is not a single job posting (e.g. a listing page or a blog post), set isJobPosting to false.',
  render: (v) => `Page URL: ${v.url ?? ''}\n\nPage text:\n${v.text ?? ''}`,
});

export const jobRequirementsProposalSchema = z.object({
  requirements: z.array(
    z.object({
      text: z.string().describe('Verbatim requirement text from the posting'),
      importance: z.enum(['critical', 'important', 'preferred', 'incidental']),
      category: z.enum([
        'skill',
        'experience',
        'education',
        'certification',
        'language',
        'authorization',
        'location',
        'soft_skill',
        'other',
      ]),
    }),
  ),
});

export const JOB_REQUIREMENTS_PROMPT = definePrompt({
  id: 'market.job_requirements_proposal',
  version: '1',
  system:
    'You list the candidate requirements stated in a job description. Quote each requirement verbatim. ' +
    'critical = explicitly required/must-have; important = listed as a requirement without must-have language; ' +
    'preferred = nice-to-have/bonus/preferred; incidental = mentioned in passing (e.g. tech stack description). ' +
    'Do not infer requirements that are not written.',
  render: (v) => `Job title: ${v.title ?? ''}\n\nDescription:\n${v.text ?? ''}`,
});

export const marketAiTasks: AiTaskDefinition[] = [
  {
    id: 'market.job_posting_extract',
    prompt: JOB_POSTING_EXTRACT_PROMPT,
    schema: jobPostingExtractSchema,
    schemaVersion: '1',
  },
  {
    id: 'market.job_requirements_proposal',
    prompt: JOB_REQUIREMENTS_PROMPT,
    schema: jobRequirementsProposalSchema,
    schemaVersion: '1',
  },
];
