# cyspbot on Cloudflare Agents SDK

## Executive summary

Rearchitecting `cyspbot` onto Cloudflare's Agents SDK is only a good idea if the service is meant to evolve from a narrow token broker into a long-lived automation control plane per GitHub App installation. If the primary job remains:

- verify GitHub Actions OIDC tokens
- enforce repository and event-bound token minting policy
- mint short-lived GitHub installation tokens
- retain bounded per-installation audit and webhook logs

then the Agents SDK is not the right primary abstraction. The current architecture already uses the core primitive the Agents SDK is built on: Durable Objects. The SDK would add lifecycle, state-sync, scheduling, queueing, fiber recovery, and MCP integration machinery that is only partly relevant to the current workload.

My recommendation is:

- Do not rearchitect the existing token-broker path onto Agents SDK just to "modernize" it.
- Consider Agents SDK only if `cyspbot` is intentionally becoming an installation-scoped automation runtime that performs durable background work after webhooks, keeps long-lived per-installation state, coordinates external tools, or exposes real-time operator/agent interactions.

That said, if the decision is to build on the Agents SDK, the right design is a hybrid architecture:

- a thin Worker edge ingress layer
- one `IssuerVerifierAgent` per trusted OIDC issuer
- one `InstallationAgent` per GitHub App installation
- optional sub-agents for long-running automation jobs or repository-specific operating contexts

This keeps the hard security boundary explicit while using the Agents SDK where it has real leverage.

## Current architecture and why it already fits the platform

Today `cyspbot` is already Cloudflare-native:

- `src/worker/app.ts` is a thin HTTP Worker entrypoint for `/github/claims`, `/github/installations/token`, and `/github/webhooks`.
- `src/durable-objects/oidc-issuer-verifier-object.ts` keeps one verifier Durable Object per issuer registration and owns JWKS coordination, persistence, and refresh/backoff state.
- `src/durable-objects/installation-object.ts` keeps one Durable Object per GitHub App installation and stores bounded token-request and webhook logs.
- `src/github/api.ts` keeps token mint policy narrow and explicit, with repository-scoped installation tokens and GitHub App-governed permissions.
- `docs/adr/0001-hosted-github-installation-token-broker.md` and `docs/adr/0002-per-issuer-jwks-verifier-durable-object.md` already document the important persistence and trust boundaries.

That architecture is simple because the core domain is simple:

- ingress request validation
- issuer-scoped verification coordination
- installation-scoped authorization and audit persistence
- outbound GitHub API calls

The service is not currently chatty, interactive, multi-step, or human-in-the-loop. Those are the areas where the Agents SDK is strongest.

## What the Agents SDK would improve

The Agents SDK is built on Durable Objects and adds higher-level primitives around state, WebSockets, scheduling, queues, durable execution, and MCP connectivity. Those become valuable if `cyspbot` grows beyond request/response brokering.

### Significant benefits

1. Durable execution for webhook-triggered background jobs

The strongest addition is durable long-running execution. `runFiber()` and `startFiber()` give you a built-in way to accept work, checkpoint progress, survive object eviction, and recover later. That is useful if a webhook starts multi-step automation such as:

- synchronizing repository metadata
- opening or updating pull requests
- processing installation policy changes
- replaying failed deliveries
- coordinating downstream API calls with retries and recovery

For the current token broker, this is mostly unused. For an automation runtime, it is a major benefit.

2. First-class scheduling inside the installation boundary

The SDK's scheduling API fits installation-scoped periodic work well:

- periodic reconciliation of GitHub installation metadata
- retrying deferred webhook processing
- pruning logs without manual alarm plumbing
- policy drift checks
- time-based follow-up jobs after a webhook

You can do this directly on Durable Objects already, but the Agent API is materially more ergonomic.

3. A cleaner model for installation-scoped automation state

If `cyspbot` grows into "one long-lived automation context per installation", an `InstallationAgent` is a more semantically accurate abstraction than a plain Durable Object class. It can own:

- installation policy state
- automation execution history
- replay cursors
- schedules
- pending jobs
- operator-visible status

That is a better fit than manually layering those concepts over a generic DO.

