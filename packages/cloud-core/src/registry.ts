// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudProvider } from '@orkstage/domain';
import type { CloudProviderAdapter } from './types.js';

/** Maps providers to their adapter. Adding a provider means registering an adapter here. */
export class AdapterRegistry {
  private readonly adapters = new Map<CloudProvider, CloudProviderAdapter>();

  register(adapter: CloudProviderAdapter): this {
    this.adapters.set(adapter.provider, adapter);
    return this;
  }

  get(provider: CloudProvider): CloudProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`No adapter registered for provider "${provider}".`);
    return adapter;
  }

  has(provider: CloudProvider): boolean {
    return this.adapters.has(provider);
  }

  providers(): CloudProvider[] {
    return [...this.adapters.keys()];
  }
}
