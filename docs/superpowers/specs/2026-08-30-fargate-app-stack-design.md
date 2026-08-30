# Serving the dashboard on ECS Fargate

**Date:** 2026-08-30
**Status:** Approved for planning
**Supersedes the hosting choice in** `docs/telegator-design.md` §9.3 L814

## 1. Why

`TelegatorAppStack` cannot be deployed. Creating an `AWS::Amplify::App` in
account `804459358303` (eu-central-1) fails:

> We've noticed an issue with your AWS account. To resolve this, please open a
> Billing Support Case.
> (Service: Amplify, Status Code: 401, HandlerErrorCode: AccessDenied)

`amplify:ListApps` succeeds and the deploy identity `telegator-deploy` holds
AdministratorAccess, so this is account standing — not IAM, and not the
template. Nothing in this repository can work around it. The stack failed its
first CREATE and sits in `ROLLBACK_COMPLETE`.

A probe of AWS App Runner as an alternative was also run: `CreateService` was
accepted but the service settled at `CREATE_FAILED`. App Runner is therefore not
a demonstrated escape either. Both probe resources (the App Runner service and a
test ECR repository) were deleted.

A secondary and explicit goal is **learning**: the operator chose this route to
work with VPC, ECS, ALB and PrivateLink directly. Construct-level choices below
are made for legibility, not for the shortest path to a running service.

## 2. The reconciliation

`docs/telegator-design.md` is authoritative and is not edited. §9.3 L814 reads:

> **Amplify Hosting**, which supports the App Router (SSR, server actions,
> streaming) natively with no OpenNext adapter or Fargate service.

This design does exactly what that line rules out. The divergence is deliberate
and its reason is §1: the chosen hosting cannot be created in this account. Per
`CLAUDE.md`, the divergence is recorded as a reconciliation in the comment that
makes it. Two code sites must carry it:

- `infra/lib/app-stack.ts` — the stack header comment, which currently quotes
  §9.3 L814 as its justification for Amplify.
- `next.config.ts` — whose comment currently rejects `output: "standalone"`
  *because* Amplify does not consume it.

A third site is a stale reference rather than a reconciliation:
`test/boundaries.test.ts` L20 describes the boundary as "what Amplify deploys".

§9.1 L804's stack inventory also changes: `TelegatorAppStack` is no longer an
"Amplify Hosting app", and a sixth stack is added (§5.1).

## 3. Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Hosting | ECS Fargate behind an ALB, fronted by CloudFront | §1 |
| Construct level | Hand-wired L2 | `ecs-patterns.ApplicationLoadBalancedFargateService` hides the VPC, security groups, target group and health check — the parts to be learned, and the parts most likely to misbehave |
| Task placement | Private subnets, NAT gateway | Textbook egress design; required regardless (§4.2) |
| PrivateLink | S3 + DynamoDB **gateway** endpoints only | Free; the S3 one takes ECR layer pulls off NAT data charges. Interface endpoints rejected — §4.2 |
| TLS | CloudFront (`*.cloudfront.net`) | No domain is controlled, so ACM cannot issue for an ALB. Cognito refuses non-HTTPS callbacks except `http://localhost` |
| CPU architecture | ARM64 | Native to the build machine (Apple Silicon), ~20% cheaper, and removes the `exec format error` class entirely |
| Image reference | `ContainerImage.fromEcrRepository(repo, tag)`, tag from context | `fromAsset` would run Docker during `cdk synth` and break the credential-free gate |

## 4. Findings that constrain the design

### 4.1 Cognito requires HTTPS callbacks

A user pool app client rejects non-HTTPS callback URLs, with `http://localhost`
as the only exception — which is why `infra/lib/auth-stack.ts` L36's
`DEFAULT_CALLBACK_URLS` is accepted today. An ALB serves HTTP on
`*.elb.amazonaws.com` and cannot obtain an ACM certificate, because ACM issues
only for domains whose control can be proven. CloudFront supplies HTTPS on its
own domain at no cost and with no domain ownership, and is therefore not
optional decoration: without it the hosted UI refuses to redirect back and no
login can complete.

