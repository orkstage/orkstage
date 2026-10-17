// SPDX-License-Identifier: AGPL-3.0-only
import { DescribeCertificateCommand, type ACMClient, type CertificateDetail } from '@aws-sdk/client-acm';
import type { CertificateInfo, ResourceOutputs } from '@orkstage/cloud-core';

/** The ACM certificates a `dns` resource recorded: the platform subdomain and the custom domains. */
export function certificateArns(outputs: ResourceOutputs): string[] {
  return [outputs.certificate_arn, outputs.custom_certificate_arn].map((v) => (v === undefined ? '' : String(v))).filter(Boolean);
}

/** One entry per hostname of an ACM certificate, with the validation records still needed. */
export function fromAcm(detail: CertificateDetail): CertificateInfo[] {
  const status: CertificateInfo['status'] =
    detail.Status === 'ISSUED' ? 'ISSUED' : detail.Status === 'EXPIRED' ? 'EXPIRED' : detail.Status === 'PENDING_VALIDATION' ? 'PENDING_VALIDATION' : 'FAILED';
  const notAfter = detail.NotAfter ? new Date(detail.NotAfter).toISOString() : undefined;
  const options = detail.DomainValidationOptions ?? [{ DomainName: detail.DomainName }];
  return options
    .filter((o) => o.DomainName)
    .map((o) => {
      const r = o.ResourceRecord;
      const pending = o.ValidationStatus === 'PENDING_VALIDATION' && r?.Name && r.Value;
      return {
        hostname: o.DomainName!,
        status: status === 'ISSUED' || o.ValidationStatus !== 'SUCCESS' ? status : 'PENDING_VALIDATION',
        ...(notAfter ? { notAfter } : {}),
        ...(pending ? { records: [{ name: r!.Name!.replace(/\.$/, ''), type: 'CNAME' as const, value: r!.Value!.replace(/\.$/, '') }] } : {}),
      };
    });
}

export async function readCertificates(client: Pick<ACMClient, 'send'>, outputs: ResourceOutputs, signal?: AbortSignal): Promise<CertificateInfo[]> {
  const out: CertificateInfo[] = [];
  for (const arn of certificateArns(outputs)) {
    const res = await client.send(new DescribeCertificateCommand({ CertificateArn: arn }), { abortSignal: signal });
    if (res.Certificate) out.push(...fromAcm(res.Certificate));
  }
  return out;
}
