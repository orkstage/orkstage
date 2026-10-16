// SPDX-License-Identifier: AGPL-3.0-only
import type { ValidationIssueDto } from '@orkstage/contracts';
import type { PrismaClient } from '@orkstage/database';
import { DEFAULT_ENTITLEMENTS, type Entitlements, type PlanCode } from '@orkstage/domain';
import { compileInfrastructure } from '@orkstage/provisioning';
import { toCloudTarget } from '@orkstage/runtime';
import { validateTemplate } from '@orkstage/templates';
import { Inject, Injectable } from '@nestjs/common';
import { Adapters, PRISMA } from '../infra/infra.module.js';
import { chooseBindings } from './target-choice.js';

/**
 * The full template validation pipeline (spec §19), shared by publishing, stateless validation
 * (CLI/CI) and IaC import: schema → semantic → plan compatibility when a plan is asked for →
 * capability + security policy, compiled against shared cloud targets compatible with each slot
 * (the target per slot that leaves the fewest errors, see chooseBindings).
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

    // A plan asked for explicitly is checked by name; otherwise only capabilities and policies are,
    // under the most generous plan (templates no longer declare plans, ADR 0007).
    const plans = plansFilter
      ? (await this.prisma.plan.findMany({ where: { code: { in: plansFilter } } })).map((p) => ({ code: p.code as PlanCode, entitlements: p.entitlements as unknown as Entitlements, label: `[${p.code}] ` }))
      : [{ code: 'SCALE' as PlanCode, entitlements: DEFAULT_ENTITLEMENTS.SCALE, label: '' }];
    // Real providers before simulation, oldest first, so the choice below is stable.
    const targets = (await this.prisma.cloudTarget.findMany({ where: { status: 'ACTIVE', tenantId: null }, orderBy: { createdAt: 'asc' } })).sort(
      (a, b) => Number(a.provider === 'mock') - Number(b.provider === 'mock'),
    );

    for (const plan of plans) {
      const { entitlements } = plan;
      if (plansFilter) {
        const planReport = validateTemplate(template, { code: plan.code, entitlements });
        issues.push(...planReport.issues.filter((i) => i.stage === 'plan').map((i) => ({ ...i, message: `${plan.label}${i.message}` })));
      }

      const compile = (choice: Readonly<Record<string, (typeof targets)[number]>>) =>
        compileInfrastructure(
          {
            template,
            plan: { code: plan.code, entitlements },
            organizationId: 'validation',
            tenant: { id: 'validation', slug: 'validation' },
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
        continue;
      }
      const resolved = compileOnce(choice);
      issues.push(
        ...resolved.issues
          .filter((i) => i.stage === 'capability' || i.stage === 'policy')
          .map((i) => ({ ...i, message: `${plan.label}${i.message}` })),
      );
    }
    const unique = [...new Map(issues.map((i) => [`${i.code}:${i.message}`, i])).values()];
    return { valid: !unique.some((i) => i.severity === 'error'), issues: unique };
  }
}
