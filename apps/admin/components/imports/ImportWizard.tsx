'use client';

import { useRouter } from 'next/navigation';
import { type ChangeEvent, useId, useMemo, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { type CsvMalformedRow, type CsvReadError, type CsvRow, decodeUtf8, readCsv } from '@/lib/csv';
import { fmtBytes, fmtNum } from '@/lib/format';
import { type ImportActionResult, startMappedImportAction } from '@/lib/import-actions';
import {
  columnsConfig,
  hasIdentityColumn,
  IMPORT_KINDS,
  listNameFromFile,
  type MappedImportType,
  type Mapping,
  reduceCsv,
  sameColumns,
  suggestMapping,
  validateMapping,
} from '@/lib/import-mapping';
import { ImportError } from './ImportError';
import s from './imports.module.css';

/** An existing list of the import's provider, with its saved column map. */
export interface ListOption {
  id: string;
  name: string;
  columns: unknown;
  defaultCountry?: string;
}

interface Parsed {
  header: string[];
  headerLine: number;
  rows: CsvRow[];
  malformed: CsvMalformedRow[];
}

type ReadState =
  | { status: 'idle' }
  | { status: 'reading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; file: File; parsed: Parsed };

/** The browser holds the whole file while mapping; past this it is better split. */
const MAX_BROWSER_BYTES = 200 * 1024 * 1024;
const SAMPLE_ROWS = 20;

const READ_ERRORS: Record<CsvReadError, string> = {
  not_utf8:
    'This file is not UTF-8 text. In your spreadsheet app, save it as “CSV UTF-8 (comma delimited)” and choose it again.',
  empty: 'This file is empty.',
  no_header: 'This file has no header row.',
  malformed_header: 'The first row (the header) is not valid CSV. Check it for a stray quote mark.',
  too_many_columns: 'The header has more than 1,000 columns.',
};

const ROW_PROBLEMS: Record<CsvMalformedRow['problem'], string> = {
  stray_quote: 'a quote mark inside an unquoted value',
  text_after_quote: 'text after a closing quote',
  unterminated_quote: 'a quote that is never closed, so the rest of the file reads as this one row',
  field_count: 'a different number of values than the header',
};

const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;

export function ImportWizard({
  type,
  lists,
  listsNote,
}: {
  type: MappedImportType;
  lists: ListOption[];
  /** Shown when the list of existing lists could not load or is cut off. */
  listsNote?: string;
}) {
  const kind = IMPORT_KINDS[type];
  const router = useRouter();
  const ids = useId();
  const [read, setRead] = useState<ReadState>({ status: 'idle' });
  const [mapping, setMapping] = useState<Mapping>([]);
  const [defaultCountry, setDefaultCountry] = useState('');
  const [extraLists, setExtraLists] = useState<ListOption[]>([]);
  const allLists = useMemo(() => [...extraLists, ...lists], [extraLists, lists]);
  // Most imports add to a list that already exists, so an existing list is the default.
  const [target, setTarget] = useState<'new' | 'existing'>(lists.length ? 'existing' : 'new');
  const [listName, setListName] = useState('');
  const [listId, setListId] = useState(lists[0]?.id ?? '');
  const [failure, setFailure] = useState<Extract<ImportActionResult, { ok: false }> | null>(null);
  const [pending, startTransition] = useTransition();
  const readSeq = useRef(0);

  const parsed = read.status === 'ready' ? read.parsed : null;
  const chosenList = target === 'existing' ? allLists.find((l) => l.id === listId) : undefined;
  const issues = parsed ? validateMapping(type, parsed.header, mapping) : [];
  const columns = parsed ? columnsConfig(parsed.header, mapping) : {};
  const mappedCount = mapping.filter(Boolean).length;
  const mappingChanges =
    !!chosenList &&
    (!sameColumns(chosenList.columns, columns) ||
      (type === 'companies' && (chosenList.defaultCountry ?? '') !== defaultCountry.trim().toUpperCase()));
  const countryValid = !defaultCountry.trim() || /^[A-Za-z]{2}$/.test(defaultCountry.trim());
  const targetReady = target === 'new' ? !!listName.trim() : !!chosenList;
  const keptHeader = parsed ? parsed.header.filter((_, i) => mapping[i]) : [];
  const droppedCount = parsed ? parsed.header.length - keptHeader.length : 0;
  // Website is never identity evidence: without a domain or register id every row goes to review.
  // Not for ATS boards: validateMapping already demands a board, and a live board is identity.
  const noIdentity = !!parsed && type === 'companies' && !hasIdentityColumn(mapping);
  const canStart =
    !!parsed &&
    !parsed.malformed.length &&
    !issues.length &&
    countryValid &&
    targetReady &&
    parsed.rows.length > 0;

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const seq = ++readSeq.current;
    setFailure(null);
    if (!file) return setRead({ status: 'idle' });
    if (SPREADSHEET_NAME.test(file.name)) return setRead({ status: 'error', message: SPREADSHEET_MESSAGE });
    if (file.size > MAX_BROWSER_BYTES)
      return setRead({
        status: 'error',
        message: `This file is ${fmtBytes(file.size)}. Split it into files under ${fmtBytes(MAX_BROWSER_BYTES)}.`,
      });
    setRead({ status: 'reading' });
    let bytes: ArrayBuffer;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      if (seq === readSeq.current)
        setRead({ status: 'error', message: 'The browser could not read this file. Choose it again.' });
      return;
    }
    // A workbook renamed to .csv is still a zip file ("PK\x03\x04").
    if (isZip(bytes)) {
      if (seq === readSeq.current) setRead({ status: 'error', message: SPREADSHEET_MESSAGE });
      return;
    }
    const text = decodeUtf8(bytes);
    if (seq !== readSeq.current) return; // a newer file was chosen meanwhile
    const result = text === null ? ({ ok: false, error: 'not_utf8' } as const) : readCsv(text);
    if (!result.ok) return setRead({ status: 'error', message: READ_ERRORS[result.error] });
    setRead({ status: 'ready', file, parsed: result });
    setMapping(suggestMapping(type, result.header, chosenList?.columns));
    if (chosenList && type === 'companies') setDefaultCountry(chosenList.defaultCountry ?? '');
    setListName(listNameFromFile(file.name));
  }

  /** Prefills the mapping (and default country) from a list's saved columns. */
  function applySavedMapping(list: ListOption | undefined = chosenList) {
    if (!parsed || !list) return;
    setMapping(suggestMapping(type, parsed.header, list.columns));
    if (type === 'companies') setDefaultCountry(list.defaultCountry ?? '');
  }

  function chooseTarget(next: 'new' | 'existing', id = listId) {
    setTarget(next);
    setListId(id);
    if (next === 'existing') applySavedMapping(allLists.find((l) => l.id === id));
  }

  function start() {
    if (!parsed || read.status !== 'ready' || !canStart) return;
    const fd = new FormData();
    fd.set('type', type);
    fd.set('fileName', read.file.name);
    // Only mapped columns are in this file: the rest never leaves the browser.
    fd.set('file', new File([reduceCsv(parsed, mapping)], read.file.name, { type: 'text/csv' }));
    fd.set('columns', JSON.stringify(columns));
    fd.set('defaultCountry', type === 'companies' ? defaultCountry.trim() : '');
    fd.set('target', target);
    fd.set('sourceId', target === 'existing' ? listId : '');
    fd.set('sourceName', listName.trim());
    setFailure(null);
    startTransition(async () => {
      let res: ImportActionResult;
      try {
        res = await startMappedImportAction(fd);
      } catch {
        // The call itself failed (network, server restart). Keep every choice so a retry is one click.
        setFailure({
          ok: false,
          stage: 'upload',
          code: 'request_failed',
          message:
            'The request did not reach the server, or its answer was lost. Your choices are kept. Try again.',
          problems: [],
        });
        return;
      }
      if (res.ok) {
        router.push(`/imports/${encodeURIComponent(res.importId)}`);
        return;
      }
      setFailure(res);
      if (res.createdSourceId) {
        // The list exists now: a retry must use it, not create a second one.
        const created: ListOption = {
          id: res.createdSourceId,
          name: listName.trim(),
          columns,
          ...(defaultCountry.trim() ? { defaultCountry: defaultCountry.trim().toUpperCase() } : {}),
        };
        setExtraLists((prev) => [created, ...prev.filter((l) => l.id !== created.id)]);
        setTarget('existing');
        setListId(created.id);
      }
    });
  }

  const setField = (col: number, field: string) =>
    setMapping((prev) => prev.map((f, i) => (i === col ? field || null : f)));

  return (
    <div className={s.wizard}>
      <section className={s.step} aria-labelledby={`${ids}-file`}>
        <h2 id={`${ids}-file`} className={s.stepTitle}>
          <span className={s.stepNumber}>1</span> Choose a CSV file
        </h2>
        <p className={s.hint}>
          The file is read in your browser first. Nothing is uploaded until you start the import. Save an
          Excel sheet as "CSV UTF-8" first.
        </p>
        <label className={s.field}>
          <span>CSV file (UTF-8)</span>
          <input type="file" accept=".csv,text/csv" onChange={onFile} disabled={pending} />
        </label>
        <div role="status" aria-live="polite">
          {read.status === 'reading' ? <p className={s.hint}>Reading the file…</p> : null}
          {read.status === 'ready' ? (
            <p className={s.hint}>
              {read.file.name} · {fmtBytes(read.file.size)} · {plural(read.parsed.rows.length, 'row')} ·{' '}
              {plural(read.parsed.header.length, 'column')}
            </p>
          ) : null}
        </div>
        {read.status === 'error' ? (
          <div className={s.error} role="alert">
            <p>{read.message}</p>
          </div>
        ) : null}
        {parsed?.malformed.length ? <Malformed rows={parsed.malformed} /> : null}
        {parsed && parsed.rows.length === 0 ? (
          <p className={s.notice}>The file has a header but no rows that can be read.</p>
        ) : null}
      </section>

      {parsed ? (
        <section className={s.step} aria-labelledby={`${ids}-map`}>
          <h2 id={`${ids}-map`} className={s.stepTitle}>
            <span className={s.stepNumber}>2</span> Match columns to fields
          </h2>
          <p className={s.privacy}>
            <Icon name="info" /> Columns you don’t import never leave your browser.
          </p>
          <MappingTable type={type} parsed={parsed} mapping={mapping} onChange={setField} />
          {type === 'companies' ? (
            <div className={s.fields}>
              <label className={s.field}>
                <span>Default country (optional)</span>
                <input
                  type="text"
                  value={defaultCountry}
                  onChange={(e) => setDefaultCountry(e.target.value)}
                  maxLength={2}
                  size={4}
                  aria-describedby={`${ids}-country-hint`}
                  aria-invalid={!countryValid || undefined}
                />
              </label>
              <p id={`${ids}-country-hint`} className={s.hint}>
                A two-letter code such as GB. It fills only empty country cells.
              </p>
            </div>
          ) : null}
          {issues.length || !countryValid ? (
            <ul className={s.issues} aria-live="polite">
              {issues.map((issue, i) => (
                <li key={i}>{issue.message}</li>
              ))}
              {!countryValid ? <li>Default country must be two letters, such as GB.</li> : null}
            </ul>
          ) : null}
          {noIdentity ? <NoIdentityNotice /> : null}
          <Preview parsed={parsed} mapping={mapping} />
        </section>
      ) : null}

      {parsed ? (
        <section className={s.step} aria-labelledby={`${ids}-target`}>
          <h2 id={`${ids}-target`} className={s.stepTitle}>
            <span className={s.stepNumber}>3</span> Choose where to import
          </h2>
          <fieldset className={s.targets}>
            <legend>Import into</legend>
            <div className={s.targetRow}>
              <label className={s.radio}>
                <input
                  type="radio"
                  name={`${ids}-target`}
                  checked={target === 'new'}
                  onChange={() => chooseTarget('new')}
                />
                A new list
              </label>
              <input
                type="text"
                aria-label="Name of the new list"
                value={listName}
                onChange={(e) => setListName(e.target.value)}
                disabled={target !== 'new'}
                maxLength={200}
              />
            </div>
            <div className={s.targetRow}>
              <label className={s.radio}>
                <input
                  type="radio"
                  name={`${ids}-target`}
                  checked={target === 'existing'}
                  onChange={() => chooseTarget('existing')}
                  disabled={!allLists.length}
                />
                An existing list
              </label>
              <select
                aria-label={`Existing ${kind.label.toLowerCase()} list`}
                value={listId}
                onChange={(e) => chooseTarget('existing', e.target.value)}
                disabled={target !== 'existing' || !allLists.length}
              >
                {allLists.length ? null : <option value="">No lists yet</option>}
                {allLists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              {chosenList ? (
                <Button size="sm" variant="ghost" onClick={() => applySavedMapping()}>
                  Use this list’s saved mapping
                </Button>
              ) : null}
            </div>
          </fieldset>
          {listsNote ? <p className={s.hint}>{listsNote}</p> : null}
          {mappingChanges ? (
            <p className={s.notice}>
              This list maps columns differently. Starting the import saves this mapping on the list.
            </p>
          ) : null}
        </section>
      ) : null}

      {parsed ? (
        <section className={s.step} aria-labelledby={`${ids}-start`}>
          <h2 id={`${ids}-start`} className={s.stepTitle}>
            <span className={s.stepNumber}>4</span> Start the import
          </h2>
          <p className={s.summary}>
            {plural(parsed.rows.length, 'row')} will be uploaded with {plural(mappedCount, 'column')}
            {mappedCount ? ` (${keptHeader.join(', ')})` : ''}.{' '}
            {droppedCount
              ? `${plural(droppedCount, 'column')} ${droppedCount === 1 ? 'stays' : 'stay'} in your browser.`
              : 'Every column is imported.'}
          </p>
          {noIdentity ? <NoIdentityNotice /> : null}
          {failure ? <ImportError failure={failure} uploadedHeader={keptHeader} /> : null}
          <div className={s.actions}>
            <Button
              variant="primary"
              onClick={start}
              disabled={!canStart}
              pending={pending}
              pendingLabel="Uploading…"
            >
              Start import
            </Button>
            {!canStart && !pending ? <span className={s.hint}>Fix the items above to start.</span> : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

const SPREADSHEET_NAME = /\.(xlsx|xlsm|xls|ods|numbers)$/i;
const SPREADSHEET_MESSAGE =
  'This is a spreadsheet file, not a CSV file. Open it in Excel or Google Sheets, save the sheet as "CSV UTF-8", and choose the CSV file here.';

function isZip(bytes: ArrayBuffer): boolean {
  const b = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  return b.length === 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/** Shown before Start when no column can identify a company. */
function NoIdentityNotice() {
  return (
    <p className={s.notice}>
      No Domain or register id column is mapped. Website and name alone do not identify a company, so every
      row will go to review instead of creating companies.
    </p>
  );
}

/** Unreadable rows block the import: the server would count them as failed rows. */
function Malformed({ rows }: { rows: CsvMalformedRow[] }) {
  const shown = rows.slice(0, 10);
  return (
    <div className={s.error} role="alert">
      <p>
        {plural(rows.length, 'row')} cannot be read. Fix {rows.length === 1 ? 'it' : 'them'} in the file and
        choose it again:
      </p>
      <ul className={s.problems}>
        {shown.map((r) => (
          <li key={r.line}>
            Line {fmtNum(r.line)}: {ROW_PROBLEMS[r.problem]}
          </li>
        ))}
        {rows.length > shown.length ? <li>and {plural(rows.length - shown.length, 'more row')}</li> : null}
      </ul>
    </div>
  );
}

function samples(parsed: Parsed, col: number): string {
  const out: string[] = [];
  for (const row of parsed.rows) {
    const v = row.fields[col]?.trim();
    if (v) out.push(v);
    if (out.length === 3) break;
  }
  return out.join(' · ');
}

function MappingTable({
  type,
  parsed,
  mapping,
  onChange,
}: {
  type: MappedImportType;
  parsed: Parsed;
  mapping: Mapping;
  onChange: (col: number, field: string) => void;
}) {
  const fields = IMPORT_KINDS[type].fields;
  const groups = [...new Set(fields.map((f) => f.group))];
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Column mapping">
      <table className={`table ${s.mapTable}`}>
        <caption className="sr-only">Columns in your file and the field each one fills</caption>
        <thead>
          <tr>
            <th scope="col">Column in your file</th>
            <th scope="col">Sample values</th>
            <th scope="col">Import as</th>
          </tr>
        </thead>
        <tbody>
          {parsed.header.map((name, i) => (
            <tr key={i}>
              <th scope="row" className={mapping[i] ? undefined : s.dropped}>
                {name || <span className="muted">Column {i + 1} (no name)</span>}
              </th>
              <td>
                <span className={s.sample} title={samples(parsed, i)}>
                  {samples(parsed, i) || <span className="muted">empty</span>}
                </span>
              </td>
              <td>
                <select
                  aria-label={`Import ${name || `column ${i + 1}`} as`}
                  value={mapping[i] ?? ''}
                  onChange={(e) => onChange(i, e.target.value)}
                >
                  <option value="">Don’t import</option>
                  {groups.map((g) => {
                    const options = fields
                      .filter((f) => f.group === g)
                      .map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                          {f.required ? ' (required)' : ''}
                        </option>
                      ));
                    return g ? (
                      <optgroup key={g} label={g}>
                        {options}
                      </optgroup>
                    ) : (
                      options
                    );
                  })}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Preview({ parsed, mapping }: { parsed: Parsed; mapping: Mapping }) {
  const rows = parsed.rows.slice(0, SAMPLE_ROWS);
  return (
    <details>
      <summary>Preview the first {plural(rows.length, 'row')}</summary>
      <div className="table-wrap" tabIndex={0} role="region" aria-label="File preview">
        <table className={`table ${s.preview}`}>
          <caption className="sr-only">First rows of the file; greyed columns are not imported</caption>
          <thead>
            <tr>
              <th scope="col">Line</th>
              {parsed.header.map((h, i) => (
                <th key={i} scope="col" className={mapping[i] ? undefined : s.dropped}>
                  {h || `Column ${i + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.line}>
                <td className="num">{r.line}</td>
                {r.fields.map((v, i) => (
                  <td key={i} className={mapping[i] ? undefined : s.dropped} title={v}>
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
