/**
 * The multicloud-reference instance as a topology: one logical environment, resources grouped
 * by the cloud they are placed on, cross-cloud links labelled with the connectivity strategy the
 * compiler chose (packages/provisioning/src/connectivity.ts).
 */
type Node = { id: string; label: string; impl: string; x: number; y: number };

const W = 168;
const H = 46;

const aws: Node[] = [
  { id: 'dns', label: 'dns', impl: 'Route 53 + ACM', x: 40, y: 70 },
  { id: 'ingress', label: 'ingress', impl: 'ALB', x: 40, y: 140 },
  { id: 'api', label: 'api', impl: 'ECS Fargate ×2', x: 40, y: 210 },
  { id: 'worker', label: 'worker', impl: 'ECS on EC2', x: 40, y: 280 },
  { id: 'registry', label: 'registry', impl: 'ECR', x: 236, y: 140 },
  { id: 'network', label: 'network', impl: 'VPC, 2 AZs', x: 236, y: 280 },
];
const azure: Node[] = [{ id: 'database', label: 'database', impl: 'PostgreSQL Flexible Server', x: 520, y: 112 }];
const oci: Node[] = [{ id: 'storage', label: 'storage', impl: 'Object Storage', x: 520, y: 292 }];

function Box({ n }: { n: Node }) {
  return (
    <g>
      <rect x={n.x} y={n.y} width={W} height={H} rx={6} fill="#1a1d26" stroke="#343a48" />
      <text x={n.x + 12} y={n.y + 19} fill="#e8eaf0" fontSize="13" fontFamily="var(--font-mono)">
        {n.label}
      </text>
      <text x={n.x + 12} y={n.y + 35} fill="#a3a9b8" fontSize="11" fontFamily="var(--font-sans)">
        {n.impl}
      </text>
    </g>
  );
}

function Group({ x, y, w, h, title, note }: { x: number; y: number; w: number; h: number; title: string; note: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} fill="none" stroke="#262a35" strokeDasharray="4 4" />
      <text x={x + 14} y={y + 22} fill="#e8eaf0" fontSize="12" fontWeight={600} fontFamily="var(--font-sans)" letterSpacing="0.06em">
        {title}
      </text>
      <text x={x + w - 14} y={y + 22} fill="#858c9c" fontSize="11" textAnchor="end" fontFamily="var(--font-mono)">
        {note}
      </text>
    </g>
  );
}

export function Topology({ title, description }: { title: string; description: string }) {
  return (
    <figure className="overflow-hidden rounded-lg border border-hairline bg-slate-1">
      <figcaption className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-2.5 font-mono text-[12px] text-ink-subtle">
        <span>Acme Production · multicloud-reference@1.0.0</span>
        <span>3 placement slots · 8 resources</span>
      </figcaption>
      <div className="overflow-x-auto">
        <svg
          viewBox="0 0 740 360"
          className="block h-auto w-full min-w-[620px]"
          role="img"
          aria-labelledby="topo-title topo-desc"
        >
          <title id="topo-title">{title}</title>
          <desc id="topo-desc">{description}</desc>
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 8 4 0 8z" fill="#626a7b" />
            </marker>
            <marker id="arrow-mint" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 8 4 0 8z" fill="#00f29b" />
            </marker>
          </defs>

          <Group x={20} y={30} w={404} h={312} title="AWS" note="slot primary · us-east-1" />
          <Group x={500} y={60} w={220} h={120} title="AZURE" note="slot data · eastus" />
          <Group x={500} y={240} w={220} h={102} title="OCI" note="slot storage" />

          {/* in-cloud edges */}
          <path d="M124 116 V140" stroke="#626a7b" strokeWidth="1.25" markerEnd="url(#arrow)" />
          <path d="M124 186 V210" stroke="#626a7b" strokeWidth="1.25" markerEnd="url(#arrow)" />
          <path d="M208 233 C 222 233 222 186 236 172" stroke="#626a7b" strokeWidth="1.25" fill="none" markerEnd="url(#arrow)" />

          {/* cross-cloud edges */}
          <path d="M208 222 C 360 222 400 135 518 135" stroke="#00f29b" strokeWidth="1.5" fill="none" markerEnd="url(#arrow-mint)" />
          <path d="M208 300 C 360 300 420 150 518 150" stroke="#00f29b" strokeWidth="1.5" strokeDasharray="5 4" fill="none" markerEnd="url(#arrow-mint)" />
          <path d="M208 240 C 330 240 420 315 518 315" stroke="#5aa9ff" strokeWidth="1.5" fill="none" markerEnd="url(#arrow)" />

          <g>
            <rect x={366} y={160} width={124} height={22} rx={4} fill="#0d0e12" stroke="#00f29b" strokeOpacity="0.6" />
            <text x={428} y={175} fill="#00f29b" fontSize="11" textAnchor="middle" fontFamily="var(--font-mono)">
              TLS + allowlist
            </text>
          </g>
          <g>
            <rect x={398} y={262} width={56} height={22} rx={4} fill="#0d0e12" stroke="#5aa9ff" strokeOpacity="0.6" />
            <text x={426} y={277} fill="#5aa9ff" fontSize="11" textAnchor="middle" fontFamily="var(--font-mono)">
              TLS
            </text>
          </g>

          {[...aws, ...azure, ...oci].map((n) => (
            <Box key={n.id} n={n} />
          ))}
        </svg>
      </div>
    </figure>
  );
}
