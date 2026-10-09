import type { ValidationIssueDto } from '@orkstage/contracts';
import type { PrismaClient } from '@orkstage/database';
import type { Entitlements, PlanCode } from '@orkstage/domain';
import { compileInfrastructure } from '@orkstage/provisioning';
import { toCloudTarget } from '@orkstage/runtime';
import { validateTemplate } from '@orkstage/templates';
import { Inject, Injectable } from '@nestjs/common';
import { Adapters, PRISMA } from '../infra/infra.module.js';

/**
 * The full template validation pipeline (spec §19), shared by publishing, stateless validation
 * (CLI/CI) and IaC import: schema → semantic → plan compatibility per declared plan →
 * capability + security policy, compiled against shared cloud targets compatible with each slot.
 */
@Injectable()
export class TemplateValidationService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly adapters: Adapters,
  ) {}

  async validate(source: string, plansFilter?: PlanCode[]): Promise<{ valid: boolean; issues: ValidationIssueDto[] }> {
    const base = validateTemplate(source);
    if (!base.valid || !base.template) return { valid: false, issues: base.issues };
    const template = base.template;
    const issues: ValidationIssueDto[] = [...base.issues];

    const plans = await this.prisma.plan.findMany({ where: { code: { in: plansFilter ?? template.spec.plans } } });
    const targets = await this.prisma.cloudTarget.findMany({ where: { status: 'ACTIVE', tenantId: null } });

    for (const plan of plans) {
      const entitlements = plan.entitlements as unknown as Entitlements;
      const planReport = validateTemplate(template, { code: plan.code as PlanCode, entitlements });
      issues.push(...planReport.issues.filter((i) => i.stage === 'plan').map((i) => ({ ...i, message: `[${plan.code}] ${i.message}` })));

      const bindings: Record<string, { target: ReturnType<typeof toCloudTarget>; region: string }> = {};
      for (const slot of template.spec.placements) {
        const t = targets.find((x) => slot.providers.length === 0 || slot.providers.includes(x.provider));
        if (t) bindings[slot.name] = { target: toCloudTarget(t), region: t.defaultRegion };
      }
      if (Object.keys(bindings).length < template.spec.placements.length) {
        issues.push({ stage: 'capability', severity: 'warning', code: 'NO_TARGET_FOR_SLOT', message: 'No shared cloud target is compatible with every placement slot; capability checks were partial.' });
        continue;
      }
      const resolved = compileInfrastructure(
        {
          template,
          plan: { code: plan.code as PlanCode, entitlements },
          organizationId: 'validation',
          tenant: { id: 'validation', slug: 'validation' },
          instance: { id: 'validation', slug: 'validation', environment: template.metadata.nonProduction ? 'sandbox' : 'production' },
          bindings,
        },
        this.adapters.registry,
      );
      issues.push(
        ...resolved.issues
          .filter((i) => i.stage === 'capability' || i.stage === 'policy')
          .map((i) => ({ ...i, message: `[${plan.code}] ${i.message}` })),
      );
    }
    const unique = [...new Map(issues.map((i) => [`${i.code}:${i.message}`, i])).values()];
    return { valid: !unique.some((i) => i.severity === 'error'), issues: unique };
  }
}
