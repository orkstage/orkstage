# ADR 0001: Placement per resource through template slots

**Status:** accepted on October 4, 2026

## Context

The specification requires one logical instance to span providers, accounts and regions (§42),
and also a "simpler AWS only variant of the same logical template". The specification's example
embeds `providerTarget: aws-prod` in the template, but templates are shared across tenants, and
each tenant has its own accounts.

## Decision

Templates declare **placement slots** (`placements: [{name, providers}]`) and each resource names
a slot. Instances bind each slot to `{targetId, region}`. Provider, account and region are
therefore instance data, and the template stays reusable and provider neutral. A slot's
`providers` list limits which targets are acceptable (for example `data: [aws, azure]`).

## Consequences

- The same template becomes single cloud or multicloud through its bindings alone.
- The compiler validates bindings per resource: providers allowed by the slot, capabilities,
  regional gaps.
- Networks bind implicitly only to resources in the same slot, so a database on another cloud
  does not depend on the AWS VPC.
- An "explicit placement strategy" with recommendations (§42.13) can later suggest bindings
  without changing the model.
