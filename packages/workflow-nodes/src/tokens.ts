import type { z } from 'zod';
import type { AiGateway, PromptTemplate } from '@aptamind/ai';
import type { SafeHttpClient } from '@aptamind/net';
import { createServiceToken } from '@aptamind/workflow-sdk';
import type { BrowserService } from './browser';

export const NET_CLIENT = createServiceToken<SafeHttpClient>('core.net.http-client');
export const BROWSER = createServiceToken<BrowserService>('core.browser');
export const AI_GATEWAY = createServiceToken<AiGateway>('core.ai.gateway');

/**
 * Named structured-extraction tasks usable from `core.ai_extract`. Each task pins a prompt
 * template version and an output schema version, so workflow definitions reference tasks by
 * name and never embed prompts inline.
 */
export interface AiTaskDefinition {
  id: string;
  prompt: PromptTemplate;
  schema: z.ZodType;
  schemaVersion: string;
}

export class AiTaskRegistry {
  private readonly tasks = new Map<string, AiTaskDefinition>();
  register(task: AiTaskDefinition): this {
    this.tasks.set(task.id, task);
    return this;
  }
  get(id: string): AiTaskDefinition {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`AI task ${id} is not registered`);
    return t;
  }
  list(): AiTaskDefinition[] {
    return [...this.tasks.values()];
  }
}

export const AI_TASKS = createServiceToken<AiTaskRegistry>('core.ai.tasks');
