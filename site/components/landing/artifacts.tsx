import type { ReactNode } from 'react';

/**
 * Product artifacts rendered as code (no screenshots): an `ork` session, the plain-text plan
 * format from packages/provisioning (renderPlan), a template excerpt from the built-in
 * multicloud-reference template, deployment events in the worker's format.
 */

export function Window({ title, meta, children, className = '' }: { title: string; meta?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <figure className={`overflow-hidden rounded-lg border border-hairline bg-slate-1 ${className}`}>
      <figcaption className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-2.5 font-mono text-[12px] text-ink-subtle">
        <span className="truncate">{title}</span>
        {meta ? <span className="shrink-0">{meta}</span> : null}
      </figcaption>
      {children}
    </figure>
  );
}

const pre = 'overflow-x-auto px-4 py-4 font-mono text-[12.5px] leading-[1.65] text-ink';

/** Prompt line. */
function P({ children }: { children: ReactNode }) {
  return (
    <span className="block">
      <span className="select-none text-mint">$ </span>
      <span className="text-ink">{children}</span>
    </span>
  );
}
function D({ children }: { children: ReactNode }) {
  return <span className="block text-ink-subtle">{children}</span>;
}
function L({ children }: { children?: ReactNode }) {
  return <span className="block whitespace-pre">{children ?? ' '}</span>;
}

export function TerminalSession({ label, tag }: { label: string; tag: string }) {
  return (
    <Window title="~/shop · ork" meta={<span className="rounded border border-hairline px-1.5 py-px text-[10px] uppercase tracking-wider">{tag}</span>}>
      <pre className={pre} aria-label={label}>
        <P>ork scan</P>
        <D>Scanned 38 of 214 files (91.2 KiB): walk 4 ms, scan 12 ms · terraform 6 · compose 1 · dockerfile 2</D>
        <L>Resources (7)</L>
        <L>{'  ID        TYPE                        PROVIDER  IMPLEMENTATION      CONFIDENCE'}</L>
        <L>{'  network   network                     aws       vpc                 high'}</L>
        <L>{'  api       compute.container-service   aws       ecs-fargate         high'}</L>
        <L>{'  worker    compute.container-service   aws       ecs-fargate         medium'}</L>
        <L>{'  database  database.postgresql         aws       rds-postgres        high'}</L>
        <L>{'  cache     cache.redis                 aws       elasticache-valkey  high'}</L>
        <L>{'  ingress   ingress                     aws       alb                 medium'}</L>
        <L>{'  dns       dns                         aws       route53             medium'}</L>
        <L />
        <P>ork template push</P>
        <L>Created template shop 0.1.0 (DRAFT). Publish it in the console when reviewed.</L>
        <L />
        <P>ork deploy --instance shop-staging --wait</P>
        <D>Deployment 3c1e9a52 queued for shop-staging.</D>
        <L>
          <span className="text-ink-subtle">14:02:11 INFO </span> [phase:validate] Template shop@0.1.0 valid; 8 policies passed, 0 warning(s).
        </L>
        <L>
          <span className="text-ink-subtle">14:02:12 INFO </span> [phase:plan] Plan: 7 to create, 0 to update, 0 to delete, 0 unchanged (risk low).
        </L>
        <L>
          <span className="text-ink-subtle">14:02:13 INFO </span> [network] Provisioning Amazon VPC &quot;co-acme-shop-staging-network&quot; in aws/us-east-1…
        </L>
        <L>
          <span className="text-ink-subtle">14:06:40 INFO </span> [database] Provisioning Amazon RDS for PostgreSQL &quot;co-acme-shop-staging-database&quot; in aws/us-east-1…
        </L>
        <L>
          <span className="text-ink-subtle">14:14:02 INFO </span> [phase:verify] All health and connectivity checks passed.
        </L>
        <L>
          <span className="text-mint">Deployment 3c1e9a52 succeeded.</span>
        </L>
      </pre>
    </Window>
  );
}

