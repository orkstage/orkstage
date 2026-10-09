# Contributing to the OrkStage modules

The organization guide ([CONTRIBUTING.md in orkstage/.github](https://github.com/orkstage/.github/blob/main/CONTRIBUTING.md))
covers the workflow, the CLA and the code of conduct. This file covers the module conventions.

## Checks CI runs

```bash
tofu fmt -check -recursive modules
for dir in modules/*/*/; do
  tofu -chdir="$dir" init -backend=false && tofu -chdir="$dir" validate
done
docker build -f docker/tofu-runner.Dockerfile -t orkstage/tofu-runner:local .
```

No OpenTofu on your machine? Run the same commands in the official image:

```bash
docker run --rm -v "$PWD:/w" -w /w --entrypoint sh ghcr.io/opentofu/opentofu:1.12.7 \
  -c 'tofu fmt -check -recursive modules'
```

## Module conventions

- One directory per logical resource kind: `modules/<cloud>/<kind>/`, with `main.tf` and
  `versions.tf`.
- Emit a `kind` output with the logical type. The platform wires dependencies by type.
- Take dependencies on other OrkStage resources as inputs (`vpc_id`, `subnet_ids`, `lb_sg_id`),
  not as data source lookups. Data sources are fine for things outside OrkStage, such as an
  existing hosted zone.
- No secrets in state: generate them as `ephemeral` values and use write only attributes
  (`password_wo`, `secret_string_wo`), then expose a Secrets Manager reference.
- Use the `name` input for every physical name so OrkStage naming and tagging stay consistent.
- Do not configure a provider or a backend inside a module; the runner generates both.
- Changes must keep working on MiniStack. If the emulator lacks a feature, degrade explicitly
  (for example fixed replicas when Application Auto Scaling is missing) and document it.

## Testing against MiniStack

The end to end path (worker, runner and MiniStack) lives in the core repository. Follow
[Run AWS locally with MiniStack](https://orkstage.io/docs/get-started/local-aws) and deploy an
instance that uses the module you changed.
