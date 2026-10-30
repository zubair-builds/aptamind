/**
 * Typed service injection for capabilities.
 *
 * The runtime is domain-agnostic: it does not know what a "company resolver" is. Domain
 * packages declare service tokens and the worker bootstrap registers implementations.
 * Capabilities fetch what they need via `ctx.services.get(token)`.
 */
export interface ServiceToken<T> {
  readonly key: string;
  /** Phantom type marker; never set at runtime. */
  readonly __type?: T;
}

export function createServiceToken<T>(key: string): ServiceToken<T> {
  return { key };
}

export class ServiceRegistry {
  private readonly services = new Map<string, unknown>();

  register<T>(token: ServiceToken<T>, impl: T): this {
    this.services.set(token.key, impl);
    return this;
  }

  get<T>(token: ServiceToken<T>): T {
    if (!this.services.has(token.key)) {
      throw new Error(`Service ${token.key} is not registered in this process`);
    }
    return this.services.get(token.key) as T;
  }

  has(token: ServiceToken<unknown>): boolean {
    return this.services.has(token.key);
  }
}
