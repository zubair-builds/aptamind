import { describe, expect, it } from 'vitest';
import { careersPageCrawl } from './index';

describe('careers crawl evidence (PR #11 re-verify #9 Low 6, #10 L7)', () => {
  it('ingest records each sighting at the time and on the board the extract step labelled', () => {
    const ingest = careersPageCrawl.nodes.find((n) => n.id === 'ingest')!;
    const body = JSON.stringify(ingest.config);
    expect(body).toContain('nodes.extract.output.observedAt');
    expect(body).toContain('nodes.extract.output.board');
  });

  it("the extract step labels the crawl's start: the run trigger's time and the crawl's start URL", () => {
    const extract = careersPageCrawl.nodes.find((n) => n.id === 'extract')!;
    const crawl = careersPageCrawl.nodes.find((n) => n.id === 'crawl')!;
    const input = JSON.stringify(extract.input);
    expect(input).toContain('nodes.trigger.output.firedAt');
    expect(input).toContain('nodes.trigger.output.payload.startUrl');
    // The same start URL the crawl itself starts from.
    expect(JSON.stringify(crawl.input)).toContain('nodes.trigger.output.payload.startUrl');
  });
});
