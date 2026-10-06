import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { DeployEvents, PlanText, TemplateExcerpt, TerminalSession, Window } from '@/components/landing/artifacts';
import { Topology } from '@/components/landing/topology';
import { Logo } from '@/components/logo';
import { appName, links, siteDescription, slogan } from '@/lib/shared';

export const metadata: Metadata = {
  title: { absolute: `${appName}: ${slogan}` },
  description: siteDescription,
  alternates: { canonical: '/' },
};

/* ── primitives ─────────────────────────────────────────────────────────────────────────── */

function Section({ id, label, title, intro, children, className = '' }: { id: string; label: string; title: ReactNode; intro?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={`border-t border-hairline ${className}`}>
      <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6 md:py-28">
        <div className="grid gap-x-12 gap-y-6 md:grid-cols-12">
          <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-ink-subtle md:col-span-3 md:pt-2">{label}</p>
          <div className="md:col-span-9">
            <h2 id={`${id}-title`} className="max-w-[22ch] font-display text-3xl font-semibold leading-[1.08] tracking-[-0.02em] text-ink sm:text-[2.6rem]">
              {title}
            </h2>
            {intro ? <div className="mt-5 max-w-[62ch] text-[17px] leading-relaxed text-ink-muted">{intro}</div> : null}
          </div>
        </div>
        <div className="mt-14">{children}</div>
      </div>
    </section>
  );
}

function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex h-11 items-center rounded-md bg-mint px-5 text-[15px] font-semibold text-obsidian transition-colors hover:bg-[#33f5af] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mint"
    >
      {children}
    </Link>
  );
}

function SecondaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="inline-flex h-11 items-center gap-2 rounded-md border border-hairline-strong px-5 text-[15px] font-medium text-ink transition-colors hover:border-ink-subtle hover:bg-slate-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mint"
    >
      {children}
    </a>
  );
}

function Tag({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'mint' | 'forge' | 'info' }) {
  const tones = {
    muted: 'border-hairline-strong text-ink-muted',
    mint: 'border-mint/40 text-mint',
    forge: 'border-forge/50 text-forge',
    info: 'border-info/50 text-info',
  } as const;
  return <span className={`inline-flex items-center rounded border px-1.5 py-px font-mono text-[10.5px] uppercase tracking-wider ${tones[tone]}`}>{children}</span>;
}

function Check() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="mt-1 size-3.5 shrink-0 text-mint">
      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── page ───────────────────────────────────────────────────────────────────────────────── */

