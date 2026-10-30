import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="panel">
      <h1 className="panel-title">Page not found</h1>
      <p>
        <Link href="/">Back to the dashboard</Link>
      </p>
    </div>
  );
}
