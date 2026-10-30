import Link from 'next/link';
import { Menu } from '@/components/ui/Menu';
import { enumLabel } from '@/lib/format';
import {
  type FilterSpec,
  hiddenFields,
  isModified,
  presetState,
  sortLabel,
  systemViewHref,
  viewHref,
  visibleColumns,
  withoutFilter,
  type ViewState,
} from '@/lib/views';
import type { ObjectDef } from '../registry/types';
import { ToolbarPopover } from './ToolbarPopover';
import s from './table.module.css';
import { ViewTabs } from './ViewTabs';

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Filter values in sentence case (explicit labels, else the enum value); codes stay as typed. */
const valueLabel = (spec: FilterSpec, v: string) => {
  const explicit = 'labels' in spec ? spec.labels?.[v] : undefined;
  if (explicit) return cap(explicit);
  return spec.kind === 'enum' || spec.kind === 'choice' ? enumLabel(v) : v;
};

function Hidden({ fields }: { fields: [string, string][] }) {
  return (
    <>
      {fields.map(([k, v], i) => (
        <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

function FilterField({
  spec,
  state,
  id,
  suggestions,
}: {
  spec: FilterSpec;
  state: ViewState;
  id: string;
  suggestions?: string[];
}) {
  const current = state.filters[spec.param] ?? [];
  if (spec.kind === 'enum' || spec.kind === 'choice') {
    const type = spec.kind === 'enum' ? 'checkbox' : 'radio';
    return (
      <fieldset className={s.fieldset}>
        <legend className={s.legend}>{spec.label}</legend>
        <div className={s.options}>
          {spec.kind === 'choice' ? (
            <label className={s.option}>
              <input type="radio" name={spec.param} value="" defaultChecked={!current.length} />{' '}
              {spec.emptyLabel ?? 'Any'}
            </label>
          ) : null}
          {(spec.kind === 'choice' ? (spec.formValues ?? spec.values) : spec.values).map((v) => (
            <label key={v} className={s.option}>
              <input type={type} name={spec.param} value={v} defaultChecked={current.includes(v)} />{' '}
              {valueLabel(spec, v)}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  const inputId = `${id}-${spec.param}`;
  return (
    <div className={s.fieldset}>
      <label htmlFor={inputId} className={s.legend}>
        {spec.label}
      </label>
      {spec.kind === 'codes' ? (
        <input
          id={inputId}
          className={s.input}
          type="text"
          name={spec.param}
          defaultValue={current.join(', ')}
          placeholder={spec.placeholder}
          autoComplete="off"
          spellCheck={false}
          list={suggestions?.length ? `${inputId}-options` : undefined}
        />
      ) : null}
      {spec.kind === 'codes' && suggestions?.length ? (
        <datalist id={`${inputId}-options`}>
          {suggestions.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      ) : spec.kind === 'codes' ? null : spec.kind === 'date' ? (
        <input
          id={inputId}
          className={s.input}
          type="date"
          name={spec.param}
          defaultValue={current[0] ?? ''}
        />
      ) : (
        <input
          id={inputId}
          className={s.input}
          type="number"
          name={spec.param}
          min={spec.min ?? 0}
          defaultValue={current[0] ?? ''}
        />
      )}
    </div>
  );
}

/**
 * The view bar: system views, search, filter and column panels (GET forms, so the URL stays the
 * view), sort and density, active-filter chips, and a note for URL values the API would reject.
 */
export function ViewBar<Row>({
  def,
  state,
  rows,
  searchId,
  suggestions,
}: {
  def: ObjectDef<Row>;
  state: ViewState;
  rows: Row[];
  searchId: string;
  /** Known values for free-code filters (e.g. workflow keys), offered as input suggestions. */
  suggestions?: Record<string, string[]>;
}) {
  const modified = isModified(def, state);
  const active = def.filters.filter((f) => state.filters[f.param]?.length);
  const sortSpec = def.sorts.find((x) => x.key === state.sort.replace(/^-/, ''));
  const shown = new Set(visibleColumns(def, state));
  const formId = `${def.key}-filters`;
  return (
    <div className={s.viewBar}>
      <ViewTabs className={s.views} label={`${def.label} views`} current={state.view}>
        {def.views.map((v) => (
          <Link
            key={v.id}
            href={systemViewHref(def, state, v.id)}
            className={s.viewTab}
            // Current only while the URL is exactly that view; a changed view is marked, not current.
            aria-current={v.id === state.view && !modified ? 'page' : undefined}
            data-modified={v.id === state.view && modified ? true : undefined}
          >
            {v.label}
            {v.id === state.view && modified ? (
              <>
                <span aria-hidden="true" className={s.modifiedDot} />
                <span className="sr-only"> (modified)</span>
              </>
            ) : null}
          </Link>
        ))}
      </ViewTabs>

      <div className={s.toolbar}>
        {def.searchLabel ? (
          <form method="get" action={def.path} role="search" className={s.search}>
            <label htmlFor={searchId} className="sr-only">
              {def.searchLabel}
            </label>
            <input
              id={searchId}
              className={s.input}
              type="search"
              name="q"
              defaultValue={state.q}
              placeholder={`${def.searchLabel}…`}
              maxLength={200}
              aria-describedby={`${searchId}-hint`}
            />
            <span id={`${searchId}-hint`} className="sr-only">
              {def.searchHint} Press slash to focus.
            </span>
            <Hidden fields={hiddenFields(def, state, ['q'])} />
            <button type="submit" className="btn">
              Search
            </button>
          </form>
        ) : null}

        <ToolbarPopover label={`Filter ${def.label.toLowerCase()}`} text="Filter" count={active.length} wide>
          <form method="get" action={def.path} className={s.filterForm}>
            {def.filterNote ? <p className={s.formNote}>{def.filterNote}</p> : null}
            <div className={s.filterGrid}>
              {def.filters.map((spec) => (
                <FilterField
                  key={spec.param}
                  spec={spec}
                  state={state}
                  id={formId}
                  suggestions={suggestions?.[spec.param]}
                />
              ))}
            </div>
            <Hidden fields={hiddenFields(def, state, ['filters'])} />
            <div className={s.formActions}>
              <button type="submit" className="btn btn-primary">
                Apply filters
              </button>
              <Link href={viewHref(def, state, { filters: {} })}>Clear filters</Link>
            </div>
          </form>
        </ToolbarPopover>

        <ToolbarPopover label="Columns" text="Columns">
          <form method="get" action={def.path} className={s.columnsForm}>
            <fieldset className={s.fieldset}>
              <legend className={s.legend}>Visible columns</legend>
              <div className={s.options}>
                {def.columns
                  .filter((c) => !c.identity)
                  .map((c) => (
                    <label key={c.key} className={s.option}>
                      <input type="checkbox" name="cols" value={c.key} defaultChecked={shown.has(c.key)} />{' '}
                      {c.label}
                    </label>
                  ))}
              </div>
            </fieldset>
            {/* Always submits the identity column, so "none checked" means only the name. */}
            {def.columns
              .filter((c) => c.identity)
              .map((c) => (
                <input key={c.key} type="hidden" name="cols" value={c.key} />
              ))}
            <Hidden fields={hiddenFields(def, state, ['cols'])} />
            <div className={s.formActions}>
              <button type="submit" className="btn btn-primary">
                Apply
              </button>
              <Link href={viewHref(def, state, { cols: null })}>Default columns</Link>
            </div>
          </form>
        </ToolbarPopover>

        {def.sorts.length > 1 ? (
          <Menu
            label="Sort"
            buttonLabel={
              sortSpec?.labels
                ? `Sort: ${sortLabel(sortSpec, state.sort).text}`
                : `Sort: ${sortSpec?.label ?? state.sort} ${sortSpec ? sortLabel(sortSpec, state.sort).arrow : ''}`
            }
            placement="bottom-start"
            items={def.sorts.flatMap((x) => [
              {
                id: `${x.key}-asc`,
                label: sortLabel(x, x.key).text,
                href: viewHref(def, state, { sort: x.key }),
                current: state.sort === x.key,
              },
              {
                id: `${x.key}-desc`,
                label: sortLabel(x, `-${x.key}`).text,
                href: viewHref(def, state, { sort: `-${x.key}` }),
                current: state.sort === `-${x.key}`,
              },
            ])}
          />
        ) : null}

        <Link
          className={s.density}
          href={viewHref(def, state, { density: state.density === 'compact' ? 'comfortable' : 'compact' })}
        >
          {state.density === 'compact' ? 'Comfortable rows' : 'Compact rows'}
        </Link>
      </div>

      {active.length || state.q || modified ? (
        <div className={s.chips} aria-label="Active filters" role="group">
          {state.q ? (
            <span className={s.chip}>
              Search: &ldquo;{state.q}&rdquo;
              <Link
                href={viewHref(def, state, { q: '' })}
                aria-label="Remove search"
                className={s.chipRemove}
              >
                ×
              </Link>
            </span>
          ) : null}
          {active.map((spec) => {
            const values = state.filters[spec.param]!;
            const text = values
              .map((v) => def.chipValue?.(spec.param, v, rows) ?? valueLabel(spec, v))
              .join(', ');
            return (
              <span key={spec.param} className={s.chip}>
                {spec.label}: {text}
                <Link
                  href={viewHref(def, state, { filters: withoutFilter(state, spec.param) })}
                  aria-label={`Remove filter ${spec.label}`}
                  className={s.chipRemove}
                >
                  ×
                </Link>
              </span>
            );
          })}
          {modified ? (
            <Link
              href={viewHref(def, {
                ...presetState(def, state.view),
                cols: state.cols,
                density: state.density,
              })}
            >
              Reset view
            </Link>
          ) : null}
        </div>
      ) : null}

      {state.ignored.length ? (
        <p className={s.ignored} role="note">
          Ignored in the URL (the API would reject them):{' '}
          {state.ignored.map((i) => `${i.param}=${i.value} (${i.reason})`).join('; ')}.
        </p>
      ) : null}
    </div>
  );
}