### 4.2 PrivateLink cannot reach the Cognito hosted UI

`lib/auth/cognito.ts` L47 exchanges the authorisation code at
`${config.hostedUiDomain}/oauth2/token` — that is
`<prefix>.auth.eu-central-1.amazoncognito.com`.

`ec2 describe-vpc-endpoint-services` in eu-central-1 returns 393 services. The
only two matching Cognito are `cognito-identity` and `cognito-idp`. **There is
no VPC endpoint for the hosted UI domain.**

Consequences:

- A task in a private subnet with no internet egress reaches every AWS API it
  needs and still cannot complete a login. The redirect works, the callback
  fires, and the token exchange hangs. All four gates stay green.
- The JWKS fetch at `lib/auth/cognito.ts` L91 targets
  `cognito-idp.eu-central-1.amazonaws.com` and *is* covered — so a partial
  endpoint build would fail in only one of the two auth paths.
- A NAT gateway is therefore **mandatory**, not a cost choice. Interface
  endpoints (~$7.30/mo each per AZ; eight would be needed) would add roughly
  $58/mo and remove nothing, since NAT stays regardless. They are rejected, and
  a test pins their absence so the reasoning is not lost.

### 4.3 The default ALB health check kills every task

An ALB target group defaults to health-checking `/` with matcher `200`. Per
`CLAUDE.md`, every `app/**/page.tsx` calls `requireRole("viewer", …)`, so
unauthenticated `/` returns a redirect or a 401 — never 200. The target is
marked unhealthy, ECS replaces the task, and the service crashloops
indefinitely while `cdk synth` and all four gates remain green.

Resolved by a dedicated unauthenticated health route (§6.2).

### 4.4 The image/service ordering problem

An ECS service cannot start without an image already present in ECR. A stack
that creates both an empty repository and a service that pulls from it will
create the repository, fail to stabilise the service, wait out the CloudFormation
timeout, and roll back. The repository must therefore exist, and be populated,
before the app stack deploys (§5.1).

## 5. Infrastructure

### 5.1 Stacks

A sixth stack is introduced, diverging from §9.1 L804's inventory of five:

| Stack | Contents | Change |
| --- | --- | --- |
| `TelegatorRegistryStack` | The ECR repository, with a lifecycle rule | **New** |
| `TelegatorDataStack` | unchanged | — |
| `TelegatorQueueStack` | unchanged | — |
| `TelegatorAuthStack` | unchanged | — |
| `TelegatorPipelineStack` | unchanged | — |
| `TelegatorAppStack` | VPC, ECS, ALB, CloudFront, task + execution roles | **Rewritten** |

Deploy order: `Registry` → (build and push image) → `Data`, `Queue`, `Auth` →
`Pipeline` → `App`.

`TelegatorRegistryStack` holds only the repository so that it can be deployed
and populated independently of everything that consumes it (§4.4). It is passed
to `TelegatorAppStack` as a construct, matching the existing convention in
`infra/lib/app.ts` where CDK emits the cross-stack references itself.

### 5.2 Network topology

```
Internet
   │  HTTPS  (*.cloudfront.net)
   ▼
CloudFront distribution
   │  HTTP   (origin: ALB DNS)
   ▼
ALB :80 ────────────── public subnets, 2 AZs
   │                    SG-alb: ingress 80 from 0.0.0.0/0
   ▼
Target group :3000
   │
   ▼
Fargate task ───────── private-with-egress subnets
                        SG-task: ingress 3000 from SG-alb ONLY
   │
   ├── NAT gateway ──► Cognito hosted UI /oauth2/token, Secrets Manager,
   │                   SQS, Lambda, CloudWatch, cognito-idp
   ├── S3 gateway endpoint ──────► ECR image layers
   └── DynamoDB gateway endpoint ► sources, messages
```

