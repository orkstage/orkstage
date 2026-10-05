/**
 * Where the mock provider keeps its simulated cloud. Production workers back this with Redis
 * so simulated resources survive worker restarts and are shared across processes.
 */
export interface MockStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemoryMockStateStore implements MockStateStore {
  private readonly data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}
