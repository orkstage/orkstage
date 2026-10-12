// SPDX-License-Identifier: AGPL-3.0-only
import type { CloudTarget, TargetValidationCheck } from '@orkstage/cloud-core';

/** Non secret OCI target configuration stored on the cloud target. */
export interface OciTargetConfig {
  tenancyOcid: string;
  /** API signing user. Its private key is in the credential secret. */
  userOcid: string;
  /** Fingerprint of the API signing key, e.g. `12:34:...:ef`. */
  fingerprint: string;
  /** Compartment where every resource of this target is created. */
  compartmentOcid: string;
  /** Object Storage namespace of the tenancy. */
  namespace: string;
  /** Existing bucket for OpenTofu state, reachable through the S3 compatibility API. */
  stateBucket: string;
  /** Vault and AES key for generated credentials. Without them each database creates its own vault. */
  vaultOcid?: string;
  keyOcid?: string;
}

/** Fields of the JSON secret behind the target's credentialRef. */
export interface OciCredentials extends Record<string, string> {
  /** PEM private key of the API signing key (unencrypted). */
  privateKey: string;
  /** Customer secret key for the Object Storage S3 compatibility API (state storage). */
  stateAccessKeyId: string;
  stateSecretAccessKey: string;
}

export function ociConfig(target: CloudTarget): OciTargetConfig {
  return target.config as unknown as OciTargetConfig;
}

/** True when the target names a shared vault and key for generated credentials. */
export function hasVault(cfg: OciTargetConfig): boolean {
  return Boolean(cfg.vaultOcid && cfg.keyOcid);
}

// ocid1.<type>.<realm>.[region][.future].<unique>
const OCID = (type: string) => new RegExp(`^ocid1\\.${type}\\.oc\\d+\\.[a-z0-9.-]*\\.[a-z0-9]+$`);
const REGION = /^[a-z]{2,}-[a-z]+-\d+$/;

/** Checks of the target configuration that need no network. */
export function configChecks(target: CloudTarget): TargetValidationCheck[] {
  const cfg = ociConfig(target);
  const checks: TargetValidationCheck[] = [];
  const bad = (name: string, message: string) => checks.push({ name, status: 'error', message });
  if (!OCID('tenancy').test(cfg.tenancyOcid ?? '')) bad('Tenancy', 'tenancyOcid must be a tenancy OCID (ocid1.tenancy.oc1..).');
  if (!OCID('user').test(cfg.userOcid ?? '')) bad('API user', 'userOcid must be a user OCID (ocid1.user.oc1..).');
  if (!/^([0-9a-f]{2}:){15}[0-9a-f]{2}$/.test(cfg.fingerprint ?? '')) bad('API key fingerprint', 'fingerprint must look like 12:34:56:...:ef (16 hex pairs).');
  if (!OCID('(compartment|tenancy)').test(cfg.compartmentOcid ?? '')) bad('Compartment', 'compartmentOcid must be a compartment OCID (or the tenancy OCID for the root compartment).');
  if (!/^[a-z0-9]{1,64}$/.test(cfg.namespace ?? '')) bad('Object Storage namespace', 'namespace must be the tenancy Object Storage namespace (lowercase letters and digits).');
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(cfg.stateBucket ?? '')) bad('State bucket', 'stateBucket must name an existing Object Storage bucket.');
  if (Boolean(cfg.vaultOcid) !== Boolean(cfg.keyOcid)) {
    bad('Vault', 'Set both vaultOcid and keyOcid, or neither.');
  } else if (cfg.vaultOcid && (!OCID('vault').test(cfg.vaultOcid) || !OCID('key').test(cfg.keyOcid ?? ''))) {
    bad('Vault', 'vaultOcid must be a vault OCID and keyOcid a key OCID.');
  }
  const regions = target.allowedRegions.filter((r) => !REGION.test(r));
  if (regions.length) bad('Regions', `Use OCI region identifiers such as us-ashburn-1 or sa-saopaulo-1 (got ${regions.join(', ')}).`);
  return checks;
}

/** OCI service endpoints in the commercial realm (oc1). */
export function endpoints(region: string) {
  return {
    identity: `https://identity.${region}.oci.oraclecloud.com/20160918`,
    core: `https://iaas.${region}.oraclecloud.com/20160918`,
    loadBalancer: `https://iaas.${region}.oraclecloud.com/20170115`,
    containers: `https://compute-containers.${region}.oci.oraclecloud.com/20210415`,
    postgres: `https://postgresql.${region}.oci.oraclecloud.com/20220915`,
    cache: `https://redis.${region}.oci.oraclecloud.com/20220315`,
    secrets: `https://secrets.vaults.${region}.oci.oraclecloud.com/20190301`,
    objectStorage: `https://objectstorage.${region}.oraclecloud.com`,
  };
}

/** S3 compatibility endpoint of a namespace, used for OpenTofu state. */
export function s3Endpoint(namespace: string, region: string): string {
  return `https://${namespace}.compat.objectstorage.${region}.oraclecloud.com`;
}
