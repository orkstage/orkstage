# Security policy

OrkStage provisions infrastructure in other people's cloud accounts, so we take reports
seriously and handle them privately.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**

Use one of these private channels:

1. **GitHub Security Advisories (preferred).** Open the affected repository, go to
   **Security**, then **Report a vulnerability**. For the control plane, that is
   https://github.com/orkstage/orkstage/security/advisories/new.
2. **Email** security@orkstage.io.

Please include:

- the repository, and the version, release tag or commit;
- a description of the issue and its impact;
- steps to reproduce, or a proof of concept;
- any known workaround.

Do not include real credentials, customer data or anything you obtained from systems you do not
own.

## What to expect

| Step | Target |
|---|---|
| Acknowledgement of your report | within 3 business days |
| First assessment (confirmed or not, severity) | within 10 business days |
| Fix or mitigation for confirmed issues | depends on severity; we keep you updated at least every 2 weeks |
| Public disclosure | coordinated with you, after a fix is available |

We credit reporters in the advisory unless you prefer to stay anonymous. OrkStage does not run a
paid bug bounty program.

## Supported versions

OrkStage has not published a release yet; all components are in development or in Preview.
Until the first release, security fixes land on the `main` branch of each repository. After it,
the latest minor release receives fixes, and this table will list the supported versions.

| Component | Supported |
|---|---|
| `main` branch of every repository | Yes |
| Older commits | No |

## Scope

In scope: the code in the repositories of the `orkstage` organization, including the control
plane, the console, the `ork` CLI and scan engine, the OpenTofu modules, the runner image and the
website.

Out of scope:

- The local Docker Compose stack used as documented: it runs in development mode on purpose
  (development login, cookies without `Secure`, the Docker socket mounted) and must not be
  exposed to a network.
- Simulated providers, which never touch a real cloud.
- Vulnerabilities in third party dependencies without a demonstrated impact on OrkStage (report
  those upstream; we track them with Dependabot).
- Denial of service through traffic volume, social engineering, and physical attacks.

## Safe harbor

We will not pursue legal action against research done in good faith that follows this policy:
test only against your own installation, avoid privacy violations and service disruption, and
give us reasonable time to fix the issue before any disclosure.
