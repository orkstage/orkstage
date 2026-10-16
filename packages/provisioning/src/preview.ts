// SPDX-License-Identifier: AGPL-3.0-only
import type { AdapterRegistry, CloudTarget } from '@orkstage/cloud-core';
import { ALL_FEATURES, isCloudProvider, PROVIDER_INFO, type CloudProvider } from '@orkstage/domain';
import type { EnvironmentTemplate } from '@orkstage/templates';
import { compileInfrastructure } from './compiler.js';
import type { CostEstimate, ResolvedInfrastructure } from './types.js';

export interface TemplatePreview {
  /** Provider chosen for each placement slot (the first one the slot allows). */
  placements: Record<string, CloudProvider>;
  /** Providers any slot allows; empty when every slot allows any provider. */
  providers: CloudProvider[];
  cost: CostEstimate;
  resolved: ResolvedInfrastructure;
}

/**
 * What a template would look like without any account: each placement slot is bound to a
 * simulation target imitating the first provider the slot allows (AWS when it allows any), in a
 * representative region, with no tenant limits and every feature allowed. Used for marketplace
 * cards and pages; nothing is created.
 */
export function previewTemplate(template: EnvironmentTemplate, registry: AdapterRegistry): TemplatePreview {
  const placements: Record<string, CloudProvider> = {};
  const bindings: Record<string, { target: CloudTarget; region: string }> = {};
  for (const slot of template.spec.placements) {
    const provider = slot.providers.find((p) => p !== 'mock' && isCloudProvider(p)) ?? 'aws';
    const region = PROVIDER_INFO[provider].previewRegion;
    placements[slot.name] = provider;
    bindings[slot.name] = {
      target: { id: `preview-${slot.name}`, provider: 'mock', name: `Preview ${PROVIDER_INFO[provider].displayName}`, config: { simulate: provider }, allowedRegions: [region], defaultRegion: region },
      region,
    };
  }
  const resolved = compileInfrastructure(
    {
      template,
      limits: {},
      features: ALL_FEATURES,
      organizationId: 'preview',
      tenant: { id: 'preview', slug: 'preview' },
      instance: { id: 'preview', slug: 'preview', environment: 'production' },
      bindings,
    },
    registry,
  );
  const providers = [...new Set(template.spec.placements.flatMap((s) => s.providers).filter((p): p is CloudProvider => p !== 'mock' && isCloudProvider(p)))];
  return { placements, providers, cost: resolved.cost, resolved };
}
