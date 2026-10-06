# orkstage.io

Landing page and documentation for [OrkStage](https://orkstage.io): Next.js 16 with a static export,
[Fumadocs](https://fumadocs.dev) for the docs, Tailwind CSS 4. Becomes the `orkstage-site`
repository after the polyrepo split.

```bash
pnpm install
pnpm dev            # http://localhost:3100
pnpm build          # regenerates the API reference, then exports to out/
pnpm serve          # serves out/ like S3 + CloudFront, http://localhost:4321
pnpm typecheck
```

| Path | What |
|---|---|
| `app/(home)/page.tsx` | Landing page (server components only; artifacts in `components/landing/`). |
| `app/docs/` | Docs layout and page renderer (Fumadocs). |
| `content/docs/<section>/` | MDX pages. Each section's `meta.json` has `"root": true` (a sidebar tab). |
| `content/docs/developer/api-reference/` | Generated from `openapi/orkstage.json` (except `index.mdx`). |
| `openapi/orkstage.json` | OpenAPI document exported from the API (`/api/docs-json`). |
| `app/search.json`, `app/sitemap.ts`, `app/robots.ts`, `app/og.png` | Static search index, sitemap, robots, Open Graph image. |
| `public/brand/` | Official brand kit v3 assets (logo, mark, favicons). Never recolor or stretch. |
| `infra/` | S3 + CloudFront + ACM hosting (OpenTofu) and deploy steps. |

## Refreshing the API reference

```bash
pnpm openapi:refresh                         # from http://localhost:4000/api/docs-json
ORKSTAGE_API_URL=https://api.example.com pnpm openapi:refresh
```

## Writing docs

- Every page needs `title` and `description` front matter (SEO and search).
- Components available in MDX: `Callout`, `Cards`/`Card`, `Steps`/`Step`, `Tabs`/`Tab`,
  `Accordions`/`Accordion`, `Files`/`Folder`/`File`, `TypeTable`, and `Badge` (`Preview`,
  `planned`). Code blocks accept `title="…"` and `tab="…"` (code groups).
- Be exact about status: AWS is real, Azure and OCI are simulated, the `ork` CLI is Preview.
- "Edit this page" links point to `github.com/orkstage/orkstage-site/blob/main/content/docs/…`.

License: code MIT, content CC BY 4.0 (see the OrkStage open-core plan).
