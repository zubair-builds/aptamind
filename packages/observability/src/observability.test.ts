import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, MetricsRegistry, withCorrelation } from './index';

describe('logger', () => {
  it('attaches correlation ids and redacts secrets', async () => {
    const lines: string[] = [];
    const dest = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createLogger({ service: 'test', destination: dest });
    withCorrelation({ workflowRunId: 'run_1', nodeRunId: 'nrun_1' }, () => {
      log.info({ apiKey: 'sk-secret', headers: { authorization: 'Bearer x' } }, 'hello');
    });
    const parsed = JSON.parse(lines[0] ?? '{}');
    expect(parsed.workflowRunId).toBe('run_1');
    expect(parsed.nodeRunId).toBe('nrun_1');
    expect(parsed.apiKey).toBe('[redacted]');
    expect(parsed.headers.authorization).toBe('[redacted]');
  });
});

describe('metrics', () => {
  it('renders prometheus text', () => {
    const m = new MetricsRegistry();
    m.inc('node_runs_total', { status: 'completed' });
    m.inc('node_runs_total', { status: 'completed' });
    m.observe('node_duration_ms', 42, { capability: 'core.http' });
    const text = m.toPrometheus();
    expect(text).toContain('node_runs_total{status="completed"} 2');
    expect(text).toContain('node_duration_ms_count{capability="core.http"} 1');
    expect(text).toContain('node_duration_ms_bucket{capability="core.http",le="50"} 1');
  });
});
