// SPDX-License-Identifier: AGPL-3.0-only
import { Resolver } from 'node:dns/promises';

/**
 * Asks public DNS for the TXT or CNAME records of a name (domain verification, open item 9). A
 * name without records answers an empty list; other failures throw. `DNS_RESOLVERS` (comma
 * separated addresses) picks the servers, so a private resolver never hides a customer's records.
 */
export async function publicDnsLookup(name: string, type: 'TXT' | 'CNAME', servers = process.env.DNS_RESOLVERS?.split(',').filter(Boolean)): Promise<string[]> {
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  if (servers?.length) resolver.setServers(servers);
  try {
    if (type === 'TXT') return (await resolver.resolveTxt(name)).map((parts) => parts.join(''));
    return await resolver.resolveCname(name);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENODATA' || code === 'ENOTFOUND') return [];
    throw err;
  }
}
