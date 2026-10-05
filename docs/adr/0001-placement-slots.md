# ADR 0001 — Per-resource placement through template slots

**Status:** accepted (2026-10-04)

## Context

The spec requires one logical instance to span providers/accounts/regions (§42) and also a
"simpler AWS-only variant of the same logical template". The spec's example embeds
`providerTarget: aws-prod` in the template, but templates are shared across tenants, and each
tenant has its own accounts.

## Decision

Templates declare **placement slots** (`placements: [{name, providers}]`) and each resource
names a slot. Instances bind each slot to `{targetId, region}`. Provider choice, account and
region are therefore instance data; the template stays reusable and provider-neutral. A slot's
`providers` list constrains which targets are acceptable (e.g. `data: [aws, azure]`).

## Consequences

- Same template → single-cloud or multi-cloud by binding only.
- Compiler validates bindings per resource (slot allowed providers, capability, region gaps).
- Networks bind implicitly to resources in the same slot only, so a cross-cloud database does
  not depend on the AWS VPC.
- An "explicit placement strategy" with recommendations (§42.13) can later suggest bindings
  without changing the model.
