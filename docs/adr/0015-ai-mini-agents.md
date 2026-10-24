# ADR 0015: AI mini agents attached to templates

**Status:** proposed on October 23, 2026 (orkstage-dev `docs/open-items.md`, item 29). Not built.

## Context

Operators read plans, policy results, cost estimates, health, metrics and logs, and ask the same
questions every time: is this change risky, why does it cost this much, what is wrong with this
service. Language models answer such questions well when they get the right context, and badly or
dangerously when they get too much power: a model that can deploy, approve or read secrets is a new
way to break production or leak credentials.

The platform already has what an assistant needs as input (the plan, policies, estimates with their
sources, health and metrics) and a vocabulary of operations people can run (the action catalog,
ADR 0009). What it lacks is a safe way to put a model in between.

## Decision

1. **Small, single purpose agents, attached by the template.** A template lists the agents it wants
   and when they run: before a deployment, on its plan, or after it, on the running resources.
   First modules: **security** (public exposure, encryption, secrets in variables), **FinOps**
   (explain the estimate, cheaper sizes or regions, waste) and **insights** (a plain summary and the
   risk of a change; explanations of incidents and trends). A template opts in per module and per
   phase; nothing runs by default.

   ```yaml
   agents:
     - module: security
       on: [plan]
     - module: finops
       on: [plan, deployment]
   ```

2. **Read only, always.** Agents read the plan, the template, policy results, the estimate,
   resource outputs, health, metrics and recent logs. They never deploy, approve, change or destroy
   anything, and never see cloud credentials or secret values: the context builder starts from
   the same views the console shows (outputs with secret references hidden, logs redacted) and
   adds nothing a viewer could not read.

3. **Bring your own model.** A tenant configures a model provider (Anthropic, OpenAI or Google
   Gemini), a model and an API key as a secret reference (`env://`, `aws-sm://`), never a value in
   the database. Nothing goes to a provider that is not configured. One `ModelClient` interface
   hides the provider: system instructions, the context as data, a JSON schema for the answer, a
   timeout.

4. **Findings, not actions.** An agent returns findings: severity (`info`, `warn`, `risk`), a title,
   a plain explanation, the evidence it relied on (resource ids, policy ids, metric names) and,
   optionally, a proposed action from the catalog (ADR 0009) with its parameters. A person with the
   required role runs a proposed action; agents never do. Policies stay the only thing that blocks a
   deployment.

5. **Untrusted content stays data.** Template text, log lines, resource names and variable values
   can carry instructions written by anyone. The context builder delimits them as data, the system
   instructions say they are never instructions, the answer must match the schema (anything else is
   dropped), proposed actions must name catalog actions on resources of the instance, and the
   console renders findings as plain text (no links or markup from the model).

6. **Asynchronous and bounded.** Agents run on their own worker queue after the plan is ready and
   after a deployment finishes, never inside a request. Each run has a token and cost cap, each
   tenant a monthly cap; a run that would exceed it is skipped and says so.

7. **Everything is recorded.** Every run is audited: module, phase, model, a digest of the inputs it
   read, token counts, cost and the findings. Findings appear as comments on the plan and on the
   deployment, and a `warn` or `risk` finding sends a notification (`agent.finding`).

8. **Off until proven.** An `AI_AGENTS` feature flag, off by default, gates the feature for the
   platform or a tenant.

## Consequences

- A tenant gets explanations and suggestions without giving a model any power; the worst a bad
  answer can do is mislead a reader, and the evidence links let the reader check.
- The context builder is security critical: it gets its own tests (no secret reference values, no
  credentials, redacted logs) and every new input goes through it.
- Model costs belong to the tenant's own provider account; the caps protect it from loops and
  large contexts.
- First delivery: this ADR, then the security module end to end on the plan of a simulated
  instance, with a stubbed model provider in tests and a real one behind a key in a manual check.