Two availability zones are used because an ALB requires subnets in at least
two, even though exactly one task runs. This is an ALB constraint, not a
redundancy decision.

One NAT gateway (not one per AZ) — a single task in a single AZ does not
justify the second, and its absence is asserted so the choice is explicit.

### 5.3 `TelegatorAppStack` resources

Hand-wired L2 constructs:

- `Vpc` — 2 AZs; `PUBLIC` and `PRIVATE_WITH_EGRESS` subnet groups; `natGateways: 1`.
- `GatewayVpcEndpoint` ×2 — S3 and DynamoDB.
- `SecurityGroup` ×2 — `SG-alb` and `SG-task`, with `SG-task` ingress sourced
  from `SG-alb` on port 3000. This is the security-critical wire and is tested.
- `Cluster`.
- `FargateTaskDefinition` — 512 CPU / 1024 MiB, `runtimePlatform.cpuArchitecture: ARM64`,
  explicit task role and execution role.
- Container definition — image from ECR by tag, the environment of §5.4, and
  an `AwsLogDriver` writing to a `LogGroup` with a retention period.
- `FargateService` — `desiredCount: 1`, private subnets, `SG-task`,
  `healthCheckGracePeriod: 60s`.
- `ApplicationLoadBalancer` — internet-facing, public subnets, `SG-alb`.
- Listener on 80 → target group on 3000, health check path `/api/health`,
  matcher `200`, `deregistrationDelay: 30s`.
- `Distribution` — origin `LoadBalancerV2Origin(alb, { protocolPolicy: HTTP_ONLY })`;
  `viewerProtocolPolicy: REDIRECT_TO_HTTPS`; `allowedMethods: ALLOW_ALL`;
  `cachePolicy: CACHING_DISABLED`; `originRequestPolicy: ALL_VIEWER`.

Each CloudFront setting is load-bearing and named here because the default
breaks something specific: `ALLOW_ALL` because server actions are POST and the
default rejects them with 405; `CACHING_DISABLED` because §8.3's pages exist to
show live queue depths; `ALL_VIEWER` because without cookie forwarding the
session cookie never reaches the origin and no one stays signed in.

### 5.4 Roles and environment

`grantAppPermissions` is reused **verbatim**. Its policies are unchanged; only
the principal moves.

- **Task role** — `ecs-tasks.amazonaws.com`; carries everything
  `grantAppPermissions` grants today (DynamoDB, SQS, Lambda invoke,
  CloudWatch, Logs Insights, `cognito-idp:AdminGetUser`, the session secret).
- **Execution role** — `ecs-tasks.amazonaws.com`; ECR pull and log write only.

The environment variable list is carried over unchanged, keeping every name
from `handlers/env.ts` (`ENV_VARS`, `DASHBOARD_ENV_VARS`). No application code
reads a new name, and the session key remains an ARN fetched at runtime rather
than a value in the template.

`appUrl` and the Cognito callback/logout URLs are the CloudFront domain, which
does not exist until the distribution does. They continue to arrive by context,
exactly as they do for Amplify today, via the two-phase deploy of §7.

`CfnBranch`, `repositoryConnection`, `DEFAULT_BRANCH`, `NEXT_SSR_FRAMEWORK` and
the `repository` / `githubTokenSecretName` context keys are deleted. Amplify's
git-triggered build is replaced by §6.1's script.

## 6. Application changes

### 6.1 Container image

`next.config.ts` gains `output: "standalone"`, and its comment is rewritten as
a reconciliation (§2).

A multi-stage `Dockerfile`: dependency install, `next build`, then a runner
stage on `node:22-alpine` copying `.next/standalone`, `.next/static` and
`public`, running as a non-root user on port 3000 with **`HOSTNAME=0.0.0.0`**.
Next's standalone server binds loopback otherwise, which presents as a healthy
container whose every health check fails.

A build-and-push script under `scripts/` (where `biome` permits `console`):
build for `linux/arm64`, authenticate to ECR, push, and report the tag to pass
as `-c imageTag=`.

