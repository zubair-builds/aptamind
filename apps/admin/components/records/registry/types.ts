import type { ReactNode } from 'react';
import type { ViewSchema } from '@/lib/views';

/** One table column (design system §3): cells render API values only. */
export interface ColumnDef<Row> {
  key: string;
  label: string;
  cell: (row: Row) => ReactNode;
  /** API sort key when the list API can sort by this column. */
  sort?: string;
  defaultVisible?: boolean;
  /** The record's name: always shown, first, sticky, the row's link. */
  identity?: boolean;
  numeric?: boolean;
  /** Wrap instead of truncating (long free text); on the identity column: up to two lines on phones. */
  wrap?: boolean;
  /** Cap in px for long values (truncated with an ellipsis; the full text is the tooltip). */
  maxWidth?: number;
}

/** A record object (Jobs, Companies, Sources): list API, columns, filters and system views. */
export interface ObjectDef<Row> extends ViewSchema {
  key: string;
  /** Plural, capitalised ("Jobs"). */
  label: string;
  /** Singular, lower-case ("job"). */
  singular: string;
  apiPath: string;
  /** Empty: the list API has no `q` (no search box). */
  searchLabel: string;
  /** How the API matches `q` (anchored prefixes; the contracts' v2 search rules). */
  searchHint: string;
  columns: ColumnDef<Row>[];
  rowId: (row: Row) => string;
  rowHref: (row: Row) => string;
  rowTitle: (row: Row) => string;
  /** Key properties for the row preview. */
  peek: (row: Row) => { label: string; value: ReactNode }[];
  /** How a filter value reads in a chip (e.g. a company name instead of its id). */
  chipValue?: (param: string, value: string, rows: Row[]) => string | undefined;
  /** How the filters behave, shown at the top of the filter panel. */
  filterNote?: string;
  /** Sentence for an empty list with no filters. */
  emptyAll: string;
}
