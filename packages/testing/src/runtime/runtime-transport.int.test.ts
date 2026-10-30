/**
 * Transport shutdown (found while validating the hardening): closing a BullMQ worker that is
 * still connecting rejected its pending Redis commands with nobody listening — an unhandled
 * rejection, fatal to a Node process — and every closed worker leaked its Redis connection.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueTransport } from '@aptamind/queue';
import { createTestInfra, type TestInfra } from '../index';

let infra: TestInfra;
beforeAll(async () => {
  infra = await createTestInfra('transport');
});
afterAll(async () => infra?.cleanup());

describe('queue transport shutdown', () => {
  it('workers stopped right after start cause no unhandled rejection and leak no connection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    const transport = new QueueTransport({ url: infra.redisUrl, prefix: `t_close_${Date.now()}` });
    const clients = async () =>
      String(await transport.redis.client('LIST'))
        .trim()
        .split('\n').length;
    try {
      await transport.ping();
      const before = await clients();
      for (let i = 0; i < 40; i++) {
        const workers = [
          transport.createWorker(`close-a-${i}`, async () => 1),
          transport.createWorker(`close-b-${i}`, async () => 1),
        ];
        await new Promise((r) => setTimeout(r, i % 5));
        await Promise.all(workers.map((w) => w.close()));
      }
      await new Promise((r) => setTimeout(r, 300));
      expect(unhandled).toEqual([]);
      expect(await clients()).toBe(before);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await transport.close();
    }
  }, 60_000);
});
