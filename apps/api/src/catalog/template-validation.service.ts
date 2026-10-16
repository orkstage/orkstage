// SPDX-License-Identifier: AGPL-3.0-only
import type { ValidationIssueDto } from '@orkstage/contracts';
import type { PrismaClient } from '@orkstage/database';
import { ALL_FEATURES, readTenantLimits, tenantFeatures, type TenantFeatures, type TenantLimits } from '@orkstage/domain';
import { compileInfrastructure } from '@orkstage/provisioning';
import { toCloudTarget } from '@orkstage/runtime';
import { validateTemplate } from '@orkstage/templates';
import { Inject, Injectable } from '@nestjs/common';
import { FeatureFlagsService } from '../common/feature-flags.service.js';
import { Adapters, PRISMA } from '../infra/infra.module.js';
import { chooseBindings } from './target-choice.js';

/**
 * The full template validation pipeline (spec §19), shared by publishing, stateless validation
 * (CLI/CI) and IaC import: schema → semantic → the limits and features of a tenant when one is
 * given (ADR 0007) → capability + security policy, compiled against shared cloud targets
 * compatible with each slot (the target per slot that leaves the fewest errors, see chooseBindings).
 * Callers check that the principal may read the tenant.
 */
@Injectable()
export class TemplateValidationService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly adapters: Adapters,
    private readonly flags: FeatureFlagsService,
  ) {}

  async validate(source: string, tenantId?: string): Promise<{ valid: boolean; issues: ValidationIssueDto[] }> {
    const base = validateTemplate(source);
    if (!base.valid || !base.template) return { valid: false, issues: base.issues };
    const template = base.template;
    const issues: ValidationIssueDto[] = [...base.issues];

    let limits: TenantLimits = {};
    let features: TenantFeatures = ALL_FEATURES;
    if (tenantId) {
      const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      limits = readTenantLimits(tenant.limits);
      features = tenantFeatures(await this.flags.forTenant(tenantId));
      issues.push(...validateTemplate(template, { limits, features }).issues.filter((i) => i.stage === 'limits'));
    }

    // Real providers before simulation, oldest first, so the choice below is stable.
    const targets = (await this.prisma.cloudTarget.findMany({ where: { status: 'ACTIVE', tenantId: null }, orderBy: { createdAt: 'asc' } })).sort(
      (a, b) => Number(a.provider === 'mock') - Number(b.provider === 'mock'),
    );
    const compile = (choice: Readonly<Record<string, (typeof targets)[number]>>) =>
      compileInfrastructure(
        {
          template,
          limits,
          features,
          organizationId: 'validation',
          tenant: { id: tenantId ?? 'validation', slug: 'validation' },
          instance: { id: 'validation', slug: 'validation', environment: template.metadata.nonProduction ? 'sandbox' : 'production' },
          bindings: Object.fromEntries(Object.entries(choice).map(([slot, t]) => [slot, { target: toCloudTarget(t), region: t.defaultRegion }])),
        },
        this.adapters.registry,
      );
    const blocking = (r: ReturnType<typeof compile>) => r.issues.filter((i) => (i.stage === 'capability' || i.stage === 'policy') && i.severity === 'error').length;
    const compiled = new Map<string, ReturnType<typeof compile>>();
    const compileOnce = (choice: Readonly<Record<string, (typeof targets)[number]>>) => {
      const key = template.spec.placements.map((s) => choice[s.name]!.id).join(',');
      if (!compiled.has(key)) compiled.set(key, compile(choice));
      return compiled.get(key)!;
    };
    // The template is valid when some compatible shared target can host each slot.
    const choice = chooseBindings(template.spec.placements, targets, (c) => blocking(compileOnce(c)));
    if (!choice) {
      issues.push({ stage: 'capability', severity: 'warning', code: 'NO_TARGET_FOR_SLOT', message: 'No shared cloud target is compatible with every placement slot; capability checks were partial.' });
    } else {
      issues.push(...compileOnce(choice).issues.filter((i) => i.stage === 'capability' || i.stage === 'policy'));
    }
    const unique = [...new Map(issues.map((i) => [`${i.code}:${i.message}`, i])).values()];
    return { valid: !unique.some((i) => i.severity === 'error'), issues: unique };
  }
}
