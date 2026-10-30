import type { SOURCE_ACQUISITION, SOURCE_AUTHORSHIP, SOURCE_OWNERSHIP_STATES } from './source.schema';
import { type SourceKind } from './source.schema';

type Acquisition = (typeof SOURCE_ACQUISITION)[number];

/**
 * Per-kind source policy (context doc §5.1). Decides authorship, which acquisition modes a kind
 * may use, what identifies the external source, and initial ownership. LinkedIn is import-only
 * (PL-11): its only acquisition is `upload`.
 */
export interface SourceKindPolicy {
  authorship: (typeof SOURCE_AUTHORSHIP)[number];
  acquisitions: readonly Acquisition[];
  /** What identifies the external source when fetched: a URL, a GitHub handle, or nothing. */
  reference: 'none' | 'url' | 'github_handle';
  /** Ownership when acquisition is `fetch` (a stated URL/handle is a claim until confirmed). */
  fetchedOwnership: (typeof SOURCE_OWNERSHIP_STATES)[number];
  /** Media types an `upload` of this kind may carry (checked against the bytes, R-3). */
  uploadMimeTypes: readonly UploadMimeType[];
}

/** Every media type Professional accepts as an upload (declared type, verified by signature). */
export const UPLOAD_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
  'application/zip',
  'image/png',
  'image/jpeg',
] as const;
export type UploadMimeType = (typeof UPLOAD_MIME_TYPES)[number];

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOCUMENTS: readonly UploadMimeType[] = [
  'application/pdf',
  DOCX,
  'text/plain',
  'text/markdown',
  'text/html',
];

export const SOURCE_KIND_POLICIES: Readonly<Record<SourceKind, Readonly<SourceKindPolicy>>> = Object.freeze({
  manual_input: {
    authorship: 'subject',
    acquisitions: ['structured_input'],
    reference: 'none',
    fetchedOwnership: 'intrinsic',
    uploadMimeTypes: [],
  },
  questionnaire: {
    authorship: 'subject',
    acquisitions: ['structured_input'],
    reference: 'none',
    fetchedOwnership: 'intrinsic',
    uploadMimeTypes: [],
  },
  cv: {
    authorship: 'subject',
    acquisitions: ['upload'],
    reference: 'none',
    fetchedOwnership: 'intrinsic',
    uploadMimeTypes: ['application/pdf', DOCX, 'text/plain', 'text/markdown'],
  },
  linkedin_export: {
    authorship: 'subject',
    acquisitions: ['upload'],
    reference: 'none',
    fetchedOwnership: 'intrinsic',
    uploadMimeTypes: ['application/zip', 'text/csv'],
  },
  github: {
    authorship: 'platform',
    acquisitions: ['fetch'],
    reference: 'github_handle',
    fetchedOwnership: 'claimed',
    uploadMimeTypes: [],
  },
  portfolio: {
    authorship: 'subject',
    acquisitions: ['upload', 'fetch'],
    reference: 'url',
    fetchedOwnership: 'claimed',
    uploadMimeTypes: DOCUMENTS,
  },
  personal_website: {
    authorship: 'subject',
    acquisitions: ['fetch'],
    reference: 'url',
    fetchedOwnership: 'claimed',
    uploadMimeTypes: [],
  },
  case_study: {
    authorship: 'subject',
    acquisitions: ['upload'],
    reference: 'none',
    fetchedOwnership: 'intrinsic',
    uploadMimeTypes: DOCUMENTS,
  },
  certificate: {
    authorship: 'issuer',
    acquisitions: ['upload'],
    reference: 'none',
    fetchedOwnership: 'intrinsic',
    uploadMimeTypes: ['application/pdf', 'image/png', 'image/jpeg'],
  },
  uploaded_document: {
    authorship: 'other',
    acquisitions: ['upload'],
    reference: 'none',
    fetchedOwnership: 'intrinsic',
    uploadMimeTypes: DOCUMENTS,
  },
});

/** GitHub's handle rule: alphanumerics and single inner hyphens, ≤ 39 characters. */
export const GITHUB_HANDLE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
export const GITHUB_API_HOST = 'api.github.com';

/**
 * Normalized URL used as the idempotency reference of a fetched source: lower-case scheme and
 * host (WHATWG), default port and fragment dropped, trailing slash of a non-root path dropped.
 */
export function normalizeSourceUrl(url: string): string {
  const u = new URL(url);
  u.hash = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.href;
}
