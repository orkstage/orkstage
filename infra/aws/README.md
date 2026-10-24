# AWS

Files to connect AWS accounts to OrkStage. The steps are in the docs:
https://orkstage.io/docs/self-hosting/connect-aws/

| File | Where it goes |
|---|---|
| `orkstage-control-plane-policy.json` | The identity OrkStage itself runs as (the EC2 instance profile role or IAM user of the API and worker), in the account where that identity lives. It may assume the deployment role in every connected account and read the external ids stored under `orkstage/` in Secrets Manager. Narrow `Resource` to the list of role ARNs when you know them; drop the second statement when you use `env://` references only. |
| `orkstage-tofu-runner-task.json`, `orkstage-tofu-runner-policy.json` | Only with `TOFU_RUNNER=ecs` (ADR 0016): the ECS task definition of the OpenTofu runner (EFS work volume, user 10001, no task role) and the permissions the worker's task role needs to start, watch and stop it. Replace the upper case placeholders. |
| `orkstage-deployment-role.yaml` | Each AWS account OrkStage deploys into: a CloudFormation stack with the deployment role, its external id and the permissions the OpenTofu modules need. A unit test in `packages/cloud-aws` keeps it in sync with the modules. |

One control plane identity serves any number of accounts; each account gets its own role stack and
its own external id.
