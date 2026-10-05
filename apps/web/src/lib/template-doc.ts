/**
 * Read-only view of a compiled template document (`TemplateVersionDto.document`). The contract
 * types it as an open record, so every field is read defensively.
 */
export interface PlacementSlot {
  name: string;
  description: string;
  providers: string[];
}

export interface TemplateVariable {
  name: string;
  description?: string;
  type: 'number' | 'string' | 'boolean';
  default: string | number | boolean;
  min?: number;
  max?: number;
  allowed?: string[];
  target?: string;
}

export interface TemplateDocView {
  name: string;
  displayName: string;
  description: string;
  nonProduction: boolean;
  profile: string | null;
  plans: string[];
  placements: PlacementSlot[];
  variables: TemplateVariable[];
  resourceCount: number;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

export function readTemplateDoc(document: Record<string, unknown> | null | undefined): TemplateDocView {
  const metadata = rec(document?.metadata);
  const spec = rec(document?.spec);
  const placements = arr(spec.placements).map((p) => {
    const r = rec(p);
    return { name: str(r.name, 'primary'), description: str(r.description), providers: arr(r.providers).map(String) };
  });
  const variables: TemplateVariable[] = arr(spec.variables).map((v) => {
    const r = rec(v);
    const type = r.type === 'number' || r.type === 'boolean' ? r.type : 'string';
    const def = r.default;
    return {
      name: str(r.name),
      description: typeof r.description === 'string' ? r.description : undefined,
      type,
      default: typeof def === 'number' || typeof def === 'boolean' || typeof def === 'string' ? def : type === 'number' ? 0 : type === 'boolean' ? false : '',
      min: typeof r.min === 'number' ? r.min : undefined,
      max: typeof r.max === 'number' ? r.max : undefined,
      allowed: Array.isArray(r.allowed) ? r.allowed.map(String) : undefined,
      target: typeof r.target === 'string' ? r.target : undefined,
    };
  });
  return {
    name: str(metadata.name),
    displayName: str(metadata.displayName),
    description: str(metadata.description),
    nonProduction: metadata.nonProduction === true,
    profile: typeof metadata.profile === 'string' ? metadata.profile : null,
    plans: arr(spec.plans).map(String),
    placements: placements.length > 0 ? placements : [{ name: 'primary', description: '', providers: [] }],
    variables: variables.filter((v) => v.name),
    resourceCount: arr(spec.resources).length,
  };
}

/** Returns an error message for a variable value, or null when valid. */
export function checkVariable(v: TemplateVariable, value: unknown): string | null {
  if (v.type === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) return 'Enter a number.';
    if (v.min !== undefined && value < v.min) return `Must be at least ${v.min}.`;
    if (v.max !== undefined && value > v.max) return `Must be at most ${v.max}.`;
    return null;
  }
  if (v.type === 'boolean') return typeof value === 'boolean' ? null : 'Choose true or false.';
  if (typeof value !== 'string') return 'Enter a value.';
  if (v.allowed && v.allowed.length > 0 && !v.allowed.includes(value)) return `Must be one of: ${v.allowed.join(', ')}.`;
  return null;
}
