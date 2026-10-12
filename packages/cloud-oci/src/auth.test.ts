// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OciClient, parsePrivateKey, signRequest, signingString, type OciSigningKey } from './auth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const key: OciSigningKey = { tenancyOcid: 'ocid1.tenancy.oc1..aaa', userOcid: 'ocid1.user.oc1..bbb', fingerprint: '20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34', privateKey: pem };
const date = new Date('2014-01-05T21:31:40Z');

function parseAuthorization(value: string): Record<string, string> {
  return Object.fromEntries([...value.replace(/^Signature /, '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
}

function verify(signing: string, signature: string): boolean {
  return createVerify('RSA-SHA256').update(signing).verify(publicKey, signature, 'base64');
}

describe('OCI request signing', () => {
  it('signs a GET with date, request target (path and query) and host', () => {
    const url = 'https://iaas.us-phoenix-1.oraclecloud.com/20160918/instances?availabilityDomain=Pjwf%3A%20PHX-AD-1&displayName=TeamXInstances';
    const headers = signRequest(key, { method: 'GET', url, date });
    expect(headers.date).toBe('Sun, 05 Jan 2014 21:31:40 GMT');
    expect(headers.host).toBe('iaas.us-phoenix-1.oraclecloud.com');
    expect(headers['x-content-sha256']).toBeUndefined();
    const auth = parseAuthorization(headers.authorization!);
    expect(auth).toMatchObject({ version: '1', keyId: 'ocid1.tenancy.oc1..aaa/ocid1.user.oc1..bbb/20:3b:97:13:55:1c:5b:0d:d3:37:d8:50:4e:c5:3a:34', algorithm: 'rsa-sha256', headers: 'date (request-target) host' });
    // The signing string exactly as the OCI documentation lays it out.
    const expected = [
      'date: Sun, 05 Jan 2014 21:31:40 GMT',
      '(request-target): get /20160918/instances?availabilityDomain=Pjwf%3A%20PHX-AD-1&displayName=TeamXInstances',
      'host: iaas.us-phoenix-1.oraclecloud.com',
    ].join('\n');
    expect(verify(expected, auth.signature!)).toBe(true);
  });

  it('signs body headers for a POST', () => {
    const body = JSON.stringify({ compartmentId: 'ocid1.compartment.oc1..x', instanceId: 'ocid1.instance.oc1.phx.y' });
    const headers = signRequest(key, { method: 'POST', url: 'https://iaas.us-phoenix-1.oraclecloud.com/20160918/volumeAttachments', body, date });
    expect(headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-content-sha256']).toBe(createHash('sha256').update(body).digest('base64'));
    const auth = parseAuthorization(headers.authorization!);
    expect(auth.headers).toBe('date (request-target) host content-length content-type x-content-sha256');
    const signing = signingString({ ...headers, '(request-target)': 'post /20160918/volumeAttachments' }, auth.headers!.split(' '));
    expect(signing.split('\n')[1]).toBe('(request-target): post /20160918/volumeAttachments');
    expect(verify(signing, auth.signature!)).toBe(true);
  });

  it('signs an empty body for POST actions', () => {
    const headers = signRequest(key, { method: 'POST', url: 'https://compute-containers.us-ashburn-1.oci.oraclecloud.com/20210415/containerInstances/x/actions/restart', date });
    expect(headers['content-length']).toBe('0');
    expect(headers['x-content-sha256']).toBe('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  });

  it('accepts PKCS#8 keys and escaped line breaks, and never echoes a bad key', () => {
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => parsePrivateKey(pkcs8.replace(/\n/g, '\\n'))).not.toThrow();
    try {
      parsePrivateKey('-----BEGIN RSA PRIVATE KEY-----\nnot-a-key-SECRET\n-----END RSA PRIVATE KEY-----');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET');
      expect(err).toMatchObject({ code: 'OCI_PRIVATE_KEY_INVALID', failureClass: 'AUTHENTICATION_ERROR' });
    }
  });

  it('sends signed requests without host or content-length headers and redacts errors', async () => {
    const fetchFn = vi.fn(async () => new Response('{"message":"denied for ocid1.user.oc1..secretuser"}', { status: 403 }));
    const client = new OciClient(key, fetchFn as unknown as typeof fetch);
    await expect(client.json('POST', 'https://identity.us-ashburn-1.oci.oraclecloud.com/20160918/x', { body: { a: 1 } })).rejects.toThrow(/HTTP 403 .*<ocid>/);
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    const sent = init.headers as Record<string, string>;
    expect(sent.authorization).toMatch(/^Signature version="1"/);
    expect(sent.host).toBeUndefined();
    expect(sent['content-length']).toBeUndefined();
    expect(sent['x-content-sha256']).toBe(createHash('sha256').update('{"a":1}').digest('base64'));
    expect(init.body).toBe('{"a":1}');
  });
});
