# @orkstage/cloud-coreweave

CoreWeave provider for OrkStage. VPCs and AI Object Storage buckets are created with the
`coreweave/coreweave` OpenTofu provider. Container services and ingress routes are Kubernetes
objects on an existing CoreWeave Kubernetes Service (CKS) cluster, created with the
`hashicorp/kubernetes` provider. OpenTofu state lives in an AI Object Storage bucket you own.

CoreWeave has no managed PostgreSQL, Redis or queue service, so those kinds are not in the
catalog. Place them on another provider in the same instance; a CoreWeave service that depends on
them receives their connection settings as environment variables and their credentials as a
Kubernetes Secret (see "Dependencies on other providers").

## Target configuration

Stored on the cloud target (`config`), no secrets:

| Field | Required | Meaning |
| --- | --- | --- |
| `stateBucket` | yes | AI Object Storage bucket for OpenTofu state. Must exist before deploying. |
| `clusterName` | for services and ingress | Existing CKS cluster that workloads deploy into. |
| `zone` | no | Zone of the cluster and the state bucket, e.g. `US-EAST-04A`. Defaults to the deployment region. |
| `stateEndpoint` | no | S3 endpoint for state. Defaults to `https://cwobject.com`. |
| `ingressClassName` | no | IngressClass for ingress routes. Defaults to `traefik`. |
| `clusterIssuer` | no | cert-manager ClusterIssuer for TLS routes. Defaults to `letsencrypt-prod`. |
| `ingressDomain` | no | DNS suffix served by the ingress controller. Defaults to `<organization id>-<clusterName>.coreweave.app`. |

Regions (`allowedRegions`, `defaultRegion`) are CoreWeave zone names such as `US-EAST-04A`. VPCs
and buckets are created in the deployment region.

## Credentials

The secret behind `credentialRef` (`env://NAME` or `aws-sm://name`) is a JSON object:

```json
{
  "token": "CW-SECRET-<secret>",
  "stateAccessKeyId": "<access key id>",
  "stateSecretAccessKey": "<secret key>",
  "kubeconfig": "optional, raw or base64"
}
```

- `token`: a CoreWeave API access token (Console, Tokens). The OpenTofu runner receives it as
  `COREWEAVE_API_TOKEN`. CKS managed auth accepts the same token as a Kubernetes bearer token, so
  with `clusterName` set no kubeconfig is needed: the adapter looks up the cluster's API server
  endpoint through the CKS API.
- `stateAccessKeyId` and `stateSecretAccessKey`: an AI Object Storage access key that can read and
  write the state bucket and the buckets OrkStage creates.
- `kubeconfig`: only for clusters reached another way (a private endpoint, a different token).
  The current context's server, `certificate-authority-data` and bearer `token` are used; client
  certificates and exec plugins are not supported.

Cluster access reaches OpenTofu as `TF_VAR_k8s_host`, `TF_VAR_k8s_token` and `TF_VAR_k8s_ca` for one
command; nothing is written to disk and no secret is part of the configuration.

## State storage

AI Object Storage is S3 compatible and only accepts virtual hosted style requests
(`https://<bucket>.cwobject.com`). Before the first deployment:

1. As an organization admin, create an organization access policy that lets the principal behind
   the access key use AI Object Storage (Console, Object Storage, Policies). Without a policy every
   S3 request is denied.
2. Create an access key (Console, Object Storage, Keys) and put it in the credential secret.
3. Create a versioned bucket:

```sh
aws configure set s3.addressing_style virtual --profile cw
aws configure set aws_access_key_id <access key id> --profile cw
aws configure set aws_secret_access_key <secret key> --profile cw
aws s3api create-bucket --bucket acme-orkstage-state --endpoint-url https://cwobject.com \
  --create-bucket-configuration LocationConstraint=US-EAST-04A --profile cw
aws s3api put-bucket-versioning --bucket acme-orkstage-state --endpoint-url https://cwobject.com \
  --versioning-configuration Status=Enabled --profile cw
```

The S3 backend runs with `use_path_style = false` and without native locking (conditional writes
are not confirmed for AI Object Storage); OrkStage already runs one operation per resource at a time.

## Minimum permissions

- API token: read the caller identity, list CKS clusters, create and delete VPCs, create and
  delete AI Object Storage buckets and their versioning and lifecycle settings.
