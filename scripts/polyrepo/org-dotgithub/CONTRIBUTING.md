# Contributing to OrkStage

Thanks for your interest. Bug reports, documentation fixes, new detectors for the scan engine,
modules and adapters are all welcome.

## Before you start

- **Questions** go to [GitHub Discussions](https://github.com/orgs/orkstage/discussions), not
  to issues.
- **Bugs and feature requests** go to the issues of the repository that owns the code. Search
  first; add your case to an existing issue when there is one.
- **Larger changes** (a new provider, a schema change, a new API surface) start with an issue or
  a discussion, so we can agree on the approach before you write the code. Design decisions are
  recorded as ADRs in [`orkstage/docs/adr`](https://github.com/orkstage/orkstage/tree/main/docs/adr).
- **Security issues** never go to public issues. See [SECURITY.md](SECURITY.md).

## Where the code lives

| Repository | Stack | Setup |
|---|---|---|
| [`orkstage`](https://github.com/orkstage/orkstage) | TypeScript, NestJS, Prisma, BullMQ | [CONTRIBUTING](https://github.com/orkstage/orkstage/blob/main/.github/CONTRIBUTING.md) |
| [`orkstage-console`](https://github.com/orkstage/orkstage-console) | TypeScript, Next.js, React | [CONTRIBUTING](https://github.com/orkstage/orkstage-console/blob/main/.github/CONTRIBUTING.md) |
| [`orkstage-cli`](https://github.com/orkstage/orkstage-cli) | Rust, WebAssembly | [CONTRIBUTING](https://github.com/orkstage/orkstage-cli/blob/main/.github/CONTRIBUTING.md) |
| [`orkstage-modules`](https://github.com/orkstage/orkstage-modules) | OpenTofu | [CONTRIBUTING](https://github.com/orkstage/orkstage-modules/blob/main/.github/CONTRIBUTING.md) |
| [`orkstage-site`](https://github.com/orkstage/orkstage-site) | Next.js, Fumadocs, MDX | [README](https://github.com/orkstage/orkstage-site#quickstart) |
| [`orkstage-dev`](https://github.com/orkstage/orkstage-dev) | Docker Compose, git submodules | [README](https://github.com/orkstage/orkstage-dev#quickstart) |

## Workflow

1. Fork the repository and create a branch from `main`.
2. Make the change with tests. Keep pull requests focused: one concern per pull request.
3. Run the checks listed in the repository's CONTRIBUTING file. CI runs the same ones.
4. Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org)
   style, for example `feat(aws): ECS service autoscaling` or `fix(cli): exit code on timeout`.
5. Open the pull request and fill in the template. A maintainer reviews it; expect questions.

## What we look for

- **Honest status.** Simulated providers stay labeled as simulated, and features in Preview or
  planned are described that way, in code, UI and docs.
- **No secrets** in code, fixtures, logs, screenshots or OpenTofu state.
- **Tests** for behavior changes, and docs for anything a user can see.
- **Plain writing** in docs and UI text: short sentences, active voice, sentence case headings,
  no marketing filler.

## Contributor license agreement

The OrkStage core is offered under the AGPL and under a commercial license, so contributions
will need a short Contributor License Agreement (in the style of the Apache ICLA), signed once
through a bot on your first pull request. The CLA text is in legal review. Until the bot is
active, a maintainer will contact you before your first contribution is merged.

Contributions to `orkstage-modules` (Apache-2.0) and `orkstage-site` (MIT, CC BY 4.0) follow
the same process.

## Code of conduct

Everyone taking part in OrkStage spaces follows the [code of conduct](CODE_OF_CONDUCT.md).
