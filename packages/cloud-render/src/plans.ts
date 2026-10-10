/** Render compute plans for web and private services, cheapest first: [id, vCPU, memory MiB]. */
const SERVICE_PLANS: [string, number, number][] = [
  ['0.5c-512mb', 0.5, 512],
  ['1c-2g', 1, 2048],
  ['2c-4g', 2, 4096],
  ['2c-8g', 2, 8192],
  ['4c-8g', 4, 8192],
  ['2c-16g', 2, 16384],
  ['4c-16g', 4, 16384],
  ['8c-16g', 8, 16384],
  ['4c-32g', 4, 32768],
  ['8c-32g', 8, 32768],
  ['12c-24g', 12, 24576],
  ['12c-48g', 12, 49152],
  ['8c-64g', 8, 65536],
  ['12c-96g', 12, 98304],
];

/** Plan names from before August 2026 that Render still accepts and may report. */
const LEGACY_SERVICE_PLANS: Record<string, string> = {
  starter: '0.5c-512mb',
  standard: '1c-2g',
  pro: '2c-4g',
  pro_plus: '4c-8g',
  pro_max: '4c-16g',
  pro_ultra: '8c-32g',
};

/** Smallest service plan with at least the requested vCPU and memory. */
export function servicePlan(cpu: number, memoryMiB: number): string {
  const fit = SERVICE_PLANS.find(([, c, m]) => c >= cpu && m >= memoryMiB);
  return (fit ?? SERVICE_PLANS[SERVICE_PLANS.length - 1]!)[0];
}

/** True when two plan names mean the same instance type (legacy aliases included). */
export function samePlan(a: string | undefined, b: string): boolean {
  if (!a) return false;
  return (LEGACY_SERVICE_PLANS[a] ?? a) === (LEGACY_SERVICE_PLANS[b] ?? b);
}

/** Autoscaling and several instances are not offered on the free plan. */
export const planScales = (plan: string) => plan !== 'free';

/** Render Postgres plan by logical size. */
export const POSTGRES_PLANS: Record<string, string> = {
  micro: '0.1c-256mb',
  small: '0.5c-1g',
  medium: '1c-4g',
  large: '2c-8g',
  xlarge: '4c-16g',
};

/** High availability needs a plan with at least one full CPU and PostgreSQL 13 or later. */
export function postgresSupportsHa(plan: string, version: string): boolean {
  const cpu = Number(/^(\d+(?:\.\d+)?)c-/.exec(plan)?.[1] ?? 0);
  return cpu >= 1 && Number(version) >= 13;
}

/** Disk sizes are multiples of 5 GB. */
export const postgresDiskGb = (storageGiB: number) => Math.max(5, Math.ceil(storageGiB / 5) * 5);

/** Render Key Value plan by logical size. */
export const KEY_VALUE_PLANS: Record<string, string> = {
  micro: '256mb',
  small: '1g',
  medium: '5g',
  large: '10g',
};
