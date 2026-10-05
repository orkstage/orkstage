/**
 * Resolves secret references (`env://NAME`) to values at the moment of use. Values are never
 * stored in the platform database or returned by the API (spec §21, §74). A cloud secret
 * manager resolver (`aws-sm://...`) plugs in here later.
 */
export interface SecretResolver {
  resolve(ref: string): Promise<string>;
}

export class EnvSecretResolver implements SecretResolver {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(ref: string): Promise<string> {
    const match = /^env:\/\/([A-Z0-9_]+)$/.exec(ref);
    if (!match) throw new Error(`Unsupported secret reference scheme in "${ref.split('://')[0]}://…".`);
    const value = this.env[match[1]!];
    if (!value) throw new Error(`Secret ${match[1]} is not set.`);
    return value;
  }
}

/** Keys that suggest someone put a secret into non-secret target config. */
const SECRET_KEY = /secret|password|token|private.?key|access.?key|credential/i;

export function findSecretLikeKeys(config: Record<string, unknown>, prefix = ''): string[] {
  const found: string[] = [];
  for (const [k, v] of Object.entries(config)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (SECRET_KEY.test(k)) found.push(path);
    if (v && typeof v === 'object' && !Array.isArray(v)) found.push(...findSecretLikeKeys(v as Record<string, unknown>, path));
  }
  return found;
}