export default function HomePage() {
  return (
    <div className="bg-obsidian text-ink [color-scheme:dark]">
      <a href="#main" className="sr-only z-50 rounded bg-mint px-3 py-2 font-medium text-obsidian focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-hairline bg-obsidian/90 backdrop-blur supports-[backdrop-filter]:bg-obsidian/75">
        <nav aria-label="Main" className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" aria-label="OrkStage home" className="rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-mint">
            <Logo height={32} forceDark />
          </Link>
          <ul className="flex items-center gap-1 text-[14px] sm:gap-2">
            <li className="hidden sm:block">
              <Link href="/docs/" className="rounded px-3 py-2 text-ink-muted hover:text-ink">
                Docs
              </Link>
            </li>
            <li className="hidden sm:block">
              <Link href="/docs/developer/api-reference/" className="rounded px-3 py-2 text-ink-muted hover:text-ink">
                API
              </Link>
            </li>
            <li>
              <a href={links.github} className="rounded px-3 py-2 text-ink-muted hover:text-ink">
                GitHub
              </a>
            </li>
            <li>
              <Link href={links.quickstart} className="ml-1 inline-flex h-9 items-center rounded-md bg-mint px-3.5 font-semibold text-obsidian hover:bg-[#33f5af]">
                Get started
              </Link>
            </li>
          </ul>
        </nav>
      </header>

      <main id="main">
        {/* Hero */}
        <section aria-labelledby="hero-title" className="bg-grid relative">
          <div className="mx-auto grid max-w-[1200px] gap-12 px-4 pb-20 pt-16 sm:px-6 md:pt-24 lg:grid-cols-12 lg:gap-10 lg:pb-28">
            <div className="lg:col-span-6 lg:pt-6">
              <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-ink-subtle">Open-source multi-cloud control plane</p>
              <h1 id="hero-title" className="mt-5 font-display text-[2.6rem] font-semibold leading-[1.02] tracking-[-0.03em] text-ink sm:text-6xl">
                Command every stage of your cloud.
              </h1>
              <p className="mt-6 max-w-[52ch] text-lg leading-relaxed text-ink-muted">
                Write the environment once: services, Postgres, cache, queue, storage, ingress, DNS. Bind each resource to the account and region that fit it. Review the
                plan, the policies and an approximate monthly cost, then let OrkStage apply it with OpenTofu and keep watch.
              </p>
              <div className="mt-9 flex flex-wrap gap-3">
                <PrimaryLink href={links.quickstart}>Get started</PrimaryLink>
                <SecondaryLink href={links.github}>View on GitHub</SecondaryLink>
              </div>
              <dl className="mt-10 grid max-w-md grid-cols-3 gap-px overflow-hidden rounded-md border border-hairline bg-hairline text-[13px]">
                <div className="bg-obsidian px-3 py-2.5">
                  <dt className="text-ink-subtle">License</dt>
                  <dd className="mt-0.5 font-medium text-ink">AGPL-3.0</dd>
                </div>
                <div className="bg-obsidian px-3 py-2.5">
                  <dt className="text-ink-subtle">Runs</dt>
                  <dd className="mt-0.5 font-medium text-ink">Self-hosted</dd>
                </div>
                <div className="bg-obsidian px-3 py-2.5">
                  <dt className="text-ink-subtle">Engine</dt>
                  <dd className="mt-0.5 font-medium text-ink">OpenTofu</dd>
                </div>
              </dl>
            </div>
            <div className="min-w-0 lg:col-span-6">
              <TerminalSession />
              <p className="mt-3 font-mono text-[11.5px] text-ink-subtle">Output abbreviated. The ork CLI builds from source today; signed binaries are not released yet.</p>
            </div>
          </div>
        </section>

        {/* How it works */}
        <Section
          id="how"
          label="How it works"
          title="Template, plan, deploy, observe. Every step leaves an artifact you can read."
          intro={<p>Nothing touches a cloud until the plan is reviewed. The plan you approve is the snapshot the worker applies, resource by resource.</p>}
        >
          <ol className="grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline">
            <Step n="01" title="Template" text="A provider-neutral YAML file describes intent: an API with two replicas, a zone-redundant Postgres, versioned storage. Placement slots say which clouds each part may use. Forged once, deployed many times.">
              <TemplateExcerpt />
            </Step>
            <Step n="02" title="Plan" text="The compiler resolves every resource to a concrete service, names and tags it, orders the dependency graph and picks a connectivity strategy for each link. The plan is grouped by provider, target and region.">
              <PlanText />
            </Step>
            <Step n="03" title="Deploy" text="An asynchronous DAG runs on OpenTofu, one isolated state per resource. Independent branches run in parallel; transient failures retry; a failed resource skips only its dependents. Before changing existing resources the worker runs a real tofu plan, and a delete or replace in production waits for approval.">
              <DeployEvents />
            </Step>
            <Step n="04" title="Observe" text="Health checks roll up to the instance and to a private status page. Unhealthy critical components open incidents, notify owners in-app and by email, and resolve themselves when health returns.">
              <StatusArtifact />
            </Step>
          </ol>
        </Section>

        {/* Placement */}
        <Section
          id="placement"
          label="Multi-cloud placement"
          title="Place every resource where it belongs."
          intro={
            <p>
              Placement is per resource, not per environment. Bind the <code className="font-mono text-[15px] text-ink">data</code> slot to an Azure subscription and the
              same template becomes multi-cloud; bind every slot to one AWS account and it is single-cloud again. No template edits.
            </p>
          }
        >
          <div className="grid gap-10 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-8">
              <Topology />
            </div>
            <div className="lg:col-span-4">
              <h3 className="font-display text-lg font-semibold text-ink">How two resources reach each other</h3>
              <p className="mt-2 text-[15px] text-ink-muted">Chosen by the compiler, shown in the plan, never provisioned silently.</p>
              <dl className="mt-5 divide-y divide-hairline border-y border-hairline text-[14px]">
                <Strategy name="private-network" when="Same account and region." />
                <Strategy name="private-peering" when="Same provider, different account or region. Peering cost applies." />
                <Strategy name="public-tls-allowlist" when="Across clouds with private-preferred: TLS on a public endpoint, source allowlisted." />
                <Strategy name="unsatisfiable" when="Across clouds with private-required. The plan fails until you change the mode or the placement." />
              </dl>
              <p className="mt-5 text-[13px] leading-relaxed text-ink-subtle">
                <Tag tone="forge">Status</Tag> AWS provisioning is real (OpenTofu, verified on MiniStack). Azure and OCI run on a deterministic simulator today and are
                labelled simulated everywhere; their adapters are on the roadmap.
              </p>
            </div>
          </div>
        </Section>

        {/* Trust */}
        <Section
          id="trust"
          label="Governance"
          title="Plans you can trust, before anything is created."
          intro={<p>Policies, cost and approvals are part of the plan, not a review meeting after the fact. Custom templates go through the same checks and cannot skip them.</p>}
        >
          <div className="grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline md:grid-cols-2">
            <div className="bg-obsidian p-6 sm:p-8">
              <h3 className="font-display text-lg font-semibold">Policies, with every result shown</h3>
              <ul className="mt-5 space-y-2 font-mono text-[12.5px]">
                <Policy s="pass" name="no-public-database" msg="No database is publicly accessible." />
                <Policy s="pass" name="no-public-storage" msg="Object storage blocks public access." />
                <Policy s="pass" name="production-backups" msg="Production databases have backups." />
                <Policy s="pass" name="encryption-required" msg="All resources support encryption." />
                <Policy s="pass" name="allowed-regions" msg="All regions are approved." />
                <Policy s="pass" name="multi-cloud-entitlement" msg="Placement fits the plan." />
                <Policy s="warn" name="cross-cloud-connectivity" msg="api → database crosses clouds via public-tls-allowlist." />
              </ul>
              <p className="mt-4 text-[13px] text-ink-subtle">Also checked: non-production templates, replica limits and a monthly budget.</p>
            </div>
            <div className="bg-obsidian p-6 sm:p-8">
              <h3 className="font-display text-lg font-semibold">
                Cost estimate <Tag>approximate</Tag>
              </h3>
              <p className="mt-2 text-[13px] text-ink-subtle">Static catalog list prices, on-demand, monthly. An estimate, never an invoice.</p>
              <table className="mt-4 w-full text-left font-mono text-[12.5px]">
                <caption className="sr-only">Approximate monthly cost per resource for the multi-cloud reference instance</caption>
                <thead className="text-ink-subtle">
                  <tr className="border-b border-hairline">
                    <th scope="col" className="py-1.5 font-normal">resource</th>
                    <th scope="col" className="py-1.5 font-normal">placed on</th>
                    <th scope="col" className="py-1.5 text-right font-normal">USD/mo</th>
                  </tr>
                </thead>
                <tbody className="text-ink">
                  <CostRow r="database" p="Azure Flexible Server, HA" v="55.39" />
                  <CostRow r="api" p="AWS ECS Fargate ×2" v="36.03" />
                  <CostRow r="ingress" p="AWS ALB" v="22.27" />
                  <CostRow r="worker" p="AWS ECS on EC2" v="13.75" />
                  <CostRow r="registry, dns" p="AWS ECR, Route 53" v="1.50" />
                  <CostRow r="storage" p="OCI Object Storage" v="0.26" />
                </tbody>
                <tfoot>
                  <tr className="border-t border-hairline">
                    <th scope="row" colSpan={2} className="py-2 font-normal text-ink-muted">
                      total, approximate
                    </th>
                    <td className="py-2 text-right font-semibold text-mint">≈ 129.20</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="bg-obsidian p-6 sm:p-8">
              <h3 className="font-display text-lg font-semibold">Approvals where they matter</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">
                Production changes that delete, replace or touch a database stop at <code className="font-mono text-ink">AWAITING_APPROVAL</code>. The worker also reads
                the real provider plan, so a replacement the platform diff cannot see still escalates. Everything else proceeds, and the skipped approval records why.
              </p>
            </div>
            <div className="bg-obsidian p-6 sm:p-8">
              <h3 className="font-display text-lg font-semibold">An audit log you cannot edit</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">
                Every change is an audit event with actor, correlation id and diff. API key actions name the key. A Postgres trigger rejects updates and deletes on the
                table, so history stays history.
              </p>
            </div>
          </div>
        </Section>

        {/* Operators */}
        <Section
          id="operate"
          label="Day two"
          title="Built for the people who carry the pager."
          intro={<p>From a failing health check to an email in the owner&apos;s inbox, the chain is automatic and every link is visible.</p>}
        >
          <ol className="grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">
            <Chain n="1" title="Health" text="Each tick re-reads actual state through the provider and rolls component health up to the instance. Critical components take it down; others degrade it." meta="HEALTHY · DEGRADED · UNHEALTHY" />
            <Chain n="2" title="Incidents" text="Alert rules stored as data open incidents per resource, deduplicated, with a cooldown, and resolved automatically when health returns." meta="opened → resolved" tone="forge" />
            <Chain n="3" title="Status page" text="A private status page per tenant maps resources to customer-facing components: API, workers, database." meta="OPERATIONAL · PARTIAL_OUTAGE" />
            <Chain n="4" title="Notifications" text="Tenant owners, admins and platform staff get in-app and email notices. Signed webhooks carry the same events to your own systems." meta="in-app · email · webhooks" />
          </ol>
          <p className="mt-6 max-w-[70ch] text-[15px] leading-relaxed text-ink-muted">
            Deleted something by hand in the provider console? A live probe notices the resource is gone, verification fails fast instead of waiting, and the next deploy
            re-creates it.
          </p>
        </Section>

        {/* From your repo */}
        <Section
          id="repo"
          label="From your repo"
          title="Start from the infrastructure you already have."
          intro={
            <p>
              The scan engine reads Terraform and OpenTofu, CloudFormation and SAM, Kubernetes and Helm, Docker Compose, Dockerfiles and package manifests, and proposes an
              OrkStage template with the evidence for every resource. Import a report through the API or the console; review the draft before you publish.
            </p>
          }
        >
          <div className="grid gap-10 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-7">
              <Window title="~/shop — ork import" meta={<Tag>CLI preview</Tag>}>
                <pre className="overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-[1.65] text-ink" aria-label="ork import session">
                  <span className="block">
                    <span className="select-none text-mint">$ </span>ork import --tenant acme
                  </span>
                  <span className="block text-ink-subtle">Scanned 38 files: 7 resources, 1 unmapped.</span>
                  <span className="block">Import: 5d2f7c0e-…</span>
                  <span className="block">Template: valid</span>
                  <span className="block">Console: https://orkstage.example.com/templates/import?importId=5d2f7c0e-…</span>
                </pre>
              </Window>
              <p className="mt-3 text-[13px] text-ink-subtle">The code never leaves your machine: the CLI scans locally and sends only the report.</p>
            </div>
            <div className="lg:col-span-5">
              <ul className="space-y-4 text-[15px]">
                <Feature title="IaC import" tag={<Tag tone="mint">Available</Tag>}>
                  <code className="font-mono text-[13px]">POST /imports</code> takes a ScanReport, or files that the server scans with the same engine compiled to WebAssembly.
                  Unmapped resources and warnings are listed, not hidden.
                </Feature>
                <Feature title="API keys, webhooks, CI intake" tag={<Tag tone="mint">Available</Tag>}>
                  Scoped keys that never outrank their role, HMAC-signed webhooks with replay protection, and immutable image versions published from CI by digest.
                </Feature>
                <Feature title="The ork CLI" tag={<Tag>Preview</Tag>}>
                  init, scan, template validate / push / diff, import, deploy --wait, status, logs, destroy. JSON output and stable exit codes for CI. Build from source until
                  signed binaries ship.
                </Feature>
              </ul>
            </div>
          </div>
        </Section>

        {/* Editions */}
        <Section
          id="editions"
          label="Open core"
          title="Open source at the core. Enterprise where organizations need it."
          intro={
            <p>
              Community is the complete control plane under AGPL-3.0, enough to run production on AWS. Enterprise adds organizational scale and compliance under a
              commercial license, activated by an offline license key. Same codebase, same images.
            </p>
          }
        >
          <div className="overflow-x-auto rounded-lg border border-hairline">
            <table className="w-full min-w-[640px] text-left text-[14px]">
              <caption className="sr-only">Community and Enterprise editions compared</caption>
              <thead>
                <tr className="border-b border-hairline bg-slate-1">
                  <th scope="col" className="w-[28%] px-5 py-3 font-medium text-ink-subtle">
                    Area
                  </th>
                  <th scope="col" className="px-5 py-3 font-display text-base font-semibold">
                    Community <span className="font-sans text-[13px] font-normal text-ink-subtle">AGPL-3.0, free</span>
                  </th>
                  <th scope="col" className="px-5 py-3 font-display text-base font-semibold">
                    Enterprise <span className="font-sans text-[13px] font-normal text-ink-subtle">commercial, ee/</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline align-top">
                <EditionRow area="Control plane" community="Templates, visual builder, placement, plans and policies, cost estimate, deployments, health, incidents, status pages, notifications" enterprise={[['Policy packs and custom policy authoring', 'planned']]} />
                <EditionRow area="Provisioning" community="AWS via OpenTofu, simulated Azure and OCI, DAG, retries, drift flagging" enterprise={[['Private connectivity provisioning (VPN, interconnect)', 'planned']]} />
                <EditionRow area="Identity" community="Dev login, OIDC (Entra; Google and GitLab by configuration)" enterprise={[['SAML 2.0 SSO and SCIM provisioning', 'planned']]} />
                <EditionRow area="Governance" community="7 built-in roles, approvals for high-risk production changes, append-only audit log" enterprise={[['Audit log export (NDJSON, CSV)', 'available'], ['Custom roles, multi-step approvals, retention policies', 'planned']]} />
                <EditionRow area="Organizations" community="One organization, many tenants" enterprise={[['Multiple organizations, white-label status pages', 'planned']]} />
                <EditionRow area="Integrations" community="API keys, webhooks, CI intake, IaC import, ork CLI (preview)" enterprise={[['ServiceNow / Jira change management, PagerDuty / Opsgenie', 'planned']]} />
                <EditionRow area="Support" community="GitHub Discussions" enterprise={[['SLA-backed priority support', 'planned']]} />
              </tbody>
            </table>
          </div>
          <p className="mt-5 text-[14px] text-ink-muted">
            <Link href="/docs/enterprise/editions/" className="text-mint underline-offset-4 hover:underline">
              Full comparison
            </Link>{' '}
            ·{' '}
            <a href={links.contact} className="text-mint underline-offset-4 hover:underline">
              Talk to us about Enterprise
            </a>
          </p>
        </Section>

        {/* Self-host */}
        <Section
          id="self-host"
          label="Self-host"
          title="The whole platform, one compose command."
          intro={<p>Only Docker is required. The compose file brings up the API, worker, console, Postgres, Redis, Mailpit, the OpenTofu runner image and MiniStack for local AWS.</p>}
        >
          <div className="grid gap-10 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-7">
              <Window title="shell" meta="local evaluation">
                <pre className="overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-[1.7] text-ink" aria-label="Docker Compose command">
                  <span className="block">
                    <span className="select-none text-mint">$ </span>git clone https://github.com/orkstage/orkstage &amp;&amp; cd orkstage
                  </span>
                  <span className="block">
                    <span className="select-none text-mint">$ </span>docker compose -f infra/local/docker-compose.yml \
                  </span>
                  <span className="block">{'    --profile platform --profile aws-emulator up -d --build --wait'}</span>
                </pre>
              </Window>
              <p className="mt-3 text-[13px] text-ink-subtle">
                This stack runs in development mode with the dev login and the Docker socket mounted. It is for evaluation on your machine, not for production.
              </p>
            </div>
            <div className="lg:col-span-5">
              <dl className="divide-y divide-hairline border-y border-hairline font-mono text-[13px]">
                <Service name="console" url="localhost:3000" />
                <Service name="api + OpenAPI" url="localhost:4000/api/docs" />
                <Service name="MiniStack (AWS)" url="localhost:4566" />
                <Service name="Mailpit" url="localhost:8025" />
              </dl>
              <div className="mt-8">
                <PrimaryLink href={links.quickstart}>Read the quickstart</PrimaryLink>
              </div>
            </div>
          </div>
        </Section>
      </main>

      <footer className="border-t border-hairline">
        <div className="mx-auto grid max-w-[1200px] gap-10 px-4 py-14 sm:px-6 md:grid-cols-12">
          <div className="md:col-span-5">
            <Logo height={32} forceDark />
            <p className="mt-4 max-w-sm text-[14px] text-ink-muted">Command every stage of your cloud. Raw scale. Precise control.</p>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-8 text-[14px] sm:grid-cols-3 md:col-span-7">
            <FooterCol title="Product" items={[['Documentation', '/docs/'], ['Quickstart', links.quickstart], ['API reference', '/docs/developer/api-reference/']]} />
            <FooterCol title="Project" items={[['GitHub', links.github], ['License (AGPL-3.0)', links.license], ['Security', links.security]]} />
            <FooterCol title="Company" items={[['Enterprise', '/docs/enterprise/'], ['Contact', links.contact]]} />
          </nav>
          <p className="text-[12.5px] text-ink-subtle md:col-span-12">
            OrkStage is open source under the GNU AGPL-3.0; directories named <code className="font-mono">ee/</code> are under the OrkStage Enterprise License. OrkStage and
            the OrkStage logo are trademarks of the OrkStage project.
          </p>
        </div>
      </footer>
    </div>
  );
}