4. Easier future tool integration through MCP

If the roadmap includes agentic operations against external tool surfaces, the SDK's MCP support is meaningful. It makes it easier to let an installation-scoped runtime use external tool servers with persisted connections and auth state.

This is only relevant if `cyspbot` evolves toward autonomous or semi-autonomous repository operations. It provides no direct benefit to OIDC verification or token minting.

5. Better fit for operational consoles or real-time supervision

If you later want a browser UI for operators, the SDK's connection and state-sync model makes it straightforward to expose:

- live job status
- installation health
- recent deliveries
- pending retries
- replay actions

Again, this is useful for an automation control plane, not for a minimal token broker.

## Costs and risks

### Significant costs

1. More framework surface in the security-critical path

The existing token path is deliberately explicit. The more of it that moves under Agent lifecycle hooks and shared framework machinery, the more hidden behavior you introduce into the security boundary. For a broker that exists mainly to enforce auth and mint tokens correctly, that is a real cost.

2. More concepts than the current problem needs

Agents bring:

- route dispatch through agent bindings
- agent lifecycle hooks
- state synchronization conventions
- scheduling model
- queue model
- durable execution model
- optional client SDK concepts
- MCP concepts

Most of that is irrelevant to `POST /github/claims` and `POST /github/installations/token`. Adding it anyway would be architecture inflation.

3. Higher testing and reasoning burden

Today the important invariants are easy to reason about:

- request enters Worker
- request authenticates through issuer verifier DO
- installation-specific state is touched in one DO
- GitHub API is called

With an Agent architecture you would also need to prove:

- job execution and recovery are idempotent
- scheduled tasks cannot violate broker policy
- recovery logic does not duplicate side effects
- background work cannot outlive revoked authorization incorrectly
- any operator-visible state remains aligned with the source of truth

That burden is worth paying only if you actually need those capabilities.

4. New failure modes around background execution

Durable execution and scheduling are useful, but they introduce their own operational questions:

- What work is safe to retry?
- What work is safe to resume?
- How do we dedupe webhook deliveries versus job execution attempts?
- How do we roll back a partially completed GitHub automation?
- What installation-local state is authoritative versus reconstructable?

Those are manageable, but they are new complexity, not free capability.

5. Potentially worse clarity around trust boundaries

The current design has very clear boundaries:

- issuer verification state belongs to issuer verifier DOs
- installation policy and audit history belong to installation DOs
- HTTP ingress stays explicit in the Worker

An over-eager Agent rewrite could blur those boundaries by turning the whole service into "agents" first and security components second. That would be the wrong design pressure.

## Alignment with the Agents SDK

### Strong alignment

- Installation-scoped state maps cleanly to one agent instance per GitHub App installation.
- Webhook-driven follow-up work maps cleanly to schedules, queues, and fibers.
- Long-lived operating contexts per installation map well to agent identity.
- Future operator UI or real-time inspection aligns with state sync and connection primitives.
- Future external tool orchestration aligns with MCP support.

### Weak alignment

- OIDC verification is not naturally interactive or connection-oriented.
- GitHub installation token minting is a narrow synchronous operation, not an agent workflow.
- The current webhook receiver mostly validates and stores deliveries; it is not yet doing meaningful long-lived work.
- The system's primary security problem is policy enforcement and secret confinement, not orchestration.

### Significant misalignment

1. The core path is a broker, not an agent

The current value of `cyspbot` is "prove caller identity, prove repository authorization, mint one tightly-scoped token". That is a classic request/response security broker. Agents are a good fit when the durable identity itself is the product. Here, the durable identity is only an implementation detail.

2. State synchronization is mostly irrelevant

One of the SDK's central value propositions is persisted state plus real-time synchronization to connected clients. `cyspbot` currently has no client state-sync problem.

3. MCP and tool use are irrelevant unless the product changes

If the service stays a token broker, MCP is dead weight. It only matters if `cyspbot` becomes an automation actor that itself uses tools.

## New capabilities the Agents SDK would make practical

These are the most meaningful capabilities that become plausible if `cyspbot` is intentionally rebuilt around Agents:

1. Installation-local webhook workflows with durable recovery

