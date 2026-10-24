// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Provider actions as one catalog (ADR 0009): what template triggers run and the only actions future
 * AI agents may propose. Adapters keep their own action names; a catalog action lists the provider
 * names it stands for, with the parameter names they use, so `service.scale` with `replicas` runs
 * AWS's `service.scale` and Render's `scale` with `numInstances` alike. Release actions
 * (`release.*`) are run by OrkStage itself as deployments (`platform`), except where a provider has
 * its own rollback.
 */
export type ActionRisk = 'safe' | 'disruptive' | 'destructive';

/** How a release reaches traffic (ADR 0009). `rolling` is every provider's default. */
export const RELEASE_STRATEGIES = ['rolling', 'canary', 'blueGreen'] as const;
export type ReleaseStrategy = (typeof RELEASE_STRATEGIES)[number];

/**
 * How a deployment is released and watched: the strategy, the share of traffic a canary gets, the
 * bake period during which an incident or an unhealthy service rolls it back, and whether that
 * rollback is automatic.
 */
export interface ReleaseSettings {
  strategy: ReleaseStrategy;
  trafficPercent: number;
  bakeMinutes: number;
  autoRollback: boolean;
}

export const DEFAULT_RELEASE: ReleaseSettings = { strategy: 'rolling', trafficPercent: 10, bakeMinutes: 0, autoRollback: true };

/**
 * Release settings from the template's `spec.release` with a deployment's own choices on top. A
 * canary or blue/green release is only as good as the watching after it, so it gets a 15 minute
 * bake period when none is set.
 */
export function releaseSettings(template?: Partial<ReleaseSettings>, override: Partial<ReleaseSettings> = {}): ReleaseSettings {
  const defined = (o: Partial<ReleaseSettings>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const merged = { ...DEFAULT_RELEASE, ...defined(template ?? {}), ...defined(override) } as ReleaseSettings;
  if (merged.strategy !== 'rolling' && merged.bakeMinutes === 0) merged.bakeMinutes = 15;
  return merged;
}
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
  /**
   * OrkStage runs it as a deployment of the instance (release strategies, rollback to an earlier
   * deployment) when no provider alias applies. Not offered on a schedule.
   */
  platform?: boolean;
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
    description: 'Return to an earlier deployment: by default the last one that stayed healthy through its bake period.',
    resourceTypes: [...SERVICE, ...FRONTEND],
    risk: 'disruptive',
    reversible: true,
    params: [
      {
        name: 'deployment',
        type: 'string',
        description: 'Deployment to return to: an OrkStage deployment id, or the provider\'s own on providers with their own rollback. The last verified deployment when empty.',
      },
    ],
    aliases: [
      { name: 'rollback', provider: 'render', params: { deployment: 'deployId' } },
      { name: 'rollback', provider: 'vercel', params: { deployment: 'deploymentId' } },
    ],
    platform: true,
  },
  {
    id: 'release.canary',
    description: 'Deploy the pending changes to a share of traffic, watch them for the bake period, then promote them or roll them back.',
    resourceTypes: SERVICE,
    risk: 'disruptive',
    reversible: true,
    params: [
      { name: 'trafficPercent', type: 'number', description: 'Share of traffic the new release gets during the bake period, 1 to 50 (10 when empty).' },
      { name: 'bakeMinutes', type: 'number', description: 'Minutes to watch before promoting, 1 to 240 (the template\'s, or 15, when empty).' },
    ],
    aliases: [],
    platform: true,
  },
  {
    id: 'release.blueGreen',
    description: 'Bring the pending changes up beside the running release, switch traffic once they are healthy, and keep the old release for the bake period.',
    resourceTypes: SERVICE,
    risk: 'disruptive',
    reversible: true,
    params: [{ name: 'bakeMinutes', type: 'number', description: 'Minutes to keep the old release before removing it, 1 to 240 (the template\'s, or 15, when empty).' }],
    aliases: [],
    platform: true,
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
