import type { ImportActionResult } from '@/lib/import-actions';
import { problemText } from '@/lib/import-problems';
import s from './imports.module.css';

const TITLES = {
  input: 'Check the form',
  source: 'The list could not be saved',
  upload: 'The file was not imported',
} as const;

/** A failed import attempt: what failed, the server's problems in plain words, and the request id. */
export function ImportError({
  failure,
  uploadedHeader,
}: {
  failure: Extract<ImportActionResult, { ok: false }>;
  /** Header of the uploaded (reduced) file, to name a column the server gives by position. */
  uploadedHeader?: readonly string[];
}) {
  return (
    <div className={s.error} role="alert">
      <p>
        <strong>{TITLES[failure.stage]}.</strong>{' '}
        {failure.problems.length ? 'The server found these problems:' : failure.message}
      </p>
      {failure.problems.length ? (
        <ul className={s.problems}>
          {failure.problems.map((p, i) => (
            <li key={i}>{problemText(p, uploadedHeader)}</li>
          ))}
        </ul>
      ) : null}
      {failure.createdSourceId ? <p>The new list was created. Try again to upload into it.</p> : null}
      <p className="small">
        <code>{failure.code}</code>
        {failure.requestId ? <> · request {failure.requestId}</> : null}
      </p>
    </div>
  );
}
