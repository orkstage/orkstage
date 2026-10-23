// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider actions as one catalog (ADR 0009): what template triggers run and the only actions future
 * AI agents may propose. Adapters keep their own action names; a catalog action lists the provider
 * names it stands for, with the parameter names they use, so `service.scale` with `replicas` runs
 * AWS's `service.scale` and Render's `scale` with `numInstances` alike. Release strategies (canary,
 * blue/green) come in a second round; `release.rollback` already maps the providers that have it.
 */
export type ActionRisk = 'safe' | 'disruptive' | 'destructive';
export type ActionRole = 'CustomerDeveloper' | 'CustomerAdmin' | 'CustomerOwner';

export interface CatalogParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  description: string;
}

export interface ActionAlias {
  /** The provider's own action name. */
  name: string;
  /** Only this provider uses the name this way; any provider when absent. */
  provider?: string;
  /** Catalog parameter name to the provider's, where they differ. */
  params?: Readonly<Record<string, string>>;
}

export interface CatalogAction {
  id: string;
  description: string;
  /** Template resource types it applies to. */
  resourceTypes: readonly string[];
  risk: ActionRisk;
  /** Whether its effect can be undone (a snapshot can be deleted, a reboot cannot be taken back). */
  reversible: boolean;
  params: readonly CatalogParam[];
  aliases: readonly ActionAlias[];
}

const SERVICE = ['compute.container-service'];
const FRONTEND = ['web.frontend'];
const DATABASE = ['database.postgresql'];

export const ACTION_CATALOG: readonly CatalogAction[] = [
  {
    id: 'service.restart',
    description: 'Start fresh instances of the running release; old ones drain as new ones turn healthy.',
    resourceTypes: SERVICE,
    risk: 'safe',
    reversible: false,
    params: [],
    aliases: [{ name: 'restart' }],
  },
  {
    id: 'service.redeploy',
    description: 'Start a new rollout of the service or frontend from its source.',
    resourceTypes: [...SERVICE, ...FRONTEND],
    risk: 'safe',
    reversible: false,
    params: [],
    aliases: [{ name: 'redeploy' }],
  },
  {
    id: 'service.scale',
    description: 'Set the number of running instances, within the template autoscaling bounds and the tenant limits.',
    resourceTypes: SERVICE,
    risk: 'disruptive',
    reversible: true,
    params: [{ name: 'replicas', type: 'number', required: true, description: 'Instances to run.' }],
    aliases: [{ name: 'scale', provider: 'render', params: { replicas: 'numInstances' } }],
  },
  {
    id: 'cdn.invalidate',
    description: 'Drop cached responses so the next requests reach the origin.',
    resourceTypes: FRONTEND,
    risk: 'safe',
    reversible: false,
    params: [],
    aliases: [{ name: 'purge-cache', provider: 'vercel' }],
  },
  {
    id: 'database.reboot',
    description: 'Reboot the database server: connections drop for a short while.',
    resourceTypes: DATABASE,
    risk: 'disruptive',
    reversible: false,
    params: [],
    aliases: [{ name: 'restart' }],
  },
  {
    id: 'database.snapshot',
    description: 'Take an on demand backup, kept until deleted.',
    resourceTypes: DATABASE,
    risk: 'safe',
    reversible: true,
    params: [],
    aliases: [{ name: 'backup' }],
  },
  {
    id: 'database.restore',
    description: 'Restore the database to a point in time as a new database next to it; the original stays as it is.',
    resourceTypes: DATABASE,
    risk: 'safe',
    reversible: true,
    params: [{ name: 'pointInTime', type: 'string', description: 'ISO time within the restore window; the latest restorable time when empty.' }],
    aliases: [{ name: 'restore' }],
  },
  {
    id: 'release.rollback',
    description: 'Return the service or frontend to an earlier deployment.',
    resourceTypes: [...SERVICE, ...FRONTEND],
    risk: 'disruptive',
    reversible: true,
    params: [{ name: 'deployment', type: 'string', description: 'Provider deployment id to return to; the provider default when empty.' }],
    aliases: [
      { name: 'rollback', provider: 'render', params: { deployment: 'deployId' } },
      { name: 'rollback', provider: 'vercel', params: { deployment: 'deploymentId' } },
    ],
  },
];

const BY_ID = new Map(ACTION_CATALOG.map((a) => [a.id, a]));

export function catalogAction(id: string): CatalogAction | undefined {
  return BY_ID.get(id);
}

/**
 * The catalog action a provider action name stands for on one resource type, with the alias that
 * matched (undefined when the name is the catalog id itself).
 */
export function catalogActionFor(name: string, resourceType: string, provider: string): { action: CatalogAction; alias?: ActionAlias } | undefined {
  for (const action of ACTION_CATALOG) {
    if (!action.resourceTypes.includes(resourceType)) continue;
    if (action.id === name) return { action };
    const alias = action.aliases.find((a) => a.name === name && (!a.provider || a.provider === provider));
    if (alias) return { action, alias };
  }
  return undefined;
}

/**
 * Minimum tenant role to run an action (ADR 0009): `safe` actions developers, anything else admins.
 * Provider specific actions outside the catalog count as disruptive.
 */
export function minimumRoleFor(risk: ActionRisk | undefined): ActionRole {
  return risk === 'safe' ? 'CustomerDeveloper' : 'CustomerAdmin';
}

const RANK: Record<ActionRole | 'CustomerViewer', number> = { CustomerViewer: 0, CustomerDeveloper: 1, CustomerAdmin: 2, CustomerOwner: 3 };

/** The stricter of two roles: a template may raise an action's role, never lower it. */
export function stricterRole(a: ActionRole, b: ActionRole | undefined): ActionRole {
  return b && RANK[b] > RANK[a] ? b : a;
}

export function roleAtLeast(role: string, minimum: ActionRole): boolean {
  return (RANK[role as ActionRole] ?? -1) >= RANK[minimum];
}
