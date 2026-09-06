# Deployment

This repository contains the public source, tests, and public-safe Wrangler templates for the cyspbot root page, GitHub webhook receiver, and GitHub webhook processor. It does not contain production domains, routes, Cloudflare resource identifiers, or secret values.

## Deployable Workers

`@cyspbot/cyspbot` deploys Worker `cyspbot` as the fallback origin. Its native fetch handler serves the root bot page for `GET` and standard bodyless `HEAD` requests, rejects other root methods with an empty `405`, and returns empty `404` responses for other paths.

`@cyspbot/github-webhook-receiver` deploys Worker `cyspbot-github-webhook-receiver` for `POST /github/webhooks`.

`@cyspbot/github-webhook-processor` deploys Worker `cyspbot-github-webhook-processor` as the consumer for the status-reaction job queue.

The source-owned Worker configurations define their entrypoints, compatibility dates and flags, required binding names, safe local/dry-run service targets, and safe local values for the processor's token-client variables. Production deployment configuration replaces those targets and supplies the deployment-owned values for the processor's token-client variables and issuer properties.

## Separate deployment pipeline

[`chikachow/cyspbot-deploy`](https://github.com/chikachow/cyspbot-deploy) pins this repository as a submodule and owns the production Custom Domain, webhook route, Cloudflare identifiers, Secrets Store binding, validation, deployment workflow, and smoke probes. The specific webhook route executes before the Custom Domain origin Worker. A cyspbot source update must pass its own checks and strict Wrangler dry runs in that repository before deployment.

The source workflow `.github/workflows/run-cyspbot-deploy-update.yml` is responsible for dispatching the deployment repository's source-update workflow after successful `main` CI. It obtains a short-lived GitHub token through `cyspbot-app-token-action`.

The deployment configuration wires the receiver to the status-reaction queue
producer and wires the processor to the queue consumer, WorkloadIdentityIssuer
RPC entrypoint, and broker Service Binding. It provisions the primary queue and
dead-letter queue before deploying the processor and receiver. It supplies the
logical Workload Identity Token audience and broker Token Endpoint URL as
separate variables. The issuer binding supplies the `WorkloadIdentityIssuer`
RPC together with its `subject` and `allowedAudiences` properties, while the
broker binding supplies the broker transport. The broker verifies the workload
identity assertion and performs authorization at its Token Endpoint.

## Delivery recovery

The deployment operator owns recovery of failed webhook deliveries and exhausted queue jobs. GitHub does not automatically redeliver failed webhooks; this source does not run a delivery-recovery scheduler. Queue durability starts only after the receiver successfully publishes the job.

After resolving an ingress failure, inspect the GitHub App's recent webhook deliveries and manually redeliver the failed delivery. See [GitHub's redelivery procedure](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks). For jobs that reach `cyspbot-github-webhook-jobs-dlq`, resolve the processor or broker failure before replaying them through the primary queue. Permanent failures are acknowledged and logged, so they require redelivery from GitHub if another attempt is warranted.

Broker policy must authorize the processor's workload identity for the intended repositories and the exact requested scope, `issues:write pull_requests:write`. Keep both permissions until issue and pull-request conversation-comment behavior has been verified against the deployed GitHub App and broker policy.

## Local validation only

This repository's deployment command is a dry run:

```bash
fnm exec --using=24 corepack pnpm run deploy:dry-run
```

Do not add production credentials, domains, or routes to this repository.
