# Deployment

This repository contains the public source, tests, and public-safe Wrangler templates for the cyspbot root page, GitHub webhook receiver, and GitHub webhook processor. It does not contain production domains, routes, Cloudflare resource identifiers, or secret values.

## Deployable Workers

`@cyspbot/cyspbot` deploys Worker `cyspbot` as the fallback origin. Its native fetch handler serves the root bot page for `GET` and standard bodyless `HEAD` requests, rejects other root methods with an empty `405`, and returns empty `404` responses for other paths.

`@cyspbot/github-webhook-receiver` deploys Worker `cyspbot-github-webhook-receiver` for `POST /github/webhooks`.

`@cyspbot/github-webhook-processor` deploys Worker `cyspbot-github-webhook-processor` as the consumer for the status-reaction job queue.

The source-owned Worker configurations define their entrypoints, compatibility dates and flags, required binding names, safe local/dry-run service targets, and safe local values for the processor's token-client variables. Production deployment configuration replaces those targets and supplies the deployment-owned values for the processor's token-client variables and issuer properties.

## Separate deployment pipeline

[`chikachow/cyspbot-deploy`](https://github.com/chikachow/cyspbot-deploy) pins this repository as a submodule and owns production Worker code, bindings, variables, validation, deployment workflows, and smoke probes. [`chikachow/infrastructure`](https://github.com/chikachow/infrastructure) manages the queues, retention, queue consumer, Custom Domain, and routes with Terraform. The specific webhook route executes before the Custom Domain origin Worker. A cyspbot source update must pass its own checks and strict Wrangler dry runs in the deployment repository before deployment.

The source workflow `.github/workflows/run-cyspbot-deploy-update.yml` is responsible for dispatching the deployment repository's source-update workflow after successful `main` CI. It obtains a short-lived GitHub token through `cyspbot-app-token-action`.

The production deployment configuration retains the receiver's queue producer
binding and the processor's WorkloadIdentityIssuer RPC and broker Service
Bindings. Terraform owns the processor's queue consumer attachment and its
retry and dead-letter settings. The source Wrangler consumer declaration is
for local tests and dry runs; production overlays omit consumers and routes.
The deployment configuration supplies the logical Workload Identity Token
audience and broker Token Endpoint URL as
separate variables. The issuer binding supplies the `WorkloadIdentityIssuer`
RPC together with its `subject` and `allowedAudiences` properties, while the
broker binding supplies the broker transport. The broker verifies the workload
identity assertion and performs authorization at its Token Endpoint.

## Delivery recovery

The deployment operator owns recovery of failed webhook deliveries and exhausted queue jobs. GitHub does not automatically redeliver failed webhooks; this source does not run a delivery-recovery scheduler. Queue durability starts only after the receiver successfully publishes the job.

After resolving an ingress failure, inspect the GitHub App's recent webhook deliveries and manually redeliver the failed delivery. See [GitHub's redelivery procedure](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks).

Every failed valid job retries and reaches `cyspbot-github-webhook-jobs-dlq` if
it exhausts the queue's retry budget. Inspect the DLQ and bounded processor
diagnostics, resolve the cause, then choose which jobs to replay through the
primary queue or deliberately discard. Replay requests credentials again and
does not bypass authorization. There is no job-age cutoff or automatic DLQ
replay. Invalid queue jobs are rejected before token acquisition and are not
retained for replay.

For manual replay, publish the unchanged job body to the primary queue and
confirm publication before acknowledging the DLQ copy. If publication or
acknowledgement has an ambiguous outcome, a duplicate is possible; repeating
the same reaction under the same GitHub App identity is safe. Do not purge a
DLQ job before its replay is durably published.

Monitor the DLQ backlog for recovery work. A `github_webhook_job_retrying` log
records a retry request, not confirmation of a DLQ transfer, including on the
last attempt. Unconsumed DLQ messages expire when their retention period ends.

Primary-queue retention also limits recovery: a job can expire before exhausting
its retries when delivery is delayed or consumers are unavailable. DLQ retention
does not extend that primary-queue window. Verify both retention settings against
the intended recovery window; this policy does not guarantee indefinite delivery.

The operator inspects the DLQ at least every 24 hours. Automated alerts are
currently unconfigured; recovery does not depend on email notification. Queue
retention is managed in Terraform, not by the Worker deployment pipeline.

Broker policy must authorize the processor's workload identity for the intended repositories and the exact requested scope, `issues:write pull_requests:write`. Keep both permissions until issue and pull-request conversation-comment behavior has been verified against the deployed GitHub App and broker policy.

## Local validation only

This repository's deployment command is a dry run:

```bash
fnm exec --using=24 corepack pnpm run deploy:dry-run
```

Do not add production credentials, domains, or routes to this repository.
