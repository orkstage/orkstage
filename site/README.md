<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/banner-light.svg">
    <img alt="OrkStage site. Website and documentation for orkstage.io." src=".github/assets/banner-light.svg" width="100%">
  </picture>
</h1>

<p align="center">
  <b>The source of <a href="https://orkstage.io">orkstage.io</a>: the landing page and the OrkStage documentation, built as a static site.</b>
</p>

<p align="center">
  <img alt="License: MIT (code), CC BY 4.0 (content)" src="https://img.shields.io/badge/license-MIT%20%2B%20CC%20BY%204.0-00F29B?labelColor=1A1D26">
  <a href="https://github.com/orkstage/orkstage-site/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/orkstage/orkstage-site/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://orkstage.io/docs"><img alt="Docs: orkstage.io/docs" src="https://img.shields.io/badge/docs-orkstage.io-00F29B?labelColor=1A1D26"></a>
</p>

## What it is

Next.js 16 with a static export, [Fumadocs](https://fumadocs.dev) for the documentation, and
Tailwind CSS 4. The build produces plain files in `out/` (pages, search index, sitemap, Open Graph
image) that S3 and CloudFront serve without any server code. The API reference is generated from
the OpenAPI document the OrkStage API exports.

```mermaid
flowchart LR
  mdx["content/docs<br/>MDX pages"] --> build["next build<br/>static export"]
  openapi["openapi/orkstage.json<br/>exported by the API"] --> gen["generate-api-reference"] --> build
  build --> out["out/"] --> s3["S3 + CloudFront<br/>orkstage.io"]
```

## Quickstart

Requirements: Node 24+ and pnpm 12. This directory is its own pnpm workspace.

```bash
pnpm install
pnpm dev            # http://localhost:3100
pnpm build          # regenerates the API reference, then exports to out/
pnpm serve          # serves out/ the way S3 and CloudFront do, http://localhost:4321
pnpm typecheck      # types, plus check:i18n and check:prose
pnpm check:i18n     # English and Portuguese dictionaries: same keys, writing rules, lengths
pnpm check:prose    # writing rules for every handwritten docs page
pnpm check:site     # after a build: links, anchors, sitemap, hreflang, canonical, JSON-LD, headings
```

## Layout

| Path | What it holds |
|---|---|
| `app/(en)/` | English root layout (`lang="en"`): the landing page at `/`, the docs at `/docs`, the English Open Graph image. |
| `app/(pt)/pt-br/` | Brazilian Portuguese root layout (`lang="pt-BR"`): the landing page at `/pt-br/` and its Open Graph image. Docs stay in English. |
| `app/` | Search index, sitemap (with hreflang alternates), robots and the bilingual 404 page. |
| `lib/i18n/` | Locale config and the typed message dictionaries (`messages/en.ts`, `messages/pt-br.ts`). |
| `lib/seo.ts` | Titles, descriptions, canonical URLs, hreflang, Open Graph and Twitter metadata, JSON-LD. |
| `content/docs/<section>/` | MDX pages. Each section's `meta.json` has `"root": true`, which makes it a sidebar tab. |
| `content/docs/developer/api-reference/` | Generated from `openapi/orkstage.json` (except `index.mdx`). |
| `openapi/orkstage.json` | The OpenAPI document exported by the API (`/api/docs-json`). |
| `public/brand/` | Official brand assets (logo, mark, favicons). Never recolor or stretch them. |
| `infra/` | S3, CloudFront and ACM hosting in OpenTofu, and the deploy steps. |
| `scripts/` | API reference generation, OpenAPI refresh, the local static server, content checks. |

## Refreshing the API reference

```bash
pnpm openapi:refresh                                     # from http://localhost:4000/api/docs-json
ORKSTAGE_API_URL=https://api.example.com pnpm openapi:refresh
```

## Writing docs

- Every page needs `title` and `description` front matter, for search engines and the search
  index.
- Components available in MDX: `Callout`, `Cards` and `Card`, `Steps` and `Step`, `Tabs` and `Tab`,
  `Accordions` and `Accordion`, `Files`, `Folder` and `File`, `TypeTable`, and `Badge` (`Preview`,
  `planned`). Code blocks accept `title="..."` and `tab="..."` (code groups).
- Be exact about status: AWS is real, Azure and OCI are simulated, the `ork` CLI is in Preview.
- "Edit this page" links point to `github.com/orkstage/orkstage-site/blob/main/content/docs/`.
- Run `pnpm check:prose` before opening a pull request.

## Deploying

The hosting is described in [`infra/main.tf`](infra/main.tf) and has not been applied yet. The
steps (one time setup, then sync of `out/` and a CloudFront invalidation) are in
[`infra/README.md`](infra/README.md).

## Related repositories

| Repository | Role |
|---|---|
| [`orkstage`](https://github.com/orkstage/orkstage) | Control plane; its CI exports the OpenAPI document used here |
| [`orkstage-console`](https://github.com/orkstage/orkstage-console) | Web console |
| [`orkstage-cli`](https://github.com/orkstage/orkstage-cli) | `ork` CLI and scan engine |
| [`orkstage-modules`](https://github.com/orkstage/orkstage-modules) | OpenTofu modules |
| [`orkstage-dev`](https://github.com/orkstage/orkstage-dev) | Runs the whole stack locally |

## Contributing

Fixes to the docs are the easiest way to contribute: use "Edit this page" on any page, or open a
pull request here. The organization [contributing guide](https://github.com/orkstage/.github/blob/main/CONTRIBUTING.md)
covers the workflow and the code of conduct.

## Security

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/orkstage/orkstage-site/security/advisories/new)
or to security@orkstage.io.

## License

Code under the MIT License; documentation content under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The OrkStage name and logo are
trademarks and are not covered by either license.
