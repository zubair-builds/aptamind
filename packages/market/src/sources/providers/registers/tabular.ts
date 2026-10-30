import * as cheerio from 'cheerio';
import { parse as parseCsv } from 'csv-parse/sync';

/**
 * File-format readers shared by the register adapters. Public registers are published as CSV/TSV
 * downloads (UK Home Office, USCIS) or as HTML tables (IND); an operator may upload either. The
 * readers only split a file into cells: what a column means is the adapter's business.
 */

/** Decode bytes by their BOM (UTF-8, UTF-16 LE/BE); UTF-8 without one. The BOM is dropped. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Whether a decoded file is an HTML document (sniffed; uploads arrive as text/plain or octet-stream). */
export function looksLikeHtml(text: string): boolean {
  return /^\s*(<!doctype html|<html|<head|<body|<table|<!--|<meta|<div|<section|<main|<h[1-6])/i.test(
    text.slice(0, 2048),
  );
}

/** Header cells compared case-, space- and punctuation-insensitively. */
export function headerKey(h: string): string {
  return h
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface DelimitedTable {
  header: string[];
  /** Data rows with the (1-based) file line each starts on. */
  rows: Array<{ line: number; cells: string[] }>;
  delimiter: string;
}

/** Split a delimited text file (comma, tab or semicolon, detected from the header line). */
export function readDelimited(text: string): DelimitedTable {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', '\t', ';'].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  const delimiter = counts.sort((a, b) => b.n - a.n)[0]!.d;
  let records: Array<{ record: string[]; info: { lines: number } }>;
  try {
    records = parseCsv(text, {
      delimiter,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      info: true,
    }) as unknown as Array<{ record: string[]; info: { lines: number } }>;
  } catch (err) {
    throw new Error(`delimited file could not be read: ${(err as Error).message}`);
  }
  const [head, ...rest] = records;
  return {
    header: (head?.record ?? []).map((h) => h.trim()),
    rows: rest.map((r) => ({ line: r.info.lines, cells: r.record })),
    delimiter,
  };
}

export interface HtmlTable {
  /** 1-based index of the (top-level) table in the document. */
  index: number;
  /**
   * The table's own heading: its caption / figcaption / bold-only label paragraph directly before
   * it, else the nearest heading before it when no other table shares that heading, else — on a
   * single-table page only — the document's h1/title (also standing in for a generic heading). Null when
   * the table has no heading of its own (fail closed: the adapter treats it as unrecognised).
   */
  heading: string | null;
  headingSource: 'caption' | 'heading' | 'document' | 'none' | 'shared';
  header: string[];
  rows: string[][];
}

const text = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * The top-level tables of an HTML document with their own headings (document order). Headings
 * and tables nested in a table cell never count, and `<template>` content is not the page
 * (DECISION_LOG "Sponsor register adapters" (1)).
 */
export function readHtmlTables(
  html: string,
  opts: {
    /**
     * A heading that names no route ("Recognised sponsors"): on a single-table page the page's
     * h1/title stands in for it (delta review A-M2); on a multi-table page it stays the heading.
     */
    isGenericHeading?: (heading: string) => boolean;
  } = {},
): HtmlTable[] {
  const $ = cheerio.load(html);
  $('template, script, style, noscript').remove();
  const inTable = (el: Parameters<typeof $>[0]) => $(el).parents('table').length > 0;
  // Document order of the headings and tables that count.
  const items: Array<{ heading: string } | { table: (typeof tables)[number] }> = [];
  const tables: Array<ReturnType<typeof $>> = [];
  $('h1, h2, h3, h4, h5, h6, table').each((_, el) => {
    if (inTable(el)) return;
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    if (tag === 'table') {
      const t = $(el);
      tables.push(t);
      items.push({ table: t });
    } else items.push({ heading: text($(el).text()) });
  });
  const h1 = $('h1')
    .toArray()
    .find((el) => !inTable(el));
  // A <title> carries a site suffix ("… | IND"): drop it.
  const title = text($('title').first().text()).replace(/\s+[|–—-]\s+[^|–—-]{1,40}$/, '');
  const docHeading = text(h1 ? $(h1).text() : '') || title || null;
  /**
   * A table's own label, like its <caption>: the <figcaption> of the figure it sits in, or a
   * paragraph directly before it that holds only bold text (`<p><strong>Studie</strong></p>`).
   */
  const ownLabel = (table: (typeof tables)[number]): string | null => {
    const caption = text(table.children('caption').first().text());
    if (caption) return caption;
    const figure = table.parent('figure');
    const figcaption = text(figure.children('figcaption').first().text());
    if (figcaption) return figcaption;
    const prev = table.prev();
    if (prev.is('p')) {
      const bold = text(prev.children('strong, b').text());
      if (bold && bold === text(prev.text())) return bold;
    }
    return null;
  };
  const labels = tables.map(ownLabel);
  // The nearest preceding heading of every table (by position in `items`).
  const nearest: Array<number | null> = [];
  let last: number | null = null;
  items.forEach((item, i) => {
    if ('heading' in item) last = item.heading ? i : last;
    else nearest.push(last);
  });
  // Tables with their own label do not share a heading with anyone.
  const shared = (h: number | null) =>
    h !== null && nearest.filter((x, k) => x === h && !labels[k]).length > 1;
  const single = tables.length === 1;
  return tables.map((table, k) => {
    const caption = labels[k] ?? null;
    const h = nearest[k] ?? null;
    let heading: string | null = null;
    let headingSource: HtmlTable['headingSource'] = 'none';
    if (caption) [heading, headingSource] = [caption, 'caption'];
    else if (h !== null && !shared(h)) {
      const own = (items[h] as { heading: string }).heading;
      if (single && docHeading && opts.isGenericHeading?.(own))
        [heading, headingSource] = [docHeading, 'document'];
      else [heading, headingSource] = [own, 'heading'];
    } else if (h !== null) headingSource = 'shared';
    else if (single && docHeading) [heading, headingSource] = [docHeading, 'document'];
    const trs = table
      .find('tr')
      .toArray()
      .filter((tr) => $(tr).closest('table').is(table));
    const cellsOf = (tr: (typeof trs)[number]) =>
      $(tr)
        .children('th, td')
        .toArray()
        .map((c) => text($(c).text()));
    const headIdx = trs.findIndex((tr) => $(tr).children('th').length > 0);
    const hi = headIdx >= 0 ? headIdx : 0;
    const header = trs[hi] ? cellsOf(trs[hi]) : [];
    const rows = trs
      .slice(hi + 1)
      .map(cellsOf)
      .filter((cells) => cells.some((c) => c !== ''));
    return { index: k + 1, heading, headingSource, header, rows };
  });
}

/** Index of the first header cell whose key matches one of the patterns; -1 when none. */
export function findColumn(header: string[], patterns: readonly RegExp[]): number {
  const keys = header.map(headerKey);
  for (const p of patterns) {
    const i = keys.findIndex((k) => p.test(k));
    if (i >= 0) return i;
  }
  return -1;
}
