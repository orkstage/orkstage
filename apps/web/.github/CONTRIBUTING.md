# Contributing to the OrkStage console

The organization guide ([CONTRIBUTING.md in orkstage/.github](https://github.com/orkstage/.github/blob/main/CONTRIBUTING.md))
covers the workflow, the CLA and the code of conduct. This file covers the console.

## Checks

```bash
pnpm typecheck
pnpm build
```

Browser tests are planned (Playwright, acceptance flow). Until they exist, describe in the pull
request how you checked the change, with screenshots for visual changes in both the dark and
the light theme.

## Conventions

- Talk to the API only through `/api/*` (proxied by `next.config.ts`). Never call a cloud and
  never store a token in the browser.
- Request and response types come from `@orkstage/contracts`; do not redefine them here.
- Use the CASL rules from `/me` to hide what the user cannot do, but never as the only check:
  the API decides.
- Label simulated providers and resources as simulated wherever they appear.
- Brand assets in `public/brand/` are official. Never recolor, stretch, or add glow, shadow or
  gradient effects.
