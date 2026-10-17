// SPDX-License-Identifier: AGPL-3.0-only
import * as contracts from '@orkstage/contracts';
import * as domain from '@orkstage/domain';
import { ENTERPRISE_FEATURES } from '@orkstage/licensing';
import { describe, expect, it } from 'vitest';

/** @orkstage/contracts duplicates a few enums to stay browser-light; they must match the domain. */
describe('contract enums match the domain', () => {
  it.each([
    ['providers', contracts.PROVIDERS, domain.CLOUD_PROVIDERS],
    ['tenant limits', Object.keys(contracts.tenantLimitsSchema.shape), domain.TENANT_LIMIT_KEYS],
    ['health', contracts.HEALTH_STATES, domain.HEALTH_STATES],
    ['enterprise features', contracts.ENTERPRISE_FEATURE_KEYS, ENTERPRISE_FEATURES],
    ['status', contracts.STATUS_STATES, domain.STATUS_STATES],
  ])('%s', (_name, a, b) => {
    expect([...a]).toEqual([...b]);
  });
});
