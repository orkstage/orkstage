// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget, ProviderContext } from '@orkstage/cloud-core';
import { describe, expect, it, vi } from 'vitest';
import { NO_CONTROL_PLANE_IDENTITY, safeAwsMessage } from './adapter.js';
import { AwsCredentialProvider, REFRESH_MARGIN_MS } from './credentials.js';

const MIN = 60_000;
const target: CloudTarget = {
  id: 't1',
  provider: 'aws',
  name: 'prod',
  config: { accountId: '123456789012', roleArn: 'arn:aws:iam::123456789012:role/orkstage-deploy' },
  credentialRef: 'env://ORKSTAGE_PROD_EXTERNAL_ID',
  allowedRegions: ['us-east-1'],
  defaultRegion: 'us-east-1',
};

/** STS that hands out one hour credentials, numbered, relative to a fake clock. */
function setup(sessionSeconds = 3600) {
  let now = 1_000_000;
  let issued = 0;
  const send = vi.fn(async () => {
    issued += 1;
    return { Credentials: { AccessKeyId: `AK${issued}`, SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(now + sessionSeconds * 1000) } };
  });
  const provider = new AwsCredentialProvider(async () => 'external', () => ({ send }) as never, sessionSeconds, () => now);
  return { provider, send, advance: (ms: number) => (now += ms) };
}
const ctx = (over: Partial<CloudTarget> = {}, log?: ProviderContext['log']): ProviderContext => ({ target: { ...target, ...over }, region: 'us-east-1', correlationId: 'c1', log });

describe('AwsCredentialProvider', () => {
  it('reuses credentials for SDK calls until five minutes before they expire', async () => {
    const { provider, send, advance } = setup();
    expect((await provider.get(ctx())).accessKeyId).toBe('AK1');
    advance(50 * MIN);
    expect((await provider.get(ctx())).accessKeyId).toBe('AK1');
    advance(6 * MIN);
    expect((await provider.get(ctx())).accessKeyId).toBe('AK2');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('gives an OpenTofu run credentials that outlive its timeout', async () => {
    const { provider, advance } = setup();
    const run = 45 * MIN + REFRESH_MARGIN_MS;
    expect((await provider.get(ctx(), run)).accessKeyId).toBe('AK1');
    // Ten minutes later only fifty are left: enough for an SDK call, not for a 45 minute run.
    advance(10 * MIN);
    expect((await provider.get(ctx())).accessKeyId).toBe('AK1');
    expect((await provider.get(ctx(), run)).accessKeyId).toBe('AK2');
  });

  it('assumes again when the role or the credential reference changes', async () => {
    const { provider } = setup();
    expect((await provider.get(ctx())).accessKeyId).toBe('AK1');
    const moved = { ...target.config, roleArn: 'arn:aws:iam::123456789012:role/orkstage-deploy-2' };
    expect((await provider.get(ctx({ config: moved }))).accessKeyId).toBe('AK2');
    expect((await provider.get(ctx({ credentialRef: 'env://ORKSTAGE_PROD_EXTERNAL_ID_2' }))).accessKeyId).toBe('AK3');
  });

  it('warns when the session is shorter than the run may take', async () => {
    const { provider } = setup(3600);
    const log = vi.fn();
    await provider.get(ctx({}, log), 90 * MIN);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('AWS_ROLE_SESSION_MINUTES'));
  });
});

describe('safeAwsMessage', () => {
  it('explains a missing control plane identity', () => {
    const err = Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' });
    expect(safeAwsMessage(err)).toBe(NO_CONTROL_PLANE_IDENTITY);
  });
});
