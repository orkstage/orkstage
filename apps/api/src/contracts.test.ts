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

describe('provider config checks', () => {
  it('rejects values that do not match their field, and an AWS role in another account', () => {
    expect(contracts.providerConfigIssues('aws', { accountId: '123456789012', roleArn: 'arn:aws:iam::123456789012:role/orkstage-deploy', dnsZone: 'apps.example.com' })).toEqual([]);
    expect(contracts.providerConfigIssues('aws', { accountId: '12', dnsZone: 'not a zone' })).toHaveLength(2);
    expect(contracts.providerConfigIssues('aws', { accountId: '123456789012', roleArn: 'arn:aws:iam::210987654321:role/orkstage-deploy' })).toEqual([
      'roleArn is in account 210987654321, but accountId is 123456789012.',
    ]);
    // Emulator targets leave the role out; required fields are the forms' and the adapter's job.
    expect(contracts.providerConfigIssues('aws', { accountId: '000000000000', emulator: 'ministack', endpointUrl: 'http://localhost:4566' })).toEqual([]);
  });

  it('keeps the account and the state location of every provider fixed', () => {
    expect(contracts.fixedConfigKeys('aws')).toEqual(['accountId', 'stateBucket']);
    for (const provider of contracts.PROVIDERS) {
      const keys = contracts.PROVIDER_FORMS[provider].config.map((f) => f.key);
      for (const key of keys.filter((k) => /^state(Bucket|Endpoint|Region|StorageAccount|ResourceGroup|Container)$/.test(k))) {
        expect(contracts.fixedConfigKeys(provider), `${provider}.${key}`).toContain(key);
      }
    }
  });
});
