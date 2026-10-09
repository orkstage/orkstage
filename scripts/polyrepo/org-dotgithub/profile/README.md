<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.svg">
    <img alt="OrkStage. Command every stage of your cloud." src="assets/banner-light.svg" width="100%">
  </picture>
</p>

**OrkStage is an open source multicloud control plane.** Describe an application environment
once (services, Postgres, cache, queue, storage, ingress, DNS), place each resource on the cloud
account and region that fits it, review the plan, the policies and an approximate cost, and let
OrkStage apply it with OpenTofu and keep watching its health. You run it on your own
infrastructure. AWS is provisioned for real today; Azure and OCI are simulated while their
adapters are built.

### Try it

```bash
git clone https://github.com/orkstage/orkstage.git && cd orkstage
docker compose -f infra/local/docker-compose.yml --profile platform --profile aws-emulator up -d --build --wait
```

Then open http://localhost:3000. The [quickstart](https://orkstage.io/docs/get-started/quickstart)
walks through the first deployment against a local AWS emulator.

### Repositories

| Repository | What it is | License |
|---|---|---|
| [**`orkstage`**](https://github.com/orkstage/orkstage) | The control plane: API, worker, shared packages | AGPL-3.0 |
| [`orkstage-console`](https://github.com/orkstage/orkstage-console) | Web console | AGPL-3.0 |
| [`orkstage-cli`](https://github.com/orkstage/orkstage-cli) | `ork` CLI and the scan engine that turns IaC into templates (Preview) | AGPL-3.0 |
| [`orkstage-modules`](https://github.com/orkstage/orkstage-modules) | OpenTofu modules behind every resource | Apache-2.0 |
| [`orkstage-site`](https://github.com/orkstage/orkstage-site) | orkstage.io and the documentation | MIT, CC BY 4.0 |
| [`orkstage-dev`](https://github.com/orkstage/orkstage-dev) | Every repository pinned, plus the local stack | MIT |

### Links

[Website](https://orkstage.io) |
[Documentation](https://orkstage.io/docs) |
[Discussions](https://github.com/orgs/orkstage/discussions) |
[Contributing](https://github.com/orkstage/.github/blob/main/CONTRIBUTING.md) |
[Security](https://github.com/orkstage/.github/blob/main/SECURITY.md)

If OrkStage is useful to you, a star on [orkstage/orkstage](https://github.com/orkstage/orkstage)
helps other platform engineers find it.
