import * as contracts from '@orkstage/contracts';
import * as domain from '@orkstage/domain';
import { describe, expect, it } from 'vitest';

/** @orkstage/contracts duplicates a few enums to stay browser-light; they must match the domain. */
describe('contract enums match the domain', () => {
  it.each([
    ['providers', contracts.PROVIDERS, domain.CLOUD_PROVIDERS],
    ['plans', contracts.PLAN_CODES, domain.PLAN_CODES],
    ['health', contracts.HEALTH_STATES, domain.HEALTH_STATES],
    ['status', contracts.STATUS_STATES, domain.STATUS_STATES],
  ])('%s', (_name, a, b) => {
    expect([...a]).toEqual([...b]);
  });
});