export function TemplateExcerpt({ label }: { label: string }) {
  const k = 'text-[#5aa9ff]';
  const s = 'text-mint';
  const c = 'text-ink-subtle';
  return (
    <Window title="templates/multicloud-reference.yaml" meta="platform/v1">
      <pre className={pre} aria-label={label}>
        <L>
          <span className={k}>placements</span>:
        </L>
        <L>
          {'  - '}
          <span className={k}>name</span>: primary{'    '}
          <span className={k}>providers</span>: [aws, mock]
        </L>
        <L>
          {'  - '}
          <span className={k}>name</span>: data{'       '}
          <span className={k}>providers</span>: [aws, azure, mock]
        </L>
        <L>
          {'  - '}
          <span className={k}>name</span>: storage{'    '}
          <span className={k}>providers</span>: [aws, oci, mock]
        </L>
        <L>
          <span className={k}>resources</span>:
        </L>
        <L>
          {'  - '}
          <span className={k}>id</span>: api
        </L>
        <L>
          {'    '}
          <span className={k}>type</span>: compute.container-service
        </L>
        <L>
          {'    '}
          <span className={k}>image</span>: <span className={s}>catalog://sample-api</span>
        </L>
        <L>
          {'    '}
          <span className={k}>replicas</span>: 2{'   '}
          <span className={k}>cpu</span>: 0.5{'   '}
          <span className={k}>memoryMiB</span>: 1024
        </L>
        <L>
          {'  - '}
          <span className={k}>id</span>: database
        </L>
        <L>
          {'    '}
          <span className={k}>type</span>: database.postgresql
        </L>
        <L>
          {'    '}
          <span className={k}>placement</span>: <span className={s}>data</span>
          {'          '}
          <span className={c}># bound per instance</span>
        </L>
        <L>
          {'    '}
          <span className={k}>highAvailability</span>: zone-redundant
        </L>
        <L>
          {'    '}
          <span className={k}>backup</span>: {'{ enabled: true, retentionDays: 7 }'}
        </L>
        <L>
          <span className={k}>connectivity</span>:
        </L>
        <L>
          {'  - { '}
          <span className={k}>from</span>: api, <span className={k}>to</span>: database, <span className={k}>protocol</span>: postgres,{' '}
          <span className={k}>mode</span>: private-preferred {'}'}
        </L>
      </pre>
    </Window>
  );
}

/** Exactly the shape renderPlan() prints: provider / target / region groups, then cross-cloud. Product output, kept verbatim (arrows and ellipses included). */
export function PlanText({ label }: { label: string }) {
  const a = 'text-mint';
  return (
    <Window title="Deployment plan" meta="risk: low">
      <pre className={pre} aria-label={label}>
        <L>Deployment Plan</L>
        <L />
        <L>Instance: Acme Production</L>
        <L />
        <L>AWS / aws-prod / us-east-1</L>
        <L>
          {'  '}
          <span className={a}>CREATE</span> Amazon VPC network
        </L>
        <L>
          {'  '}
          <span className={a}>CREATE</span> Amazon ECR (private) registry
        </L>
        <L>
          {'  '}
          <span className={a}>CREATE</span> Amazon ECS on Fargate api
        </L>
        <L>
          {'  '}
          <span className={a}>CREATE</span> Amazon ECS on EC2 capacity worker
        </L>
        <L>
          {'  '}
          <span className={a}>CREATE</span> Application Load Balancer ingress
        </L>
        <L>
          {'  '}
          <span className={a}>CREATE</span> Amazon Route 53 + ACM certificates dns
        </L>
        <L />
        <L>AZURE / azure-data / eastus</L>
        <L>
          {'  '}
          <span className={a}>CREATE</span> Azure Database for PostgreSQL Flexible Server database
        </L>
        <L />
        <L>OCI / oci-storage / us-ashburn-1</L>
        <L>
          {'  '}
          <span className={a}>CREATE</span> OCI Object Storage storage
        </L>
        <L />
        <L>Cross-cloud</L>
        <L>{'  CONFIGURE api → database (public-tls-allowlist)'}</L>
        <L>{'  CONFIGURE worker → database (public-tls-allowlist)'}</L>
        <L>{'  CONFIGURE api → storage (public-tls)'}</L>
        <L />
        <L>Risk: low</L>
      </pre>
    </Window>
  );
}

export function DeployEvents({ label }: { label: string }) {
  const rows: [string, string, string, string][] = [
    ['14:21:03', 'INFO', 'phase:targets', 'aws-prod / us-east-1: 4 checks passed.'],
    ['14:21:05', 'INFO', 'phase:plan', 'api: 0 to add, 1 to change, 0 to destroy'],
    ['14:21:05', 'WARN', 'phase:plan', 'ingress: 1 to add, 0 to change, 1 to destroy — replace aws_lb_target_group.route[0]'],
    ['14:21:05', 'WARN', 'phase:plan', 'The provider plan deletes or replaces existing resources: production approval required.'],
    ['14:21:06', 'WARN', 'phase:approval', 'High-risk production change: waiting for approval.'],
  ];
  const tone = (lvl: string) => (lvl === 'WARN' ? 'text-forge' : lvl === 'ERROR' ? 'text-danger' : 'text-ink-subtle');
  return (
    <Window title="deployment 9b07c4e1 · events" meta="AWAITING_APPROVAL">
      <pre className={pre} aria-label={label}>
        {rows.map(([t, lvl, step, msg]) => (
          <L key={t + msg}>
            <span className="text-ink-subtle">{t} </span>
            <span className={tone(lvl)}>{lvl.padEnd(5)}</span> <span className="text-[#5aa9ff]">[{step}]</span> {msg}
          </L>
        ))}
      </pre>
    </Window>
  );
}
