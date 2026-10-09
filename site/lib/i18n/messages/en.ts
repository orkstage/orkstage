/**
 * English copy of the marketing pages (landing, 404, language UI, metadata, OG image).
 * `pt-br.ts` must have exactly the same keys: the type below enforces it at typecheck and
 * `pnpm check:i18n` compares both dictionaries and checks the writing rules on every value.
 * Text between backticks renders as inline code (see components/rich.tsx).
 * Product output shown in the landing artifacts (terminal, plan, events) is code and stays in
 * components/landing/artifacts.tsx, untranslated.
 */
export const en = {
  meta: {
    title: 'OrkStage: open source multicloud control plane',
    description:
      'Describe an environment once, place each resource on the cloud that fits it, review plan, policies and cost, then deploy with OpenTofu. Open source.',
    ogImageAlt: 'OrkStage: command every stage of your cloud. Open source multicloud control plane.',
    notFoundTitle: 'Page not found',
    notFoundDescription: 'This address does not match any page on orkstage.io. The documentation and the home page link to everything on the site.',
  },
  og: {
    headline: 'Command every stage of your cloud.',
    subline: 'Open source multicloud control plane. Template, plan, deploy, operate.',
    footer: 'AWS, Azure, OCI. Raw scale. Precise control.',
  },
  common: {
    skipToContent: 'Skip to content',
    homeLabel: 'OrkStage home',
    mainNav: 'Main',
    footerNav: 'Footer',
    docs: 'Docs',
    api: 'API',
    github: 'GitHub',
    getStarted: 'Get started',
    docsLanguageNote: 'The documentation is written in English.',
  },
  language: {
    label: 'Language',
    suggestion: 'This page is also available in English.',
    suggestionAction: 'Read in English',
    dismiss: 'Dismiss',
    suggestionRegion: 'Language suggestion',
  },
  tags: {
    available: 'available',
    planned: 'planned',
    preview: 'Preview',
    approximate: 'approximate',
    cliPreview: 'CLI preview',
    status: 'Status',
  },
  hero: {
    eyebrow: 'Open source multicloud control plane',
    title: 'Command every stage of your cloud.',
    lead: 'Write the environment once: services, Postgres, cache, queue, storage, ingress and DNS. Bind each resource to the account and region that fits it. Review the plan, the policy results and an approximate monthly cost. Then OrkStage applies it with OpenTofu and keeps watching it.',
    primary: 'Get started',
    secondary: 'View the source on GitHub',
    facts: {
      licenseLabel: 'License',
      licenseValue: 'AGPL-3.0',
      runsLabel: 'Hosting',
      runsValue: 'Your infrastructure',
      engineLabel: 'Engine',
      engineValue: 'OpenTofu',
    },
    terminalLabel: 'Terminal session: ork scan, ork template push and ork deploy --wait',
    terminalNote: 'Output shortened. The ork CLI builds from source today; signed binaries are not released yet.',
  },
  how: {
    label: 'How it works',
    title: 'Template, plan, deploy, observe. Every step leaves an artifact you can read.',
    intro: 'Nothing touches a cloud until someone reviews the plan. The worker applies exactly the plan you approved, resource by resource.',
    steps: {
      template: {
        title: 'Template',
        text: 'A YAML file describes intent without naming a provider: an API with two replicas, a Postgres database replicated across zones, versioned storage. Placement slots list the clouds each part may use. Write it once, deploy it many times.',
        artifactLabel: 'Template excerpt',
      },
      plan: {
        title: 'Plan',
        text: 'The compiler maps every resource to a concrete cloud service, names and tags it, orders the dependency graph and picks a connectivity strategy for each link. The plan is grouped by provider, target and region.',
        artifactLabel: 'Deployment plan as text',
      },
      deploy: {
        title: 'Deploy',
        text: 'OpenTofu runs the dependency graph asynchronously, with a separate state for each resource. Independent branches run in parallel and transient failures retry. When a resource fails, only the resources that depend on it are skipped. Before it changes existing resources, the worker runs a real `tofu plan`, and a delete or replace in production waits for approval.',
        artifactLabel: 'Deployment events',
      },
      observe: {
        title: 'Observe',
        text: 'Health checks roll up to the instance and to a private status page. When a critical component turns unhealthy, OrkStage opens an incident, notifies the owners in the console and by email, and resolves the incident when health returns.',
      },
    },
  },
  placement: {
    label: 'Multicloud placement',
    title: 'Place every resource where it belongs.',
    intro:
      'You choose placement per resource, not per environment. Bind the `data` slot to an Azure subscription and the same template becomes multicloud. Bind every slot to one AWS account and it runs on a single cloud again. The template does not change.',
    topologyTitle: 'Topology of one instance across AWS, Azure and OCI',
    topologyDescription:
      'The AWS slot primary holds dns, ingress, api, worker, registry and network. The Azure slot data holds the PostgreSQL database. The OCI slot storage holds object storage. The api and worker reach the database over TLS with a source allowlist; the api reaches storage over TLS.',
    linksTitle: 'How two resources reach each other',
    linksIntro: 'The compiler chooses the strategy and shows it in the plan. Nothing is provisioned without you seeing it.',
    strategies: {
      privateNetwork: 'Same account and region.',
      privatePeering: 'Same provider, different account or region. Peering costs apply.',
      publicTls: 'Across clouds in `private-preferred` mode: TLS on a public endpoint, with the source on an allowlist.',
      unsatisfiable: 'Across clouds in `private-required` mode. The plan fails until you change the mode or the placement.',
    },
    status:
      'AWS provisioning is real (OpenTofu, verified against MiniStack). Azure and OCI run on a deterministic simulator today and are labeled as simulated everywhere. Their adapters are on the roadmap.',
  },
  trust: {
    label: 'Governance',
    title: 'Plans you can check before anything is created.',
    intro: 'Policies, cost and approvals are part of the plan, not a meeting after the fact. Custom templates go through the same checks and cannot skip them.',
    policiesTitle: 'Policies, with every result shown',
    policiesNote: 'Also checked: templates marked as not for production, replica limits and a monthly budget.',
    costTitle: 'Cost estimate',
    costNote: 'List prices from a static catalog, on demand, per month. An estimate, never an invoice.',
    costCaption: 'Approximate monthly cost per resource for the multicloud reference instance',
    costResource: 'resource',
    costPlacedOn: 'placed on',
    costPerMonth: 'USD/mo',
    costTotal: 'total, approximate',
    approvalsTitle: 'Approvals where they matter',
    approvalsText:
      'Production changes that delete, replace or touch a database stop at `AWAITING_APPROVAL`. The worker also reads the real provider plan, so a replacement that the platform diff cannot see still asks for approval. Everything else proceeds, and the record says why no approval was needed.',
    auditTitle: 'An audit log nobody can edit',
    auditText:
      'Every change is an audit event with the actor, a correlation id and the diff. Actions taken with an API key name the key. A Postgres trigger rejects updates and deletes on the table, so history stays the way it happened.',
  },
  operate: {
    label: 'Day two',
    title: 'Built for the people who carry the pager.',
    intro: "From a failing health check to an email in the owner's inbox, every link in the chain is automatic and visible.",
    health: {
      title: 'Health',
      text: 'Each tick reads the actual state from the provider again and rolls component health up to the instance. A critical component takes the instance down; the others only degrade it.',
    },
    incidents: {
      title: 'Incidents',
      text: 'Alert rules are stored as data. They open one incident per resource, with deduplication and a cooldown, and resolve it when health returns.',
    },
    statusPage: {
      title: 'Status page',
      text: 'Each tenant gets a private status page that maps resources to the components your customers see: API, workers, database.',
    },
    notifications: {
      title: 'Notifications',
      text: 'Tenant owners, admins and platform staff get notices in the console and by email. Signed webhooks carry the same events to your own systems.',
      meta: 'console · email · webhooks',
    },
    drift:
      'If someone deletes a resource by hand in the provider console, a live probe notices it is gone, verification fails right away instead of waiting, and the next deploy creates it again.',
  },
  repo: {
    label: 'From your repo',
    title: 'Start from the infrastructure you already have.',
    intro:
      'The scan engine reads Terraform and OpenTofu, CloudFormation and SAM, Kubernetes and Helm, Docker Compose, Dockerfiles and package manifests. It proposes an OrkStage template and shows the evidence for every resource. Import the report through the API or the console, and review the draft before you publish it.',
    sessionLabel: 'Terminal session: ork import',
    note: 'Your code never leaves your machine: the CLI scans locally and sends only the report.',
    importTitle: 'IaC import',
    importText:
      '`POST /imports` accepts a ScanReport, or files that the server scans with the same engine compiled to WebAssembly. Unmapped resources and warnings are listed, not hidden.',
    integrationsTitle: 'API keys, webhooks, CI intake',
    integrationsText:
      'Scoped keys that never exceed the role of their owner, webhooks signed with HMAC and protected against replay, and immutable image versions published from CI by digest.',
    cliTitle: 'The ork CLI',
    cliText:
      '`init`, `scan`, `template validate`, `push` and `diff`, `import`, `deploy --wait`, `status`, `logs` and `destroy`. JSON output and stable exit codes for CI. Build it from source until signed binaries ship.',
  },
  editions: {
    label: 'Open core',
    title: 'Open source at the core. Enterprise where organizations need it.',
    intro:
      'Community is the complete control plane under AGPL-3.0, enough to run production on AWS. Enterprise adds features for large organizations and compliance under a commercial license, turned on by a license key that works offline. Same codebase, same images.',
    caption: 'Community and Enterprise editions compared',
    area: 'Area',
    community: 'Community',
    communityNote: 'AGPL-3.0, free',
    enterprise: 'Enterprise',
    enterpriseNote: 'commercial, `ee/`',
    rows: {
      controlPlane: {
        area: 'Control plane',
        community: 'Templates, visual builder, placement, plans and policies, cost estimate, deployments, health, incidents, status pages, notifications',
        enterprisePlanned: 'Policy packs and custom policy authoring',
      },
      provisioning: {
        area: 'Provisioning',
        community: 'AWS through OpenTofu, simulated Azure and OCI, dependency graph, retries, drift flagging',
        enterprisePlanned: 'Private connectivity provisioning (VPN, interconnect)',
      },
      identity: {
        area: 'Identity',
        community: 'Dev login, OIDC (Microsoft Entra; Google and GitLab by configuration)',
        enterprisePlanned: 'SAML 2.0 SSO and SCIM provisioning',
      },
      governance: {
        area: 'Governance',
        community: 'Seven built in roles, approvals for high risk production changes, append only audit log',
        enterpriseAvailable: 'Audit log export (NDJSON, CSV)',
        enterprisePlanned: 'Custom roles, approvals in several steps, retention policies',
      },
      organizations: {
        area: 'Organizations',
        community: 'One organization, many tenants',
        enterprisePlanned: 'Multiple organizations, status pages under your own brand',
      },
      integrations: {
        area: 'Integrations',
        community: 'API keys, webhooks, CI intake, IaC import, ork CLI (preview)',
        enterprisePlanned: 'Change management with ServiceNow or Jira, alerts to PagerDuty or Opsgenie',
      },
      support: {
        area: 'Support',
        community: 'GitHub Discussions',
        enterprisePlanned: 'Priority support with an SLA',
      },
    },
    compare: 'Compare the editions in full',
    contact: 'Talk to us about Enterprise',
  },
  selfHost: {
    label: 'Run it yourself',
    title: 'The whole platform with one Compose command.',
    intro: 'You only need Docker. The Compose file starts the API, worker, console, Postgres, Redis, Mailpit, the OpenTofu runner image and MiniStack for local AWS.',
    windowMeta: 'local evaluation',
    commandLabel: 'Docker Compose command',
    note: 'This stack runs in development mode, with the dev login and the Docker socket mounted. Use it to evaluate OrkStage on your machine, not in production.',
    cta: 'Read the quickstart',
  },
  footer: {
    tagline: 'Command every stage of your cloud. Raw scale. Precise control.',
    product: 'Product',
    documentation: 'Documentation',
    quickstart: 'Quickstart',
    apiReference: 'API reference',
    project: 'Project',
    license: 'License (AGPL-3.0)',
    security: 'Security',
    company: 'Company',
    enterprise: 'Enterprise',
    contact: 'Contact',
    legal:
      'OrkStage is open source under the GNU AGPL-3.0. Directories named `ee/` are under the OrkStage Enterprise License. OrkStage and the OrkStage logo are trademarks of the OrkStage project.',
  },
  notFound: {
    title: 'This stage does not exist.',
    text: 'The page moved or never existed. Start from the documentation or the home page.',
    docs: 'Read the documentation',
    home: 'Go to the home page',
  },
};

export type Messages = typeof en;
