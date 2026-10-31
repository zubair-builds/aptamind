import { describe, expect, it } from 'vitest';
import {
  actorSchema,
  SYSTEM_ACTOR,
  UNAUTHENTICATED_INTERNAL_OPERATOR,
  workflowActor,
} from './request-context';

describe('actorSchema (FE-5)', () => {
  it('parses the existing actors and constants unchanged', () => {
    for (const a of [SYSTEM_ACTOR, UNAUTHENTICATED_INTERNAL_OPERATOR, workflowActor('run_1')]) {
      expect(actorSchema.parse(a)).toEqual(a);
    }
  });

  it('parses historical stored actors (audit events, import createdBy)', () => {
    const historical = [
      { kind: 'system', id: 'system' },
      {
        kind: 'internal-operator',
        id: 'unauthenticated-internal-operator',
        displayName: 'Internal operator (no auth in v0.1)',
      },
      { kind: 'workflow', id: 'run_01JABCDEF' },
    ];
    for (const a of historical) expect(actorSchema.parse(a)).toEqual(a);
    const event = { type: 'source.updated', actor: historical[1], at: '2026-10-01T00:00:00Z' };
    expect(actorSchema.parse(event.actor)).toEqual(event.actor);
  });

  it('parses a user actor', () => {
    const u = {
      kind: 'user',
      id: 'usr_1',
      userId: 'usr_1',
      workspaceId: 'ws_default',
      displayName: 'Zubair',
      roles: ['admin'],
      tokenId: 'tok_1',
    };
    expect(actorSchema.parse(u)).toEqual(u);
    expect(actorSchema.parse({ kind: 'user', id: 'u', userId: 'u', workspaceId: 'w' }).kind).toBe('user');
  });

  it('rejects a user actor missing userId or workspaceId', () => {
    expect(actorSchema.safeParse({ kind: 'user', id: 'u', workspaceId: 'w' }).success).toBe(false);
    expect(actorSchema.safeParse({ kind: 'user', id: 'u', userId: 'u' }).success).toBe(false);
    expect(actorSchema.safeParse({ kind: 'user', id: 'u', userId: '', workspaceId: 'w' }).success).toBe(
      false,
    );
  });

  it('does not carry userId/workspaceId on non-user kinds', () => {
    const parsed = actorSchema.parse({ kind: 'system', id: 'system', userId: 'u', workspaceId: 'w' });
    expect(parsed).not.toHaveProperty('userId');
    expect(parsed).not.toHaveProperty('workspaceId');
    expect(actorSchema.safeParse({ kind: 'unknown', id: 'x' }).success).toBe(false);
  });

  it('rejects a user actor whose id differs from userId', () => {
    expect(
      actorSchema.safeParse({ kind: 'user', id: 'usr_other', userId: 'usr_1', workspaceId: 'w' }).success,
    ).toBe(false);
  });
});
