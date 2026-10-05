# Integration API: API keys, webhooks, import (v1)

Contract shared by the platform, the `ork` CLI and the docs. Base path `/api/v1`.

## API keys

- Format: `ork_<env>_<prefix>_<secret>` e.g. `ork_live_7f3a9c21_<43 url-safe chars>`.
  `env` is `live` or `test`; `prefix` (8 hex) is stored and shown; only SHA-256 of the full
  token is stored. The token is returned **once**, at creation.
- Send as `Authorization: Bearer <token>`. Bearer requests need no CSRF header and no cookie.
- A key belongs to an **organization** and optionally a **tenant**:
  - tenant key: acts with `role` ∈ `CustomerAdmin | CustomerDeveloper | CustomerViewer` in that tenant;
  - organization key (platform staff only): acts with `PlatformAdmin | PlatformOperator`.
- `scopes` further restrict what the role allows. Available scopes:
  `instances:read`, `instances:write`, `instances:deploy`, `templates:read`, `templates:write`,
  `applications:write`, `incidents:write`, `imports:write`, `webhooks:manage`, `audit:read`.
- Optional `expiresAt`. Keys can be revoked; `lastUsedAt` is tracked. All key actions are audited
  with `actorType = API_KEY` and `actorLabel = "<key name> (<prefix>)"`.

| Method | Path | Body / result |
|---|---|---|
| GET | `/api-keys?tenantId=` | `ApiKeyDto[]` (never the token) |
| POST | `/api-keys` | `{ name, tenantId?, role, scopes[], expiresAt? }` → `{ apiKey: ApiKeyDto, token }` |
| DELETE | `/api-keys/:id` | revoke → 204 |
| GET | `/me` | works with keys too; adds `apiKey: { id, name, prefix, scopes }` |

## Webhooks (outbound)

- Endpoint: `{ url, description?, events[], tenantId?, enabled }`. `url` must be `https://` and
  must not resolve to private/loopback/link-local addresses (`WEBHOOK_ALLOW_PRIVATE=true` relaxes
  this for local development only). No redirects; 10 s timeout.
- Signing secret `whsec_<base64url>` returned once at creation (and on rotate); stored encrypted.
- Each delivery is a POST with JSON body
  `{ id, type, createdAt, tenantId, data }` and headers:
  - `OrkStage-Event: <type>`, `OrkStage-Delivery: <uuid>`
  - `OrkStage-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`
  Receivers must reject timestamps older than 5 minutes (replay protection).
- Retries: non-2xx or network error → retried with backoff (1m, 5m, 30m, 2h, 6h), then FAILED.
  Endpoint auto-disables after 20 consecutive failed deliveries.
- Events: `deployment.started|succeeded|failed|awaiting_approval`, `instance.degraded`,
  `incident.opened|updated|resolved`, `cloud_target.unhealthy`, `ping`.

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/webhooks` | list / create → `{ webhook, secret }` |
| PATCH/DELETE | `/webhooks/:id` | update (url, events, enabled) / delete |
| POST | `/webhooks/:id/rotate-secret` | → `{ secret }` |
| POST | `/webhooks/:id/test` | sends a `ping` delivery |
| GET | `/webhooks/:id/deliveries` | last 50 deliveries |
| POST | `/webhooks/:id/deliveries/:deliveryId/redeliver` | |

## CI/CD intake

| Method | Path | Body |
|---|---|---|
| POST | `/applications/:name/versions` | `{ version, imageUri, digest: "sha256:…", architectures? }` (scope `applications:write`) |
| POST | `/templates/validate` | `{ source, planCode? }` → validation report (stateless, no template id) |

## Import (IaC → OrkStage template)

The scan engine (`orkstage-scan`, Rust, also compiled to WebAssembly for the platform)
turns IaC and project files into a **ScanReport**; the platform turns it into a draft template.

| Method | Path | Body / result |
|---|---|---|
| POST | `/imports` | `{ files: { path, content }[] }` (≤ 5 MB total, text only) **or** `{ report: ScanReport }` (already scanned by the CLI) → `ImportDto` |
| GET | `/imports/:id` | `ImportDto` |
| POST | `/imports/:id/template` | `{ name, displayName }` → creates a DRAFT template from the import → `TemplateDto` |

`ImportDto = { id, createdAt, sourceKinds[], report: ScanReport, validation: { valid, issues[] } }`

### ScanReport (version 1)

```ts
interface ScanReport {
  version: 1;
  generator: string;                 // "orkstage-scan/0.1.0"
  detectors: { kind: SourceKind; files: number }[];
  resources: DetectedResource[];     // mapped to OrkStage logical types
  unmapped: { source: SourceRef; type: string; reason: string }[];
  connections: { from: string; to: string; protocol: string; port?: number; evidence: string }[];
  template: string;                  // generated platform/v1 EnvironmentTemplate YAML
  warnings: string[];
}
type SourceKind = 'terraform' | 'cloudformation' | 'sam' | 'cdk' | 'serverless' | 'pulumi'
  | 'kubernetes' | 'helm' | 'compose' | 'dockerfile' | 'package' | 'bicep' | 'arm';
interface SourceRef { kind: SourceKind; file: string; line?: number; address: string } // e.g. aws_db_instance.main
interface DetectedResource {
  id: string;                        // template resource id, e.g. "database"
  type: 'network' | 'compute.container-service' | 'container-registry' | 'database.postgresql'
      | 'cache.redis' | 'queue' | 'object-storage' | 'ingress' | 'dns';
  provider: 'aws' | 'azure' | 'gcp' | 'oci' | null;   // null = provider-neutral evidence (compose, packages)
  implementation?: string;           // capability id when evident, e.g. "ecs-fargate", "rds-postgres"
  properties: Record<string, unknown>; // mapped template fields (replicas, cpu, memoryMiB, port, size, storageGiB, ...)
  sources: SourceRef[];
  confidence: 'high' | 'medium' | 'low';
}
```

Mapping rules live in the engine (one place) and are covered by fixtures per source kind.