**Open risk:** `next build` evaluates module top-level code, and
`lib/auth/config.ts` calls `required(env, …)`. If that executes during the
build rather than per-request, the Docker build fails on absent environment
variables. To be established during implementation; mitigation is either
build-time placeholder values or making the read lazy. This is a build-order
question, not a design change.

### 6.2 Health route

`app/api/health/route.ts` returns a bare 200 with no authorisation check. It is
a `route.ts`, not a `page.tsx`, so `test/pageAuth.test.ts` — whose `pageFiles()`
matches `/(^|\/)page\.tsx$/` — is unaffected by construction rather than by
exemption.

It must remain the *only* unauthenticated surface, and a test asserts that.

## 7. Deploy sequence

1. Delete the `ROLLBACK_COMPLETE` `TelegatorAppStack` (it cannot be updated).
2. `cdk deploy TelegatorRegistryStack`.
3. Build and push the image; note the tag.
4. `cdk deploy` the Data, Queue, Auth and Pipeline stacks.
5. `cdk deploy TelegatorAppStack -c imageTag=<tag>`.
6. Read back the CloudFront domain.
7. Redeploy Auth and App with `-c appUrl=https://<domain>`,
   `-c callbackUrls=https://<domain>/api/auth/callback`.

Steps 6–7 are the same two-phase dance the Amplify path required, for the same
reason: the origin's domain does not exist until after its first deploy.

## 8. Testing

`infra/lib/app-stack.test.ts` is rewritten. Every existing IAM assertion is
kept — they assert the role's policies, which do not change — and the following
are added, each pinning a finding from §4:

- Task security group ingress is sourced from the ALB security group, not
  `0.0.0.0/0`. The security-critical assertion, and the justification for
  private subnets.
- Exactly one NAT gateway, and **zero interface endpoints** — pinning §4.2 so
  that a later cost optimisation cannot silently break login.
- S3 and DynamoDB gateway endpoints are present.
- Health check path is `/api/health` with matcher `200` (§4.3).
- `runtimePlatform.cpuArchitecture` is `ARM64`.
- **No Docker image asset appears in the synthesised template** — this guards
  the credential-free `cdk synth` gate.
- CloudFront: `ALLOW_ALL` methods, caching disabled, `ALL_VIEWER` origin
  request policy.
- Task role trust principal is `ecs-tasks.amazonaws.com`.

New `infra/lib/registry-stack.test.ts`. `test/boundaries.test.ts` L20's comment
is corrected. A test asserts the health route is the only unauthenticated
surface.

`test/acceptance.test.ts` was checked and contains no Amplify-dependent
criterion, so §11's acceptance mapping is unaffected.

All four gates must pass: `tsc --noEmit`, `vitest run`, `biome check .`,
`cdk synth`. No gate is weakened. `cdk synth` must remain credential-free *and*
Docker-free.

**Beyond the gates:** none of the four compiles or runs the container. The
Docker image must be built and run locally, and the routes requested against it,
before the work is believed. This extends `CLAUDE.md`'s existing warning that
`app/` is unverified by the gate set.

## 9. Cost

| Item | Monthly |
| --- | --- |
| ALB | ~$21 |
| NAT gateway | ~$38 |
| Fargate 0.5 vCPU / 1 GiB, ARM64, always on | ~$16 |
| CloudFront | ~$1 |
| ECR storage | ~$1 |
| **Total** | **~$77/mo** |

Public subnets with no NAT would be ~$39/mo. The difference buys the private
egress design, which was chosen deliberately for its learning value (§3).

## 10. Out of scope

- A custom domain and ACM certificate.
- Autoscaling; `desiredCount` is fixed at 1.
- CI/CD. The image is built and pushed by hand via §6.1's script, replacing
  Amplify's git trigger. Automating it is separate work.
- Any change to `lib/pipeline/`, the Lambda stages, or the §8.2 L734 boundary.
