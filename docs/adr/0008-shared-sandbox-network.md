# ADR 0008: A real shared network per cloud target for sandbox instances

**Status:** accepted on October 23, 2026 (owner decision; orkstage-dev `docs/open-items.md`,
item 25). Not built yet.

## Context

The `free-validation` template (profile A, free and trial use) declares
`network.strategy: shared`. No adapter or module reads it, so every instance creates a dedicated
network. On AWS that is a VPC with its subnets, route tables and, when private subnets need egress,
a NAT gateway: the NAT gateway alone costs more than a small sandbox workload, and the default quota
is five VPCs per region, so a target that hosts many sandbox instances runs out quickly.

Two options were on the table: build the shared network, or remove the option from the schema and
the template. The owner chose to build it.

## Decision

1. **One shared network per cloud target and region.** It is created on first use by an instance
   whose template asks for `network.strategy: shared`, and it belongs to the platform, not to any
   instance. A `SharedNetwork` record holds the target, provider, region, state and the outputs
   instances attach to (network id, subnet ids, the platform security group). It has its own
   OpenTofu state, `orkstage/shared-network/<target>/<region>.tfstate`, under the same rules as
   ADR 0005.
2. **The costly parts exist once.** The shared network carries the NAT gateway (or none, when the
   template allows public subnets only), endpoints and flow logs. An instance adds only what is its
   own: security groups, load balancer rules, and its workloads and data services.
3. **Isolation by security groups, default deny.** Each instance gets its own security groups.
   Traffic is allowed only between the instance's own groups and from its own load balancer. No
   instance may reference another instance's group, and the compiler refuses a template that tries.
   Data services stay in private subnets with no public address.
4. **Sandbox only.** A policy refuses `shared` for production environments. The plan says plainly
   that the instance shares a network with other sandbox instances of the same target.
5. **Lifecycle.** Creating the shared network takes a lock per target and region, so two first
   deployments never race. Instances attached to it are counted; it is destroyed only when none is
   left, after a grace period, and never while a deployment that uses it is running. Destroying an
   instance never touches the shared network.
6. **Providers.** An adapter declares a `sharedNetwork` capability. AWS and the simulation provider
   implement it first. On a provider without it, `shared` falls back to a dedicated network with a
   warning in the plan, so templates stay portable.
7. **Tenancy.** A shared network never spans targets, so it never spans the cloud accounts of
   different tenants. A platform target used by several tenants does share one network between
   them; that is why rule 3 and the sandbox only rule hold.

## Consequences

- Sandbox instances become much cheaper and stop consuming one VPC each.
- A mistake in security group rules has a larger blast radius than with dedicated networks; the
  compiler check in rule 3 and an adapter contract test (two instances on one shared network cannot
  reach each other) are required before the feature is turned on.
- Drift detection and the destroy guard must know that the shared network is not an instance
  resource.
- `network.strategy: shared` stays in the template schema. Until this is built, adapters keep
  creating a dedicated network.
