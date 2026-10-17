// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { certificateArns, fromAcm, readCertificates } from './certificates.js';

describe('ACM certificates (open item 9)', () => {
  it('reads the platform and custom certificate ARNs from the dns outputs', () => {
    expect(certificateArns({ certificate_arn: 'arn:a', custom_certificate_arn: '' })).toEqual(['arn:a']);
    expect(certificateArns({ certificate_arn: 'arn:a', custom_certificate_arn: 'arn:b' })).toEqual(['arn:a', 'arn:b']);
  });

  it('reports pending custom domains with the records their owner must create', () => {
    const certs = fromAcm({
      Status: 'PENDING_VALIDATION',
      DomainName: 'api.acme.com',
      DomainValidationOptions: [
        { DomainName: 'api.acme.com', ValidationStatus: 'PENDING_VALIDATION', ResourceRecord: { Name: '_abc.api.acme.com.', Type: 'CNAME', Value: '_xyz.acm-validations.aws.' } },
        { DomainName: 'www.acme.com', ValidationStatus: 'SUCCESS' },
      ],
    });
    expect(certs[0]).toEqual({ hostname: 'api.acme.com', status: 'PENDING_VALIDATION', records: [{ name: '_abc.api.acme.com', type: 'CNAME', value: '_xyz.acm-validations.aws' }] });
    expect(certs[1]).toMatchObject({ hostname: 'www.acme.com', status: 'PENDING_VALIDATION' });
  });

  it('reports issued certificates with their expiry', async () => {
    const notAfter = new Date('2027-01-01T00:00:00Z');
    const client = { send: async () => ({ Certificate: { Status: 'ISSUED', DomainName: 'x.apps.example.com', NotAfter: notAfter, DomainValidationOptions: [{ DomainName: 'x.apps.example.com', ValidationStatus: 'SUCCESS' }] } }) };
    expect(await readCertificates(client as never, { certificate_arn: 'arn:a' })).toEqual([{ hostname: 'x.apps.example.com', status: 'ISSUED', notAfter: notAfter.toISOString() }]);
  });
});
