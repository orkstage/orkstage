# `ork` command reference

The `ork` CLI is in **Preview**: commands and flags can still change between releases.

## Commands

| Command | What it does |
|---|---|
| `ork login [--api-url URL] [--with-token]` | Stores an API key for that API URL (from `--token` or `ORK_TOKEN`, from stdin with `--with-token`, or from a prompt). The key is verified with `GET /me` unless you pass `--no-verify`. |
| `ork logout` / `ork whoami` | Forgets the key, or shows the user, key name, scopes and tenants. |
| `ork init [--name] [--tenant] [--environment] [--yes] [--force] [PATH]` | Scans the project and creates `.ork/`. Interactive unless `--yes` is set or stdin is not a TTY. |
| `ork scan [PATH] [--format table\|json] [--write]` | Walks and scans in parallel. `PATH` can be a directory or a single file. `--write` refreshes `.ork/inventory.json` and `.ork/template.yaml`. |
| `ork template validate [-f FILE] [--plan CODE]` | Calls `POST /templates/validate` and exits with 1 when the template is invalid. |
| `ork template push [-f FILE]` | Creates the template, or adds a DRAFT version. When the local version is not newer than the server's, it bumps the patch version and updates the file. |
| `ork template diff [-f FILE] [--exit-code]` | Unified diff between the local template and the latest version on the server. |
| `ork import [PATH] [--tenant]` | Scans locally and sends `POST /imports { report }`. Your code never leaves your machine. Prints the import id and its console URL. |
| `ork instances list [--tenant]` | Lists the instances you can see. |
| `ork deploy [--instance SLUG] [--wait] [--timeout S]` | Deploys. `--wait` streams `/deployments/:id/events` and exits with a nonzero code on failure. |
| `ork status [--instance SLUG]` | Shows the instance, its resources and the last deployment. |
| `ork logs <resource> [--instance SLUG] [-n N]` | Shows recent log lines of a resource. |
| `ork destroy --instance SLUG --confirm SLUG [--wait]` | Destroys an instance. |
| `ork completions <shell>` | Prints completions for `bash`, `zsh`, `fish`, `powershell` or `elvish`. |

## Global flags

| Flag | Environment | Meaning |
|---|---|---|
| `--api-url` | `ORK_API_URL` | OrkStage API base URL |
| `--token` | `ORK_TOKEN` | API key |
| `-o`, `--output table\|json` | `ORK_OUTPUT` | Output format |
| `--no-color` | `NO_COLOR` | Disable colors |
| `-v`, `-vv`, `-vvv` | `ORK_LOG=debug` | Logs on stderr |
| `-C DIR` | | Run as if started in `DIR` |

**Precedence:** flags, then environment variables, then `.ork/config.toml`, then the user
configuration.

## Exit codes and JSON output

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Failure |
| `2` | Usage error |
| `3` | Authentication or authorization error |
| `4` | Not found |

With `-o json`, stdout carries exactly one JSON document with a deterministic key order, and
errors are printed on stderr as
`{ "error": { code, message, status, correlationId, help, exitCode } }`. API errors always show
the platform's message and correlation id.

## Credentials

Keys are stored per API URL in the operating system keychain (macOS Keychain, Windows Credential
Manager, Secret Service on Linux). Where no keychain is reachable (containers, CI without a
desktop session) they go to `credentials.toml` (mode 0600) in the user configuration directory:

| OS | Directory |
|---|---|
| Linux | `~/.config/ork` |
| Windows | `%APPDATA%\OrkStage\ork\config` |
| macOS | `~/Library/Application Support/dev.OrkStage.ork` |

`ORK_CONFIG_DIR` moves that directory, and `ORK_CREDENTIALS_STORE=file` forces the file. Keys are
never written to the project.

## The `.ork/` directory

```text
.ork/
├── config.toml      # committed: api_url, tenant, template name, instance slug/environment,
│                    #            placement bindings, scan include/exclude
├── template.yaml    # committed: the platform/v1 template (generated, then yours to edit)
├── inventory.json   # local: the last ScanReport (ignored by .ork/.gitignore)
└── .gitignore
```

```toml
api_url = "https://orkstage.example.com"
tenant = "acme"

[template]
name = "shop"

[instance]
slug = "shop-staging"
environment = "staging"

# Placement slot → cloud target (name or id) and region, one line per slot of the template.
[placements]
primary = { target = "aws-staging", region = "us-east-1" }
data = { target = "azure-data", region = "westeurope" }

[scan]
include = []
exclude = ["examples/**"]
```

## Using it in CI

Create an API key with only the scopes the pipeline needs and pass it through the environment;
the CLI never prompts when stdin is not a TTY.

```sh
export ORK_API_URL=https://orkstage.example.com ORK_TOKEN=${{ secrets.ORK_TOKEN }}
ork -o json template push
ork deploy --instance shop-staging --wait            # nonzero exit if the deployment fails
```

The [CI/CD guide](https://orkstage.io/docs/developer/ci-cd) covers API key scopes and the image
catalog endpoints.
