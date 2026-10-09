import type { ReactNode } from 'react';
import { JsonLd } from '@/components/json-ld';
import { DeployEvents, PlanText, TemplateExcerpt, TerminalSession, Window } from '@/components/landing/artifacts';
import { Topology } from '@/components/landing/topology';
import { Rich } from '@/components/rich';
import { LocaleHint, SiteFooter, SiteHeader, SkipLink } from '@/components/site/chrome';
import { getMessages, type Locale } from '@/lib/i18n';
import { landingJsonLd } from '@/lib/seo';
import { links } from '@/lib/shared';

/**
 * The landing page, rendered once per locale (app/(en)/page.tsx and app/(pt)/pt-br/page.tsx).
 * Server components only; the one client island is the language hint. Links are plain anchors:
 * the docs use another root layout, so client side navigation would not apply anyway. All copy comes from the
 * locale dictionary; product output inside the artifacts stays as the product prints it.
 */
export function HomePage({ locale }: { locale: Locale }) {
  const m = getMessages(locale);
  const docsLang = locale === 'en' ? undefined : 'en';
  return (
    <div className="bg-obsidian text-ink [color-scheme:dark]">
      <JsonLd data={landingJsonLd(locale)} />
      <SkipLink locale={locale} />
      <SiteHeader locale={locale} />

      <main id="main">
        {/* Hero */}
        <section aria-labelledby="hero-title" className="bg-grid relative">
          <div className="mx-auto grid max-w-[1200px] gap-12 px-4 pb-20 pt-16 sm:px-6 md:pt-24 lg:grid-cols-12 lg:gap-10 lg:pb-28">
            <div className="lg:col-span-6 lg:pt-6">
              <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-ink-subtle">{m.hero.eyebrow}</p>
              <h1 id="hero-title" className="mt-5 font-display text-[2.6rem] font-semibold leading-[1.02] tracking-[-0.03em] text-ink sm:text-6xl">
                {m.hero.title}
              </h1>
              <p className="mt-6 max-w-[52ch] text-lg leading-relaxed text-ink-muted">{m.hero.lead}</p>
              <div className="mt-9 flex flex-wrap gap-3">
                <PrimaryLink href={links.quickstart} hrefLang={docsLang}>
                  {m.hero.primary}
                </PrimaryLink>
                <SecondaryLink href={links.github}>{m.hero.secondary}</SecondaryLink>
              </div>
              <dl className="mt-10 grid max-w-md grid-cols-3 gap-px overflow-hidden rounded-md border border-hairline bg-hairline text-[13px]">
                <Fact label={m.hero.facts.licenseLabel} value={m.hero.facts.licenseValue} />
                <Fact label={m.hero.facts.runsLabel} value={m.hero.facts.runsValue} />
                <Fact label={m.hero.facts.engineLabel} value={m.hero.facts.engineValue} />
              </dl>
            </div>
            <div className="min-w-0 lg:col-span-6">
              <TerminalSession label={m.hero.terminalLabel} tag={m.tags.cliPreview} />
              <p className="mt-3 font-mono text-[11.5px] text-ink-subtle">{m.hero.terminalNote}</p>
            </div>
          </div>
        </section>

        {/* How it works */}
        <Section id="how" label={m.how.label} title={m.how.title} intro={m.how.intro}>
          <ol className="grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline">
            <Step n="01" title={m.how.steps.template.title} text={m.how.steps.template.text}>
              <TemplateExcerpt label={m.how.steps.template.artifactLabel} />
            </Step>
            <Step n="02" title={m.how.steps.plan.title} text={m.how.steps.plan.text}>
              <PlanText label={m.how.steps.plan.artifactLabel} />
            </Step>
            <Step n="03" title={m.how.steps.deploy.title} text={m.how.steps.deploy.text}>
              <DeployEvents label={m.how.steps.deploy.artifactLabel} />
            </Step>
            <Step n="04" title={m.how.steps.observe.title} text={m.how.steps.observe.text}>
              <StatusArtifact />
            </Step>
          </ol>
        </Section>

        {/* Placement */}
        <Section id="placement" label={m.placement.label} title={m.placement.title} intro={m.placement.intro}>
          <div className="grid gap-10 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-8">
              <Topology title={m.placement.topologyTitle} description={m.placement.topologyDescription} />
            </div>
            <div className="lg:col-span-4">
              <h3 className="font-display text-lg font-semibold text-ink">{m.placement.linksTitle}</h3>
              <p className="mt-2 text-[15px] text-ink-muted">{m.placement.linksIntro}</p>
              <dl className="mt-5 divide-y divide-hairline border-y border-hairline text-[14px]">
                <Strategy name="private-network" when={m.placement.strategies.privateNetwork} />
                <Strategy name="private-peering" when={m.placement.strategies.privatePeering} />
                <Strategy name="public-tls-allowlist" when={m.placement.strategies.publicTls} />
                <Strategy name="unsatisfiable" when={m.placement.strategies.unsatisfiable} />
              </dl>
              <p className="mt-5 text-[13px] leading-relaxed text-ink-subtle">
                <Tag tone="forge">{m.tags.status}</Tag> {m.placement.status}
              </p>
            </div>
          </div>
        </Section>

        {/* Governance */}
        <Section id="trust" label={m.trust.label} title={m.trust.title} intro={m.trust.intro}>
          <div className="grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline md:grid-cols-2">
            <div className="bg-obsidian p-6 sm:p-8">
              <h3 className="font-display text-lg font-semibold">{m.trust.policiesTitle}</h3>
              <ul className="mt-5 space-y-2 font-mono text-[12.5px]">
                <Policy s="pass" name="no-public-database" msg="No database is publicly accessible." />
                <Policy s="pass" name="no-public-storage" msg="Object storage blocks public access." />
                <Policy s="pass" name="production-backups" msg="Production databases have backups." />
                <Policy s="pass" name="encryption-required" msg="All resources support encryption." />
                <Policy s="pass" name="allowed-regions" msg="All regions are approved." />
                <Policy s="pass" name="multi-cloud-entitlement" msg="Placement fits the plan." />
                <Policy s="warn" name="cross-cloud-connectivity" msg="api → database crosses clouds via public-tls-allowlist." />
              </ul>
              <p className="mt-4 text-[13px] text-ink-subtle">{m.trust.policiesNote}</p>
            </div>
            <div className="bg-obsidian p-6 sm:p-8">
              <h3 className="font-display text-lg font-semibold">
                {m.trust.costTitle} <Tag>{m.tags.approximate}</Tag>
              </h3>
              <p className="mt-2 text-[13px] text-ink-subtle">{m.trust.costNote}</p>
              <table className="mt-4 w-full text-left font-mono text-[12.5px]">
                <caption className="sr-only">{m.trust.costCaption}</caption>
                <thead className="text-ink-subtle">
                  <tr className="border-b border-hairline">
                    <th scope="col" className="py-1.5 font-normal">
                      {m.trust.costResource}
                    </th>
                    <th scope="col" className="py-1.5 font-normal">
                      {m.trust.costPlacedOn}
                    </th>
                    <th scope="col" className="py-1.5 text-right font-normal">
                      {m.trust.costPerMonth}
                    </th>
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
                      {m.trust.costTotal}
                    </th>
                    <td className="py-2 text-right font-semibold text-mint">≈ 129.20</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="bg-obsidian p-6 sm:p-8">
              <h3 className="font-display text-lg font-semibold">{m.trust.approvalsTitle}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">
                <Rich text={m.trust.approvalsText} />
              </p>
            </div>
            <div className="bg-obsidian p-6 sm:p-8">
              <h3 className="font-display text-lg font-semibold">{m.trust.auditTitle}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">{m.trust.auditText}</p>
            </div>
          </div>
        </Section>

        {/* Day two */}
        <Section id="operate" label={m.operate.label} title={m.operate.title} intro={m.operate.intro}>
          <ol className="grid gap-px overflow-hidden rounded-lg border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">
            <Chain n="1" title={m.operate.health.title} text={m.operate.health.text} meta="HEALTHY · DEGRADED · UNHEALTHY" />
            <Chain n="2" title={m.operate.incidents.title} text={m.operate.incidents.text} meta="INVESTIGATING · RESOLVED" tone="forge" />
            <Chain n="3" title={m.operate.statusPage.title} text={m.operate.statusPage.text} meta="OPERATIONAL · PARTIAL_OUTAGE" />
            <Chain n="4" title={m.operate.notifications.title} text={m.operate.notifications.text} meta={m.operate.notifications.meta} />
          </ol>
          <p className="mt-6 max-w-[70ch] text-[15px] leading-relaxed text-ink-muted">{m.operate.drift}</p>
        </Section>

        {/* From your repo */}
        <Section id="repo" label={m.repo.label} title={m.repo.title} intro={m.repo.intro}>
          <div className="grid gap-10 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-7">
              <Window title="~/shop · ork import" meta={<Tag>{m.tags.cliPreview}</Tag>}>
                <pre className="overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-[1.65] text-ink" aria-label={m.repo.sessionLabel}>
                  <span className="block">
                    <span className="select-none text-mint">$ </span>ork import --tenant acme
                  </span>
                  <span className="block text-ink-subtle">Scanned 38 files: 7 resources, 1 unmapped.</span>
                  <span className="block">Import: 5d2f7c0e-8a41-4c6b-9e2d-1f0b7a3c6d58</span>
                  <span className="block">Template: valid</span>
                  <span className="block">Console: https://orkstage.example.com/templates/import?importId=5d2f7c0e-8a41-4c6b-9e2d-1f0b7a3c6d58</span>
                </pre>
              </Window>
              <p className="mt-3 text-[13px] text-ink-subtle">{m.repo.note}</p>
            </div>
            <div className="lg:col-span-5">
              <ul className="space-y-4 text-[15px]">
                <Feature title={m.repo.importTitle} tag={<Tag tone="mint">{m.tags.available}</Tag>}>
                  <Rich text={m.repo.importText} codeClassName="font-mono text-[13px] text-ink" />
                </Feature>
                <Feature title={m.repo.integrationsTitle} tag={<Tag tone="mint">{m.tags.available}</Tag>}>
                  {m.repo.integrationsText}
                </Feature>
                <Feature title={m.repo.cliTitle} tag={<Tag>{m.tags.preview}</Tag>}>
                  <Rich text={m.repo.cliText} codeClassName="font-mono text-[13px] text-ink" />
                </Feature>
              </ul>
            </div>
          </div>
        </Section>

        {/* Editions */}
        <Section id="editions" label={m.editions.label} title={m.editions.title} intro={m.editions.intro}>
          <div className="overflow-x-auto rounded-lg border border-hairline">
            <table className="w-full min-w-[640px] text-left text-[14px]">
              <caption className="sr-only">{m.editions.caption}</caption>
              <thead>
                <tr className="border-b border-hairline bg-slate-1">
                  <th scope="col" className="w-[28%] px-5 py-3 font-medium text-ink-subtle">
                    {m.editions.area}
                  </th>
                  <th scope="col" className="px-5 py-3 font-display text-base font-semibold">
                    {m.editions.community} <span className="font-sans text-[13px] font-normal text-ink-subtle">{m.editions.communityNote}</span>
                  </th>
                  <th scope="col" className="px-5 py-3 font-display text-base font-semibold">
                    {m.editions.enterprise}{' '}
                    <span className="font-sans text-[13px] font-normal text-ink-subtle">
                      <Rich text={m.editions.enterpriseNote} codeClassName="font-mono" />
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline align-top">
                {Object.entries(m.editions.rows).map(([key, row]) => (
                  <EditionRow
                    key={key}
                    area={row.area}
                    community={row.community}
                    enterprise={[
                      ...('enterpriseAvailable' in row ? [[row.enterpriseAvailable, m.tags.available, true] as const] : []),
                      [row.enterprisePlanned, m.tags.planned, false] as const,
                    ]}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-[14px] text-ink-muted">
            <a href={links.editions} hrefLang={docsLang} className="text-mint underline-offset-4 hover:underline">
              {m.editions.compare}
            </a>
            <a href={links.contact} className="text-mint underline-offset-4 hover:underline">
              {m.editions.contact}
            </a>
          </p>
        </Section>

        {/* Run it yourself */}
        <Section id="self-host" label={m.selfHost.label} title={m.selfHost.title} intro={m.selfHost.intro}>
          <div className="grid gap-10 lg:grid-cols-12">
            <div className="min-w-0 lg:col-span-7">
              <Window title="shell" meta={m.selfHost.windowMeta}>
                <pre className="overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-[1.7] text-ink" aria-label={m.selfHost.commandLabel}>
                  <span className="block">
                    <span className="select-none text-mint">$ </span>git clone https://github.com/orkstage/orkstage &amp;&amp; cd orkstage
                  </span>
                  <span className="block">
                    <span className="select-none text-mint">$ </span>docker compose -f infra/local/docker-compose.yml \
                  </span>
                  <span className="block">{'    --profile platform --profile aws-emulator up -d --build --wait'}</span>
                </pre>
              </Window>
              <p className="mt-3 text-[13px] text-ink-subtle">{m.selfHost.note}</p>
            </div>
            <div className="lg:col-span-5">
              <dl className="divide-y divide-hairline border-y border-hairline font-mono text-[13px]">
                <Service name="console" url="localhost:3000" />
                <Service name="api + OpenAPI" url="localhost:4000/api/docs" />
                <Service name="MiniStack (AWS)" url="localhost:4566" />
                <Service name="Mailpit" url="localhost:8025" />
              </dl>
              <div className="mt-8">
                <PrimaryLink href={links.quickstart} hrefLang={docsLang}>
                  {m.selfHost.cta}
                </PrimaryLink>
              </div>
            </div>
          </div>
        </Section>
      </main>

      <SiteFooter locale={locale} />
      <LocaleHint locale={locale} />
    </div>
  );
}

/* Primitives */

function Section({ id, label, title, intro, children }: { id: string; label: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="border-t border-hairline">
      <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6 md:py-28">
        <div className="grid gap-x-12 gap-y-6 md:grid-cols-12">
          <p className="font-mono text-[12px] uppercase tracking-[0.14em] text-ink-subtle md:col-span-3 md:pt-2">{label}</p>
          <div className="md:col-span-9">
            <h2 id={`${id}-title`} className="max-w-[22ch] font-display text-3xl font-semibold leading-[1.08] tracking-[-0.02em] text-ink sm:text-[2.6rem]">
              {title}
            </h2>
            {intro ? (
              <p className="mt-5 max-w-[62ch] text-[17px] leading-relaxed text-ink-muted">
                <Rich text={intro} codeClassName="font-mono text-[15px] text-ink" />
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-14">{children}</div>
      </div>
    </section>
  );
}

function PrimaryLink({ href, hrefLang, children }: { href: string; hrefLang?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      hrefLang={hrefLang}
      className="inline-flex h-11 items-center rounded-md bg-mint px-5 text-[15px] font-semibold text-obsidian transition-colors hover:bg-[#33f5af] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-mint"
    >
      {children}
    </a>
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
    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" className="mt-1 size-3.5 shrink-0 text-mint">
      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-obsidian px-3 py-2.5">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 font-medium text-ink">{value}</dd>
    </div>
  );
}

/* Section parts */

function Step({ n, title, text, children }: { n: string; title: string; text: string; children: ReactNode }) {
  return (
    <li className="grid gap-6 bg-obsidian p-6 sm:p-8 lg:grid-cols-12 lg:gap-10">
      <div className="lg:col-span-4">
        <p className="font-mono text-[12px] text-mint">{n}</p>
        <h3 className="mt-2 font-display text-2xl font-semibold tracking-[-0.01em]">{title}</h3>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-muted">
          <Rich text={text} />
        </p>
      </div>
      <div className="min-w-0 lg:col-span-8">{children}</div>
    </li>
  );
}

/** A private status page as the console renders it (product UI, English). */
function StatusArtifact() {
  const rows: [string, string, string][] = [
    ['API', 'OPERATIONAL', 'text-mint'],
    ['Workers', 'OPERATIONAL', 'text-mint'],
    ['Database', 'DEGRADED', 'text-forge'],
    ['Storage', 'OPERATIONAL', 'text-mint'],
  ];
  return (
    <Window title="Status · Acme Corp (private)" meta="updated 14:52">
      <div className="px-4 py-4" lang="en">
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
          <p className="mt-1 text-ink-muted">Critical resource unhealthy. Owners notified in the console and by email. Resolves automatically when health returns.</p>
        </div>
      </div>
    </Window>
  );
}

function Strategy({ name, when }: { name: string; when: string }) {
  return (
    <div className="py-3">
      <dt className="font-mono text-[13px] text-ink">{name}</dt>
      <dd className="mt-1 text-ink-muted">
        <Rich text={when} codeClassName="font-mono text-[13px] text-ink" />
      </dd>
    </div>
  );
}

function Policy({ s, name, msg }: { s: 'pass' | 'warn'; name: string; msg: string }) {
  return (
    <li className="flex gap-3">
      <span className={`w-10 shrink-0 uppercase ${s === 'pass' ? 'text-mint' : 'text-forge'}`}>{s}</span>
      <span className="min-w-0" lang="en">
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
      <p className="font-mono text-[12px] text-ink-subtle">{n.padStart(2, '0')}</p>
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
        <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-medium text-ink">
          {title} {tag}
        </h3>
        <p className="mt-1 leading-relaxed text-ink-muted">{children}</p>
      </div>
    </li>
  );
}

function EditionRow({ area, community, enterprise }: { area: string; community: string; enterprise: readonly (readonly [string, string, boolean])[] }) {
  return (
    <tr>
      <th scope="row" className="px-5 py-4 font-medium text-ink">
        {area}
      </th>
      <td className="px-5 py-4 text-ink-muted">{community}</td>
      <td className="px-5 py-4 text-ink-muted">
        <ul className="space-y-1.5">
          {enterprise.map(([text, state, available]) => (
            <li key={text} className="flex flex-wrap items-center gap-2">
              <span>{text}</span> <Tag tone={available ? 'mint' : 'muted'}>{state}</Tag>
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