Each installation could accept a webhook, persist it, start a durable job, and recover safely after eviction or deployment. That makes more ambitious webhook automation realistic.

2. Installation-local recurring reconciliation

The service could run installation-scoped periodic tasks such as:

- verifying app installation still matches policy
- checking repository default branch or permissions drift
- retrying deferred jobs
- expiring replay windows

3. Operator-facing live control plane

An operator UI could attach to an installation agent and observe:

- current health
- queued work
- recent webhook deliveries
- last job outcomes
- replay or retry actions

4. Sub-agent decomposition for repository or workflow-run contexts

If one installation fans out into many active automations, the parent installation agent could coordinate sub-agents for:

- repository-specific automation state
- workflow-run specific recovery state
- one-shot long-running jobs

5. Persisted tool connectivity and richer automations

If future `cyspbot` work includes orchestrating external services, the MCP client support gives a cleaner path than bolting those capabilities directly into one Worker.

## Recommendation

### Short answer

As a rearchitecture of the current service: no, this is not a good idea.

### Longer answer

It is a good idea only if the service charter changes from:

- "secure token broker with bounded installation-local persistence"

to something closer to:

- "installation-scoped automation runtime for GitHub-integrated workflows"

Without that product shift, the Agents SDK mainly adds abstraction and new moving parts around a workload that already fits plain Workers plus Durable Objects very well.

My recommendation is therefore:

1. Keep the current token-broker and verifier paths as plain Worker plus Durable Objects.
2. If you want agentic capabilities, add them beside the broker path, not by forcing the broker itself into an Agent abstraction.
3. Only promote Agents SDK to the primary architecture once webhook-triggered durable automation is a first-class product requirement.

## Best target design if you do adopt the Agents SDK

If the decision is to proceed anyway, the best design is not "everything becomes one agent". The right shape is a hybrid with explicit ingress and explicit trust boundaries.

### Component model

#### 1. Edge ingress Worker

Responsibilities:

- terminate HTTP
- perform basic path and method routing
- enforce request size and content-type gates
- keep the public contract explicit
- route to the correct agent instance by issuer or installation

Endpoints:

- `POST /github/claims`
- `POST /github/installations/token`
- `POST /github/webhooks`
- optional operator routes such as `GET /installations/:id/status`

This layer should remain thin and mostly stateless.

#### 2. `IssuerVerifierAgent`

Identity:

- one agent instance per trusted OIDC issuer, keyed by issuer URL

Responsibilities:

- own the issuer registration fingerprint
- persist normalized JWKS snapshot and refresh/backoff state
- verify bearer tokens
- schedule proactive refresh before freshness expiry if desired
- expose a narrow RPC/HTTP method such as `verifyOidcToken(token, issuer)`

State:

- issuer registration fingerprint
- current normalized JWKS snapshot
- refresh failure/backoff metadata
- last successful refresh time

Why an agent here:

- only marginally justified today
- justified if you want scheduled refresh, richer health status, or operator visibility

#### 3. `InstallationAgent`

Identity:

- one agent instance per GitHub App installation ID

Responsibilities:

- enforce installation-local token mint policy
- mint repository-scoped installation tokens
- record bounded audit log
- accept validated webhook deliveries
- decide which deliveries are log-only versus automation-triggering
- own installation-local schedules, queue, and durable jobs
- expose installation status for operators

State:

- bounded token request log
- bounded webhook delivery log
- optional installation metadata cache
- pending job queue
- job execution history
- replay/dedupe markers keyed by `X-GitHub-Delivery`
- policy identifier or snapshot only if policy later becomes data-driven

Key methods:

- `issueClaims(principal)`
- `mintInstallationToken(principal)`
- `acceptWebhook(delivery)`
- `startWebhookJob(deliveryId, event)`
- `retryDeferredWork(jobId)`
- `pruneLogs()`

Execution model:

- synchronous token mint remains direct request/response
- webhook-triggered automation runs through `startFiber()` or queue + scheduled follow-up
- recurring cleanup and reconciliation runs through `schedule()` or cron schedules

#### 4. Optional `RepositoryAutomationAgent`

Identity:

