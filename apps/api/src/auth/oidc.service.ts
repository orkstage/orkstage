// SPDX-License-Identifier: AGPL-3.0-only
import type { PrismaClient } from '@orkstage/database';
import type { PlatformConfig } from '@orkstage/runtime';
import { Inject, Injectable, Logger } from '@nestjs/common';
import * as client from 'openid-client';
import { CONFIG, PRISMA } from '../infra/infra.module.js';

export interface OidcProviderConfig {
  key: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecretEnv: string;
}

const KNOWN_NAMES: Record<string, string> = {
  ENTRA: 'Microsoft Entra ID',
  GOOGLE: 'Google',
  GITLAB: 'GitLab',
};

/**
 * OIDC identity providers, configured from environment (`OIDC_<KEY>_ISSUER`, `_CLIENT_ID`,
 * `_CLIENT_SECRET`) rather than hard-coded (spec §14). Adding Google or GitLab is configuration.
 * GitHub is OAuth-only (no OIDC for user login) and needs its own adapter later.
 */
@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private readonly discovered = new Map<string, Promise<client.Configuration>>();
  readonly providers: OidcProviderConfig[];

  constructor(
    @Inject(CONFIG) private readonly config: PlatformConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {
    this.providers = Object.keys(process.env)
      .map((k) => /^OIDC_([A-Z0-9]+)_ISSUER$/.exec(k)?.[1])
      .filter((k): k is string => Boolean(k))
      .filter((k) => process.env[`OIDC_${k}_CLIENT_ID`] && process.env[`OIDC_${k}_CLIENT_SECRET`] && !process.env[`OIDC_${k}_ISSUER`]!.includes('<'))
      .map((k) => ({
        key: k.toLowerCase(),
        name: KNOWN_NAMES[k] ?? k,
        issuer: process.env[`OIDC_${k}_ISSUER`]!,
        clientId: process.env[`OIDC_${k}_CLIENT_ID`]!,
        clientSecretEnv: `OIDC_${k}_CLIENT_SECRET`,
      }));
  }

  get(key: string): OidcProviderConfig | undefined {
    return this.providers.find((p) => p.key === key);
  }

  redirectUri(key: string): string {
    // Callbacks go through the web origin (Next.js proxies /api) so the session cookie is first-party.
    return `${this.config.WEB_PUBLIC_URL}/api/v1/auth/oidc/${key}/callback`;
  }

  async configuration(p: OidcProviderConfig): Promise<client.Configuration> {
    if (!this.discovered.has(p.key)) {
      const promise = client.discovery(new URL(p.issuer), p.clientId, process.env[p.clientSecretEnv]!);
      promise.catch((err) => {
        this.logger.warn({ provider: p.key, err: (err as Error).message }, 'OIDC discovery failed');
        this.discovered.delete(p.key);
      });
      this.discovered.set(p.key, promise);
    }
    return this.discovered.get(p.key)!;
  }

  /** Persisted provider row, needed to key external identities. */
  async providerRow(p: OidcProviderConfig) {
    return this.prisma.identityProvider.upsert({
      where: { key: p.key },
      update: { issuer: p.issuer, clientId: p.clientId, name: p.name },
      create: {
        key: p.key,
        kind: 'oidc',
        name: p.name,
        issuer: p.issuer,
        clientId: p.clientId,
        clientSecretRef: `env://${p.clientSecretEnv}`,
      },
    });
  }
}
