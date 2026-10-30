'use client';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="panel panel-bad" role="alert">
      <h1 className="panel-title">Something went wrong rendering this page</h1>
      <p>{error.message || 'Unexpected error.'}</p>
      {error.digest ? <p className="muted small">digest {error.digest}</p> : null}
      <button type="button" className="btn" onClick={() => reset()}>
        Try again
      </button>
    </div>
  );
}
