// SPDX-License-Identifier: AGPL-3.0-only
import { dependencyEnvironment, envKey, secretEnvironment, type ProviderContext, type ResourceRequest } from '@orkstage/cloud-core';
import type { RenderApi } from './api.js';
import { parseSecretRef, readRenderSecret } from './datastores.js';

/**
 * Environment variables a service or static site receives for its dependencies: connection
 * settings from their outputs, and credentials read through their `secret_ref`. A Render
 * datastore in the same workspace and region is wired with its internal connection string
 * when `privateNetwork` is set (services, not static sites, which are built and served
 * outside the private network). Values are for the Render API call only: never log them.
 */
export async function dependencyEnv(
  ctx: ProviderContext,
  api: RenderApi,
  ownerId: string,
  req: ResourceRequest,
  privateNetwork: boolean,
): Promise<Record<string, string>> {
  const { environment } = dependencyEnvironment(req.dependencyOutputs);
  const env: Record<string, string> = { ...environment };
  const unresolved: string[] = [];
  for (const [id, out] of Object.entries(req.dependencyOutputs)) {
    const ref = out.secret_ref ? String(out.secret_ref) : '';
    if (!ref) continue;
    const local = privateNetwork && parseSecretRef(ref) !== null && out.owner_id === ownerId && out.region === ctx.region && Boolean(out.internal_host);
    let fields: Record<string, string>;
    if (local) {
      const { internalUrl, ...rest } = await readRenderSecret(api, ref);
      fields = { ...rest, url: internalUrl ?? rest.url ?? '', host: String(out.internal_host) };
      env[`${envKey(id)}_HOST`] = String(out.internal_host);
    } else if (ctx.dependencySecret) {
      fields = await ctx.dependencySecret(id);
    } else {
      unresolved.push(id);
      continue;
    }
    Object.assign(env, secretEnvironment(id, fields));
  }
  if (unresolved.length) ctx.log?.('warn', `Credentials not wired for: ${unresolved.join(', ')} (no dependency secret reader in this context).`);
  return env;
}
