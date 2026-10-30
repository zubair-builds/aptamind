import { ErrorState } from '@/components/ui/ErrorState';
import type { ApiFailure } from '@/lib/api';
import { API_BASE_URL } from '@/lib/api';

/** Error panel for a failed API call — never crashes the page. */
export function ApiErrorPanel({ error, title }: { error: ApiFailure; title?: string }) {
  if (error.kind === 'unavailable') {
    return (
      <ErrorState
        title="API unavailable"
        message={
          <>
            The admin could not reach the internal API at <code>{API_BASE_URL}</code>. Check that the Next.js
            server is running.
          </>
        }
        meta={`${error.method} ${error.path} — ${error.message}`}
      />
    );
  }
  let details: string | undefined;
  if (error.details !== undefined) {
    try {
      details = JSON.stringify(error.details, null, 2);
    } catch {
      details = String(error.details);
    }
  }
  return (
    <ErrorState
      title={title ?? (error.status === 404 ? 'Not found' : 'API error')}
      message={
        <>
          <code>{error.code}</code>
          {error.status ? <> (HTTP {error.status})</> : null}: {error.message}
        </>
      }
      meta={
        <>
          {error.method} {error.path}
          {error.requestId ? <> — request {error.requestId}</> : null}
        </>
      }
      details={details}
      retry={!error.status || error.status >= 500}
    />
  );
}
