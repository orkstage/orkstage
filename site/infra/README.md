# Hosting orkstage.io on S3 + CloudFront

The site is a Next.js **static export** (`out/`): HTML, JS, CSS, the Orama search index
(`/search.json`), `sitemap.xml`, `robots.txt` and `og.png`. No server, no Lambda@Edge.

`main.tf` (OpenTofu / Terraform, AWS provider 6) describes the hosting. It is documentation: it has
not been applied. Review it, add a state backend, and apply it from your own pipeline.

| Resource | Purpose |
|---|---|
| S3 bucket (private, versioned, encrypted) | Holds `out/`. Only CloudFront can read it (Origin Access Control). |
| ACM certificate (us-east-1) | `orkstage.io` + `www.orkstage.io`, DNS-validated in Route 53. |
| CloudFront Function (viewer request) | `/docs/` → `/docs/index.html`; `/docs` → 301 `/docs/`; `www.` → 301 apex. |
| Response headers policy | HSTS (2 years, preload), `nosniff`, `DENY` framing, strict referrer. |
| CloudFront distribution | HTTP/2 + HTTP/3, IPv6, `CachingOptimized`, 403/404 → `/404.html` (status 404). |
| Route 53 A/AAAA aliases | Apex and `www` to the distribution. |

## One-time setup

```bash
cd site/infra
tofu init
tofu apply -var 'zone_id=<hosted zone id of orkstage.io>'
# outputs: bucket, distribution_id
```

## Deploying a build

```bash
cd site
pnpm install --frozen-lockfile
pnpm build                                   # → out/

BUCKET=$(tofu -chdir=infra output -raw bucket)
DIST=$(tofu -chdir=infra output -raw distribution_id)

# 1. Fingerprinted assets: cache for a year.
aws s3 sync out/_next "s3://$BUCKET/_next" --delete \
  --cache-control "public, max-age=31536000, immutable"

# 2. Everything else (HTML, RSC payloads, search index, sitemap, images): revalidate.
aws s3 sync out "s3://$BUCKET" --delete --exclude "_next/*" \
  --cache-control "public, max-age=0, must-revalidate"

# 3. Make CloudFront pick up the new HTML.
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*"
```

Upload `_next/` first so new HTML never references assets that are not there yet. `--delete` removes
pages that no longer exist; S3 versioning keeps the previous objects for rollback.

## CI (GitHub Actions sketch)

Use OIDC federation to an IAM role allowed to `s3:PutObject`/`s3:DeleteObject`/`s3:ListBucket` on the
bucket and `cloudfront:CreateInvalidation` on the distribution; no long-lived keys.

```yaml
permissions: { id-token: write, contents: read }
steps:
  - uses: actions/checkout@v5
  - uses: pnpm/action-setup@v4
  - uses: actions/setup-node@v5
    with: { node-version: 24, cache: pnpm }
  - run: pnpm install --frozen-lockfile && pnpm build
  - uses: aws-actions/configure-aws-credentials@v5
    with: { role-to-assume: "${{ vars.SITE_DEPLOY_ROLE_ARN }}", aws-region: us-east-1 }
  - run: ./scripts/deploy.sh   # the three commands above
```

## Local check

`pnpm serve` serves `out/` with the same rules (directory index, 404 page) on http://localhost:4321.