- one sub-agent per repository, or per active automation stream within an installation

Use only if the service grows beyond installation-level coordination. This avoids overloading one installation agent with unrelated long-running contexts.

Responsibilities:

- repository-specific automation state
- durable execution of multi-step GitHub operations
- repository-local retry and reconciliation

Do not add this layer unless the installation agent becomes genuinely crowded.

#### 5. Secret and policy providers

Keep these as explicit modules or bindings, not agents.

Responsibilities:

- GitHub App private key retrieval from Secrets Store
- static issuer registration loading
- static or versioned token policy rules
- installation webhook secret retrieval

These are configuration/trust inputs, not runtime identities.

### Request flows

#### `POST /github/claims`

1. Edge Worker extracts bearer token.
2. Worker parses unverified issuer hint.
3. Worker routes verification request to `IssuerVerifierAgent`.
4. `IssuerVerifierAgent` verifies the token against persisted JWKS state.
5. Worker resolves the GitHub App installation for the repository.
6. Worker forwards the verified principal to `InstallationAgent`.
7. `InstallationAgent` confirms repository/install relationship and returns derived claims.

This keeps the security path explicit while still using agents for issuer and installation identities.

#### `POST /github/installations/token`

1. Edge Worker authenticates through `IssuerVerifierAgent`.
2. Worker resolves the installation ID for the verified repository.
3. Worker forwards the principal to `InstallationAgent`.
4. `InstallationAgent` enforces token mint policy.
5. `InstallationAgent` calls GitHub to mint a repository-scoped installation token.
6. `InstallationAgent` records the audit entry and returns the token.

This path should remain synchronous. Do not push token minting into background jobs.

#### `POST /github/webhooks`

1. Edge Worker verifies signature and request envelope.
2. Worker extracts `installation.id`.
3. Worker forwards the validated delivery to `InstallationAgent`.
4. `InstallationAgent` dedupes on delivery ID.
5. `InstallationAgent` persists the delivery log.
6. `InstallationAgent` either:
   - returns after logging only, or
   - starts durable follow-up work via `startFiber()` or queued processing.

This is the path where the Agents SDK contributes the most.

### Data model

#### `IssuerVerifierAgent`

- `issuer_registrations` remains static config, not mutable agent state
- `jwks_snapshot`
- `jwks_refresh_backoff`
- `jwks_last_success_at`
- `jwks_last_failure_at`

#### `InstallationAgent`

- `token_requests`
- `webhook_deliveries`
- `webhook_delivery_dedupes`
- `jobs`
- `job_events`
- `schedules`
- optional `installation_cache`

The important design rule is to persist only authoritative or recovery-critical state. Do not persist derived caches unless they materially reduce GitHub load or recovery cost.

### Operational design

- Keep structured logging at the edge Worker and inside both agent classes.
- Keep the token-mint path narrow, synchronous, and easy to audit.
- Treat webhook-triggered automations as idempotent jobs with explicit recovery semantics.
- Separate "request accepted" from "job completed" in operator-visible status.
- Make replay a first-class installation-local operation.
- Avoid agent-to-agent chatter on the token path beyond verifier then installation routing.

### Security design

- Keep issuer trust as a closed configured set.
- Keep GitHub App private key access centralized and explicit.
- Do not let callers choose token permissions, target repositories, or arbitrary job behaviors.
- Do not make mutable agent state the authority for trust configuration that should remain deploy-time controlled.
- Keep operator endpoints separate from public broker endpoints.

## Final judgement

For the current `cyspbot`, an Agents SDK rewrite would mostly relocate complexity rather than remove it. The existing Worker plus Durable Object design already matches the real boundaries of the problem and keeps the security story legible.

If you want `cyspbot` to become an installation-scoped automation platform, then the Agents SDK becomes attractive, and the right implementation is a hybrid architecture with:

- explicit edge ingress
- `IssuerVerifierAgent` for issuer-local verification coordination
- `InstallationAgent` for installation-local state, webhook handling, and durable jobs
- optional sub-agents only when repository-level or job-level contexts become substantial

That is the version of the idea that is technically coherent. A wholesale rewrite of the current broker into "agents everywhere" is not.