- In the cluster (the token's Kubernetes RBAC): create and delete namespaces, and in them
  Deployments, Services, Ingresses, HorizontalPodAutoscalers and Secrets; read pods and pod logs;
  patch Deployments (restart action).
- AI Object Storage access key: read and write the state bucket; read the buckets OrkStage creates
  (health checks).

## Capabilities

| Kind | Capability | Module | Notes |
| --- | --- | --- | --- |
| `network` | `vpc` (default) | `network` | `coreweave_networking_vpc` with pod, service and internal load balancer prefixes ready for a CKS cluster. One zone; internet egress is built in. |
| `compute.container-service` | `cks-deployment` (default) | `container-service` | Namespace, Deployment, Service, optional HorizontalPodAutoscaler and Ingress on the target's cluster. Features: `gpu`, `autoscaling`, `public-ingress`. |
| `object-storage` | `ai-object-storage` (default) | `object-storage` | `coreweave_object_storage_bucket`, optional versioning and expiration rule. Private. |
| `ingress` | `cks-ingress` (default) | `ingress` | Host name under the cluster domain, served by the installed controller (CoreWeave Traefik chart) with cert-manager TLS. |

### Container services

- `cpu` and `memoryMiB` become resource requests; memory is also the limit.
- `public: true` creates a `LoadBalancer` Service with the
  `service.beta.kubernetes.io/coreweave-load-balancer-type: public` annotation; the module waits for
  the public IP and outputs `url`.
- `autoscaling` creates a HorizontalPodAutoscaler on CPU; the Deployment then leaves the replica
  count to it.
- GPUs come from `overrides.coreweave.gpu` in the template:

```yaml
overrides:
  coreweave:
    gpu: { count: 1, class: H100_NVLINK_80GB }
```

  `count` (1 to 8) becomes the `nvidia.com/gpu` limit; `class` adds required node affinity on the
  `gpu.nvidia.com/class` node label. Check the class values on your nodes with
  `kubectl get nodes -L gpu.nvidia.com/class`.
- Outputs: `service_id` (`namespace/deployment`), `namespace`, `deployment`, `service_name`,
  `image`, `gpu_count`, `url` (public or ingress URL), `internal_url` (cluster DNS).
- Action `restart`: rolling restart through a pod template annotation, like
  `kubectl rollout restart`. OpenTofu ignores that annotation so it does not undo the restart.

### Ingress

Services attach themselves to the ingress (they depend on it): each routed service creates an
Ingress object for its path in its own namespace, with the ingress host, the IngressClass and, when
`tls` is on, the `cert-manager.io/cluster-issuer` annotation. The controller merges them under one
host. The ingress module itself only creates a namespace that records the host, and outputs `url`.
Install the CoreWeave Traefik and cert-issuer charts (or set `ingressClassName`, `clusterIssuer` and
`ingressDomain` for your own controller) before deploying.

### Dependencies on other providers

Connection settings of dependencies (`<ID>_HOST`, `<ID>_PORT`, `<ID>_URL`, `<ID>_BUCKET`,
`<ID>_ENDPOINT`) are plain environment variables. Credentials published through `secret_ref` (for
example a PostgreSQL password on AWS or Supabase) are read from the owning provider at deploy time
and stored in the Kubernetes Secret `<name>-deps`, loaded with `envFrom` as `<ID>_PASSWORD`,
`<ID>_USERNAME`, `<ID>_URL` and so on. They pass to OpenTofu as the sensitive `TF_VAR_secret_env`
and are kept in the OpenTofu state, like any Kubernetes Secret managed by OpenTofu.

## Health and existence

| Kind | Check |
| --- | --- |
| `network` | `GET /v1beta1/networking/vpcs/{id}` on the CoreWeave API |
| `compute.container-service` | Kubernetes API: Deployment available replicas against desired; falls back to the public URL when the API server is unreachable |
| `object-storage` | S3 `HeadBucket` with the state access key |
| `ingress` | HTTP request to the ingress URL |

A 404 from these APIs means the resource is gone. Logs are the last lines of up to three pods.

## Known limits

- OrkStage does not create CKS clusters or node pools: workloads go to the cluster in
  `clusterName` (or the kubeconfig). The `vpc` capability is not attached to that cluster.
- Images must be pullable by the cluster nodes; registry pull secrets are not managed.
- AI Object Storage access keys are scoped to a principal, not a bucket, so buckets publish no
  `secret_ref` and other providers cannot be handed credentials for them.
- Buckets have no force destroy: empty a bucket before deleting it.
- Several routed services request their own certificate for the same host (one per namespace);
  mind the Let's Encrypt duplicate certificate limit.
- GPU hours are billed per node and are not part of the cost estimate.
