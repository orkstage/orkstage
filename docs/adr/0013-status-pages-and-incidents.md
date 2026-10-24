# ADR 0013: Health roll up, incidents and status pages

**Status:** accepted on October 23, 2026. Records the design built for orkstage-dev
`docs/open-items.md` items 8 and 16 (item 28 asked for this record).

## Context

A tenant's customers need to know whether the service is up without seeing how it is built. The
tenant's team needs to be told when something breaks, once, and not again for the same failure.
The platform already checks every resource's health; this ADR records how that becomes components,
incidents and pages.

## Decision

1. **Health rolls up by criticality.** Each resource is `HEALTHY`, `DEGRADED`, `UNHEALTHY`,
   `UNKNOWN` or `MAINTENANCE`. An instance is `UNHEALTHY` only when a critical resource is; a
   failing non critical resource (a cache, a queue by default) makes it `DEGRADED`. Templates mark
   criticality per resource.

2. **Customers see components, not resources.** Resources map to named components (API, Workers,
   Website, Database, Cache, Messaging, Storage, DNS and TLS); networks and registries get none.
   A component's state is the worst of its resources (an unhealthy critical resource is a major
   outage, a non critical one a partial outage) and `MAINTENANCE` while a window covers it. The
   worker keeps components current on every health tick; the tenant sets labels, order and which
   ones are hidden.

3. **Incidents come from rules, once per failure.** Platform rules (seeded) and tenant rules open
   an incident after a number of consecutive health failures, or when a metric crosses a threshold
   over a window. Each failure has a deduplication key (`health:<instance>:<resource>`,
   `metric:<rule>:<instance>:<resource>`), and the database allows one open incident per key. A
   cooldown stops a resolved incident from reopening at once; incidents resolve themselves when the
   resource recovers, unless a rule says otherwise. Resources under maintenance open nothing. The
   `AUTOMATED_INCIDENTS` flag turns automatic opening off without stopping resolution or
   notifications. People open, update and resolve incidents by hand as well.

4. **One status page per tenant, three visibilities.** `PRIVATE` (staff, owners and admins),
   `CUSTOMER_ONLY` (every member, the default) and `PUBLIC` (anyone at `/s/<slug>`, only while the
   `PUBLIC_STATUS_PAGES` flag allows it). A page that is not public looks exactly like a missing
   one.

5. **The public page shows names and states only.** Visible components, open incidents, those
   resolved in the last 14 days and maintenance, without instance internals. Titles and updates
   the system wrote are replaced by fixed wording ("Partial outage on <instance>"); text people
   wrote is shown as written, so they decide what customers read.

6. **Subscriptions confirm by email.** Members subscribe in one click; the public confirms by a
   link. The public subscribe answer is the same whether or not the address exists, routes are
   rate limited, tokens are stored hashed and every email carries a signed unsubscribe link.

7. **One event stream feeds every channel.** Health, incidents and maintenance emit events
   (`service.unhealthy`, `instance.degraded`, `incident.opened|updated|resolved`, `maintenance.*`)
   to the notification queue. Webhooks (signed JSON, Slack, Teams) go out first, with retries and
   automatic disabling of failing endpoints; then in app and email notifications to owners and
   admins, filtered by preferences and a per person email limit; then subscriber emails for
   incidents and maintenance.

## Consequences

- A customer facing page never leaks resource names, providers or regions, and the team controls
  every word written by a person.
- Uptime (30 days, per instance and component) appears in the customer overview, not on the public
  page.
- Known gaps: a rule with `autoResolve: false` keeps every health incident open, not only its own;
  housekeeping resolves orphaned health incidents but not metric ones; uptime does not exclude
  maintenance windows unless checks stored `MAINTENANCE`.