/* ── section parts ──────────────────────────────────────────────────────────────────────── */

function Step({ n, title, text, children }: { n: string; title: string; text: string; children: ReactNode }) {
  return (
    <li className="grid gap-6 bg-obsidian p-6 sm:p-8 lg:grid-cols-12 lg:gap-10">
      <div className="lg:col-span-4">
        <p className="font-mono text-[12px] text-mint">{n}</p>
        <h3 className="mt-2 font-display text-2xl font-semibold tracking-[-0.01em]">{title}</h3>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">{text}</p>
      </div>
      <div className="min-w-0 lg:col-span-8">{children}</div>
    </li>
  );
}

function StatusArtifact() {
  const rows: [string, string, string][] = [
    ['API', 'OPERATIONAL', 'text-mint'],
    ['Workers', 'OPERATIONAL', 'text-mint'],
    ['Database', 'DEGRADED', 'text-forge'],
    ['Storage', 'OPERATIONAL', 'text-mint'],
  ];
  return (
    <Window title="Status · Acme Corp (private)" meta="updated 14:52">
      <div className="px-4 py-4">
        <p className="font-display text-[15px] font-semibold text-forge">Degraded performance</p>
        <ul className="mt-3 divide-y divide-hairline border-y border-hairline font-mono text-[12.5px]">
          {rows.map(([c, s, tone]) => (
            <li key={c} className="flex items-center justify-between py-2">
              <span className="text-ink">{c}</span>
              <span className={tone}>{s}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 rounded-md border border-forge/40 px-3 py-2.5 text-[13px]">
          <p className="font-medium text-ink">Incident opened · database unhealthy</p>
          <p className="mt-1 text-ink-muted">Critical resource unhealthy. Owners notified in-app and by email. Resolves automatically when health returns.</p>
        </div>
      </div>
    </Window>
  );
}

function Strategy({ name, when }: { name: string; when: string }) {
  return (
    <div className="py-3">
      <dt className="font-mono text-[13px] text-ink">{name}</dt>
      <dd className="mt-1 text-ink-muted">{when}</dd>
    </div>
  );
}

function Policy({ s, name, msg }: { s: 'pass' | 'warn'; name: string; msg: string }) {
  return (
    <li className="flex gap-3">
      <span className={`w-10 shrink-0 uppercase ${s === 'pass' ? 'text-mint' : 'text-forge'}`}>{s}</span>
      <span className="min-w-0">
        <span className="text-ink">{name}</span> <span className="text-ink-subtle">{msg}</span>
      </span>
    </li>
  );
}

function CostRow({ r, p, v }: { r: string; p: string; v: string }) {
  return (
    <tr className="border-b border-hairline/60">
      <td className="py-1.5 pr-2">{r}</td>
      <td className="py-1.5 pr-2 text-ink-muted">{p}</td>
      <td className="py-1.5 text-right">{v}</td>
    </tr>
  );
}

function Chain({ n, title, text, meta, tone }: { n: string; title: string; text: string; meta: string; tone?: 'forge' }) {
  return (
    <li className="flex flex-col bg-obsidian p-6">
      <p className="font-mono text-[12px] text-ink-subtle">
        {n} <span aria-hidden="true">→</span>
      </p>
      <h3 className="mt-3 font-display text-xl font-semibold">{title}</h3>
      <p className="mt-2 flex-1 text-[14.5px] leading-relaxed text-ink-muted">{text}</p>
      <p className={`mt-5 font-mono text-[11.5px] ${tone === 'forge' ? 'text-forge' : 'text-ink-subtle'}`}>{meta}</p>
    </li>
  );
}

function Feature({ title, tag, children }: { title: string; tag: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-3 border-b border-hairline pb-4 last:border-0">
      <Check />
      <div>
        <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
          {title} {tag}
        </p>
        <p className="mt-1 leading-relaxed text-ink-muted">{children}</p>
      </div>
    </li>
  );
}

function EditionRow({ area, community, enterprise }: { area: string; community: string; enterprise: [string, 'available' | 'planned'][] }) {
  return (
    <tr>
      <th scope="row" className="px-5 py-4 font-medium text-ink">
        {area}
      </th>
      <td className="px-5 py-4 text-ink-muted">{community}</td>
      <td className="px-5 py-4 text-ink-muted">
        <ul className="space-y-1.5">
          {enterprise.map(([text, state]) => (
            <li key={text} className="flex flex-wrap items-center gap-2">
              <span>{text}</span> <Tag tone={state === 'available' ? 'mint' : 'muted'}>{state}</Tag>
            </li>
          ))}
        </ul>
      </td>
    </tr>
  );
}

function Service({ name, url }: { name: string; url: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <dt className="text-ink-muted">{name}</dt>
      <dd className="text-ink">{url}</dd>
    </div>
  );
}

function FooterCol({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <div>
      <p className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-ink-subtle">{title}</p>
      <ul className="mt-3 space-y-2">
        {items.map(([label, href]) => (
          <li key={label}>
            {href.startsWith('/') ? (
              <Link href={href} className="text-ink-muted hover:text-ink">
                {label}
              </Link>
            ) : (
              <a href={href} className="text-ink-muted hover:text-ink">
                {label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
