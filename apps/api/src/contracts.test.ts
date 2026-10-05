import * as contracts from '@co/contracts';
import * as domain from '@co/domain';
import { describe, expect, it } from 'vitest';

/** @co/contracts duplicates a few enums to stay browser-light; they must match the domain. */
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
