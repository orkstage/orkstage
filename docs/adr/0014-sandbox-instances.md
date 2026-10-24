# ADR 0014: Sandbox instances without plans

**Status:** accepted on October 23, 2026. Records how free, trial and validation use works after
ADR 0007 removed plans (orkstage-dev `docs/open-items.md`, item 28, "sandbox profiles").

## Context

People try OrkStage, and operators offer trials, on small cloud budgets. The first design had
plans (`FREE`, `SANDBOX`, `STARTER` and so on) and a template "profile A" for free use. ADR 0007
replaced plans with tenant limits and feature flags, and gave the word "profile" to target
selection. What a sandbox is had to be stated again without either.

## Decision

1. **A sandbox is three independent settings, not a plan:**
   - **A template marked `nonProduction: true`**, usually tagged `sandbox` and `low cost`
     (`free-validation`, `sandbox-min-cost`, `portable-starter`). It asks for the smallest sizes
     (`micro` databases, a quarter vCPU), one availability zone, no NAT gateway, backups off or
     short.
   - **The `sandbox` environment** on the instance, which a profile (ADR 0007) routes to targets
     meant for it; the `target-environment` policy keeps sandbox instances on `sandbox` or `any`
     targets.
   - **Tenant limits** (`maxInstances`, vCPU, memory, database size, replicas, domains, backup
     retention, all optional) that cap what a trial tenant can create. The code ships no default
     numbers: the operator sets them.

2. **Non production templates never reach production.** The `non-production-template` policy fails
   the plan of such a template in the `production` environment and warns elsewhere. Only the
   platform policy can turn it off; tenant policies can only tighten. Template validation outside
   an instance checks these templates as sandbox.

3. **Sandbox is lighter only where production is stricter.** Approvals for risky changes, the
   recent backup check before a destroy and the `production-backups` policy apply to production
   only. A sandbox has no special code path of its own.

4. **The shared network belongs here.** `network.strategy: shared` in sandbox templates will use
   one network per target and region (ADR 0008) instead of a VPC and NAT gateway per instance.

5. **The word "profile" means target selection only.** `metadata.profile` in templates is
   deprecated (`PROFILE_DEPRECATED`); tags describe intent (`sandbox`, `low cost`, a size tag).

## Consequences

- An operator builds a free or trial offer from parts they already manage (a template tag, a
  profile for the sandbox environment, tenant limits, feature flags) and can change each one
  without a release.
- Every built in template carries a size tag, and a test checks that it fits the limits that tag
  stands for, so the small templates stay small.
- Until ADR 0008 is built, a `shared` network is a dedicated one, and a sandbox on AWS pays for its
  own NAT gateway when private subnets need egress.
