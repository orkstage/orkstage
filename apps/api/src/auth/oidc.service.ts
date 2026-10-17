// SPDX-License-Identifier: AGPL-3.0-only
import type { PrismaClient } from '@orkstage/database';
import type { PlatformConfig } from '@orkstage/runtime';
import { Inject, Injectable, Logger } from '@nestjs/common';
import * as client from 'openid-client';
import { CONFIG, PRISMA } from '../infra/infra.module.js';
import { githubIdentity, type ExternalIdentityClaims } from './identity-linker.js';

export interface OidcProviderConfig {
  key: string;
  name: string;
  /** `oidc`: ID token with a verified signature. `oauth2`: GitHub, which has no ID tokens. */
  kind: 'oidc' | 'oauth2';
  issuer: string;
  clientId: string;
  clientSecretEnv: string;
  /** OAuth 2 only: base URL of the provider's REST API. */
  apiUrl?: string;
}

const KNOWN_NAMES: Record<string, string> = {
  ENTRA: 'Microsoft Entra ID',
  GOOGLE: 'Google',
  GITLAB: 'GitLab',
};

/**
 * Identity providers, configured from environment rather than hard-coded (spec §14):
 * - OIDC: `OIDC_<KEY>_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET` (Entra, Google, GitLab, any other).
 *   ID token signatures are checked against the provider's published keys.
 * - GitHub (OAuth 2, no ID tokens): `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, and
 *   `OAUTH_GITHUB_URL` for GitHub Enterprise Server.
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
        kind: 'oidc' as const,
        issuer: process.env[`OIDC_${k}_ISSUER`]!,
        clientId: process.env[`OIDC_${k}_CLIENT_ID`]!,
        clientSecretEnv: `OIDC_${k}_CLIENT_SECRET`,
      }));
    if (process.env.OAUTH_GITHUB_CLIENT_ID && process.env.OAUTH_GITHUB_CLIENT_SECRET && !this.providers.some((p) => p.key === 'github')) {
      const url = (process.env.OAUTH_GITHUB_URL ?? 'https://github.com').replace(/\/+$/, '');
      this.providers.push({
        key: 'github',
        name: 'GitHub',
        kind: 'oauth2',
        issuer: url,
        clientId: process.env.OAUTH_GITHUB_CLIENT_ID,
        clientSecretEnv: 'OAUTH_GITHUB_CLIENT_SECRET',
        apiUrl: url === 'https://github.com' ? 'https://api.github.com' : `${url}/api/v3`,
      });
    }
  }

  get(key: string): OidcProviderConfig | undefined {
    return this.providers.find((p) => p.key === key);
  }

  redirectUri(key: string): string {
    // Callbacks go through the web origin (Next.js proxies /api) so the session cookie is first-party.
    return `${this.config.WEB_PUBLIC_URL}/api/v1/auth/oidc/${key}/callback`;
  }

  async configuration(p: OidcProviderConfig): Promise<client.Configuration> {
    if (p.kind === 'oauth2') {
      return new client.Configuration(
        { issuer: p.issuer, authorization_endpoint: `${p.issuer}/login/oauth/authorize`, token_endpoint: `${p.issuer}/login/oauth/access_token` },
        p.clientId,
        process.env[p.clientSecretEnv]!,
      );
    }
    if (!this.discovered.has(p.key)) {
      const promise = client.discovery(new URL(p.issuer), p.clientId, process.env[p.clientSecretEnv]!).then((cfg) => {
        // Verify each ID token's signature against the provider's published keys (JWKS), not
        // only the TLS of the back channel exchange.
        client.enableNonRepudiationChecks(cfg);
        return cfg;
      });
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
      update: { issuer: p.issuer, clientId: p.clientId, name: p.name, kind: p.kind },
      create: {
        key: p.key,
        kind: p.kind,
        name: p.name,
        issuer: p.issuer,
        clientId: p.clientId,
        clientSecretRef: `env://${p.clientSecretEnv}`,
        scopes: p.kind === 'oauth2' ? ['read:user', 'user:email'] : ['openid', 'email', 'profile'],
      },
    });
  }

  /** GitHub: the person and their emails, with the access token of this sign in only. */
  async githubIdentity(p: OidcProviderConfig, accessToken: string): Promise<ExternalIdentityClaims> {
    const get = async <T>(path: string): Promise<T> => {
      const res = await fetch(`${p.apiUrl}${path}`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'OrkStage', 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
      return (await res.json()) as T;
    };
    const [user, emails] = await Promise.all([
      get<{ id: number; login: string; name: string | null }>('/user'),
      get<{ email: string; primary: boolean; verified: boolean }[]>('/user/emails'),
    ]);
    return githubIdentity(user, emails);
  }
}
