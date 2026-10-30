'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useId, useState, useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { type ImportActionResult, startSnapshotImportAction } from '@/lib/import-actions';
import { ImportError } from './ImportError';
import s from './imports.module.css';

export interface SourceOption {
  id: string;
  name: string;
  provider: string;
}

/** Generic snapshot import: the whole file goes to the chosen source unchanged. */
export function SnapshotImportForm({
  sources,
  initialSourceId,
}: {
  sources: SourceOption[];
  initialSourceId?: string;
}) {
  const router = useRouter();
  const ids = useId();
  const [sourceId, setSourceId] = useState(
    sources.some((x) => x.id === initialSourceId) ? initialSourceId! : '',
  );
  const [file, setFile] = useState<File | null>(null);
  const [failure, setFailure] = useState<Extract<ImportActionResult, { ok: false }> | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!sourceId || !file) return;
    const fd = new FormData();
    fd.set('sourceId', sourceId);
    fd.set('file', file);
    setFailure(null);
    startTransition(async () => {
      const res = await startSnapshotImportAction(fd);
      if (res.ok) router.push(`/imports/${encodeURIComponent(res.importId)}`);
      else setFailure(res);
    });
  }

  return (
    <form className={s.wizard} onSubmit={onSubmit} aria-labelledby={`${ids}-title`}>
      <section className={s.step}>
        <h2 id={`${ids}-title`} className={s.stepTitle}>
          Upload a file to a source
        </h2>
        <p className={s.hint}>
          The file is sent as it is, and the source’s own workflow processes it. To choose which columns of a
          CSV to import, use Companies or Known ATS boards instead.
        </p>
        <div className={s.fields}>
          <label className={s.field}>
            <span>Source</span>
            <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} required>
              <option value="">Choose a source…</option>
              {sources.map((x) => (
                <option key={x.id} value={x.id}>
                  {/* Many source names already end with their provider: do not say it twice. */}
                  {x.name.toLowerCase().includes(x.provider.toLowerCase())
                    ? x.name
                    : `${x.name} (${x.provider})`}
                </option>
              ))}
            </select>
          </label>
          <label className={s.field}>
            <span>File</span>
            <input type="file" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        </div>
        {failure ? <ImportError failure={failure} /> : null}
        <div className={s.actions}>
          <Button
            type="submit"
            variant="primary"
            disabled={!sourceId || !file}
            pending={pending}
            pendingLabel="Uploading…"
          >
            Start import
          </Button>
        </div>
      </section>
    </form>
  );
}
