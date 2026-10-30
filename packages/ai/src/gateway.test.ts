import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AiOutputValidationError,
  AiUnavailableError,
  DefaultAiGateway,
  definePrompt,
  FixtureAiProvider,
} from './index';

const prompt = definePrompt({
  id: 'test.extract',
  version: '1',
  system: 'Extract.',
  render: (v) => `Text: ${v.text}`,
});
const schema = z.object({ name: z.string(), score: z.number().min(0).max(1) });

describe('AI gateway', () => {
  it('validates output and records provenance metadata', async () => {
    const gw = new DefaultAiGateway(new FixtureAiProvider(() => ({ name: 'Acme', score: 0.9 })));
    const res = await gw.structuredExtract({
      task: 't',
      prompt,
      vars: { text: 'hello' },
      schema,
      schemaVersion: 's1',
      inputRefs: [{ kind: 'artifact', id: 'art_1' }],
    });
    expect(res.data).toEqual({ name: 'Acme', score: 0.9 });
    expect(res.meta).toMatchObject({
      provider: 'fixture',
      model: 'fixture-model-v1',
      promptId: 'test.extract',
      promptVersion: '1',
      schemaVersion: 's1',
      inputRefs: [{ kind: 'artifact', id: 'art_1' }],
    });
    expect(res.meta.inputHash).toHaveLength(64);
  });

  it('rejects output that violates the schema', async () => {
    const gw = new DefaultAiGateway(new FixtureAiProvider(() => ({ name: 'Acme', score: 7 })));
    await expect(
      gw.structuredExtract({
        task: 't',
        prompt,
        vars: { text: 'x' },
        schema,
        schemaVersion: '1',
        inputRefs: [],
      }),
    ).rejects.toBeInstanceOf(AiOutputValidationError);
  });

  it('fails visibly when no provider is configured', async () => {
    const gw = new DefaultAiGateway(null);
    expect(gw.available).toBe(false);
    await expect(
      gw.structuredExtract({
        task: 't',
        prompt,
        vars: { text: 'x' },
        schema,
        schemaVersion: '1',
        inputRefs: [],
      }),
    ).rejects.toBeInstanceOf(AiUnavailableError);
  });
});
