# Integration API: API keys, webhooks, import (v1)

The contract shared by the platform, the `ork` CLI and the docs. Base path: `/api/v1`.

## API keys

- Format: `ork_<env>_<prefix>_<secret>`, for example `ork_live_7f3a9c21_<43 url-safe chars>`.
  `env` is `live` or `test`. The `prefix` (8 hex characters) is stored and shown; of the full
  token, only its SHA-256 hash is stored. The token is returned **once**, at creation.
- Send it as `Authorization: Bearer <token>`. Bearer requests need no CSRF header and no cookie.
- A key belongs to an **organization** and optionally to a **tenant**:
  - a tenant key acts with a `role` of `CustomerAdmin`, `CustomerDeveloper` or `CustomerViewer`
    in that tenant;
  - an organization key (platform staff only) acts as `PlatformAdmin` or `PlatformOperator`.
- `scopes` further restrict what the role allows. Available scopes:
  `instances:read`, `instances:write`, `instances:deploy`, `templates:read`, `templates:write`,
  `applications:write`, `incidents:write`, `imports:write`, `webhooks:manage`, `audit:read`,
  `targets:manage` (platform keys: register, edit and validate cloud targets).
- `expiresAt` is optional. Keys can be revoked, and `lastUsedAt` is tracked. Every action taken
  with a key is audited with `actorType = API_KEY` and `actorLabel = "<key name> (<prefix>)"`.

| Method | Path | Body and result |
|---|---|---|
| GET | `/api-keys?tenantId=` | `ApiKeyDto[]` (never the token) |
| POST | `/api-keys` | `{ name, tenantId?, role, scopes[], expiresAt? }` returns `{ apiKey: ApiKeyDto, token }` |
| DELETE | `/api-keys/:id` | revokes the key, returns 204 |
| GET | `/me` | also works with keys; adds `apiKey: { id, name, prefix, scopes }` |

## Webhooks (outbound)

- Endpoint: `{ url, description?, events[], tenantId?, enabled }`. The `url` must use `https://`
  and must not resolve to private, loopback or link local addresses (`WEBHOOK_ALLOW_PRIVATE=true`
  relaxes this for local development only). No redirects; 10 second timeout.
- The signing secret `whsec_<base64url>` is returned once, at creation and on rotation, and is
  stored encrypted.
- Each delivery is a POST with the JSON body `{ id, type, createdAt, tenantId, data }` and these
  headers:
  - `OrkStage-Event: <type>`, `OrkStage-Delivery: <uuid>`
  - `OrkStage-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`

  Receivers must reject timestamps older than 5 minutes (replay protection).
- Retries: a response other than 2xx, or a network error, is retried with backoff (1 m, 5 m,
  30 m, 2 h, 6 h) before the delivery is marked FAILED. An endpoint is disabled automatically
  after 20 consecutive failed deliveries.
- Events: `deployment.started|succeeded|failed|awaiting_approval`, `instance.degraded`,
  `instance.drift_detected`, `incident.opened|updated|resolved`, `cloud_target.unhealthy`. Test
  deliveries use the type `ping` (sent by `POST /webhooks/:id/test`; nobody can subscribe to it).

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/webhooks` | list, or create and receive `{ webhook, secret }` |
| PATCH/DELETE | `/webhooks/:id` | update (url, events, enabled) or delete |
| POST | `/webhooks/:id/rotate-secret` | returns `{ secret }` |
| POST | `/webhooks/:id/test` | sends a `ping` delivery |
| GET | `/webhooks/:id/deliveries` | the last 50 deliveries |
| POST | `/webhooks/:id/deliveries/:deliveryId/redeliver` | |

## CI/CD intake

| Method | Path | Body |
|---|---|---|
| PUT | `/applications/:name` | `{ displayName, repository, port, registryKind?, healthPath?, readinessPath? }`: creates or updates the catalog entry (scope `applications:write`, idempotent) |
| POST | `/applications/:name/versions` | `{ version, imageUri, digest: "sha256:<hex>", architectures? }` (scope `applications:write`) |
| POST | `/templates/validate` | `{ source, planCode? }` returns a validation report (stateless, no template id) |

## Import (IaC to an OrkStage template)

The scan engine (`orkstage-scan`, written in Rust and also compiled to WebAssembly for the
platform) turns IaC and project files into a **ScanReport**, and the platform turns that report
into a draft template.

| Method | Path | Body and result |
|---|---|---|
| POST | `/imports` | `{ files: { path, content }[] }` (5 MB in total at most, text only) **or** `{ report: ScanReport }` (already scanned by the CLI); returns `ImportDto` |
| GET | `/imports/:id` | `ImportDto` |
| POST | `/imports/:id/template` | `{ name, displayName }` creates a DRAFT template from the import and returns `TemplateDto` |

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

The mapping rules live in the engine, in one place, and fixtures cover each source kind.
