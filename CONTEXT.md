# Cyspbot

Cyspbot is the hosted automation application for cysp. It currently lets trusted GitHub Actions workflow runs obtain repository-scoped GitHub App installation access tokens without exposing the GitHub App private key outside Cloudflare.

## Language

**Caller**:
A GitHub Actions workflow invocation that presents a GitHub-issued OIDC token to **Cyspbot**.
_Avoid_: Client, user, consumer

**Dashboard User**:
A human GitHub user who authorizes the Cyspbot GitHub App for dashboard access and browses repository audit history through Cyspbot's web UI.
_Avoid_: Caller, installation, org member as an authorization shortcut

**Token Minting**:
The current Cyspbot capability that exchanges a trusted GitHub Actions OIDC token for a short-lived GitHub App installation access token for workflow runs that satisfy Cyspbot's checked-in OIDC trust policy.
_Avoid_: Cyspbot itself, app login

**Calling Repository**:
The GitHub repository identified by the verified OIDC claims from the **Caller**.
_Avoid_: Target repository, requested repository

**GitHub App Installation**:
The installation of the configured GitHub App on a specific repository or owner scope from which GitHub can mint a GitHub App installation access token.
_Avoid_: App session, app login

**Installation Token**:
Project shorthand for the short-lived GitHub App installation access token minted for the **Calling Repository** through a **GitHub App Installation**.
_Avoid_: PAT, app JWT, repository secret

**GitHub User Access Token**:
The GitHub App user-to-server token that represents a signed-in **Dashboard User** and is used to ask GitHub which installations and repositories that human may access.
_Avoid_: Installation token, PAT, app JWT

**Token Policy**:
The Cyspbot-enforced policy code, OIDC trust conditions, and repository narrowing used when minting an **Installation Token**, with repository permissions inherited from the GitHub App configuration.
_Avoid_: Requested scope, ad hoc caller-defined permissions, assumption that Cyspbot fixes the permission set, event-name-only policy, separate policy engine

**Audit Log**:
A bounded record of **Token Minting** attempts and outcomes kept by **Cyspbot** for operational review, with durable request and issued-token facts stored centrally in D1.
_Avoid_: Analytics, metrics, installation-local source of truth

**Webhook Receiver**:
A Cyspbot endpoint that validates GitHub webhook authenticity and envelope fields, then forwards the delivery to the relevant per-installation Durable Object.
_Avoid_: Business event processor, schema-normalizer

**Webhook Delivery Log**:
A bounded Cyspbot-held record of webhook delivery metadata for deliveries that reach envelope validation, including rejected deliveries, for short-term operational debugging.
_Avoid_: Permanent event store, raw-payload archive by default

**Installation Reconciliation**:
The Cyspbot process that refreshes current installation, repository, and installation-membership projection data from GitHub into D1 for one **GitHub App Installation** at a time.
_Avoid_: Request-time authorization source, opportunistic mint-path cache patching

**Installation Coordinator**:
The per-installation Durable Object that coalesces reconcile signals and serializes **Installation Reconciliation** execution for one **GitHub App Installation**, while D1 remains the durable source of truth.
_Avoid_: Audit store, repository projection store, session store

**Dashboard Session**:
A short-lived Cyspbot-held authenticated web session for one **Dashboard User**, stored in D1 and holding encrypted GitHub user token material plus expiry metadata.
_Avoid_: Caller identity, installation login, Durable Object session store

**Repository Visibility Cache**:
A short-lived D1-backed cache of the repositories that GitHub currently says a **Dashboard User** may access for this GitHub App, keyed by user and installation context.
_Avoid_: Independent authorization database, org-membership snapshot, permanent entitlement record

**Visibility Refresh**:
The process that uses a **GitHub User Access Token** to call GitHub's user-to-server installation repository APIs and replace a **Dashboard User**'s positive **Repository Visibility Cache** rows.
_Avoid_: Authorization sync, entitlement import, reconcile

**Claims Endpoint**:
A non-minting Cyspbot endpoint that verifies a **Caller** OIDC token and returns Cyspbot's derived identity without issuing an **Installation Token**.
_Avoid_: Debug dump, raw JWT inspector

**Token Exchange Endpoint**:
The primary Cyspbot STS endpoint that accepts a **Caller** OIDC token and returns an **Installation Token** using an OAuth token-exchange contract.
_Avoid_: installation collection endpoint, raw GitHub passthrough

**Issuer Registration**:
A Cyspbot configuration entry that defines one trusted OIDC issuer and the verification material and policy Cyspbot uses for that issuer.
_Avoid_: Dynamic issuer discovery, arbitrary identity provider, issuer profile as a separate concept

**JWKS Cache**:
A short-lived Cyspbot-held store of verification keys for a trusted **Issuer Registration**, which may remain briefly usable during upstream key-distribution failures.
_Avoid_: Permanent key store, token cache, caller-controlled key source

## Relationships

- A **Caller** authenticates to **Cyspbot** with a GitHub OIDC token
- A **Dashboard User** authenticates to **Cyspbot** by authorizing the Cyspbot GitHub App and establishing a **Dashboard Session**
- Cyspbot verifies a **Caller** only against a trusted **Issuer Registration**
- Each **Issuer Registration** owns its own verification policy, including JWKS freshness, staleness, and refresh-backoff rules
- **Cyspbot** derives exactly one **Calling Repository** from the verified OIDC claims
- **Token Minting** in **Cyspbot** issues an **Installation Token** only for the **Calling Repository**
- The **Token Policy** is fixed by **Cyspbot** for caller context and repository scope, while repository permissions come from the GitHub App configuration
- The **Token Policy** currently evaluates immutable and workflow-context GitHub OIDC claims such as `sub`, `repository_id`, `repository_owner_id`, `repository_visibility`, and `ref`
- **Cyspbot** records an **Audit Log** entry for each **Token Minting** attempt
- Repeated audit values such as minted permissions and audit outcome reasons may be stored in relational child rows rather than embedded JSON on the main audit row
- The main audit row prefers domain fields like `requested_at` and `outcome` over HTTP response details
- The **Claims Endpoint** verifies caller identity and repository installation relationship without issuing an **Installation Token**
- The **Token Exchange Endpoint** is the primary **Token Minting** interface; legacy GitHub-specific compatibility endpoints are shims over the same **Token Policy**
- The **JWKS Cache** supplies verification keys for an **Issuer Registration**, but never stores issued **Installation Tokens**
- A **GitHub App Installation** is the GitHub-side authority that allows **Cyspbot** to mint an **Installation Token**
- Cyspbot determines dashboard repository visibility from the intersection GitHub reports for a **Dashboard User**, a **GitHub App Installation**, and that installation's repositories
- The **Repository Visibility Cache** is an optimization only; GitHub remains the authorization authority for **Dashboard User** repository visibility
- **Installation Reconciliation** is the only writer that performs full installation-slice replacement, deletion, suspension, or removal decisions for projection rows in D1
- A **Visibility Refresh** may upsert positive projection bootstrap rows for repositories GitHub just returned for that **Dashboard User**, but it must not infer absence or remove projection state
- The **Installation Coordinator** coalesces and serializes **Installation Reconciliation** work per installation, but does not become a second durable source of truth
- The **Webhook Receiver** accepts GitHub webhook deliveries only after signature and envelope validation
- The **Webhook Receiver** routes each accepted **Installation Reconciliation** signal to the **Installation Coordinator** keyed by **GitHub App Installation**
- Cyspbot keeps a bounded **Webhook Delivery Log** of delivery metadata only, while current-state repair happens through **Installation Reconciliation**
- The **Webhook Receiver** fails closed with a server-side error when no webhook secret is configured

## Example dialogue

> **Dev:** "Can this workflow ask for a token for another repository?"
> **Domain expert:** "No. **Cyspbot** only mints an **Installation Token** for the **Calling Repository** named by the verified OIDC claims."

> **Dev:** "Can the workflow ask for broader permissions when it needs them?"
> **Domain expert:** "No. The **Caller** does not choose permissions. The minted token inherits whatever repository permissions the GitHub App currently has."

> **Dev:** "Do we keep the minted tokens for reuse?"
> **Domain expert:** "No. **Cyspbot** records an **Audit Log**, but it does not cache issued **Installation Tokens**."

> **Dev:** "How do we test auth without issuing a token?"
> **Domain expert:** "Use the **Claims Endpoint** to verify the **Caller** identity and confirm the repository is installed for this app."

> **Dev:** "What decides whether a workflow run is trusted enough to mint?"
> **Domain expert:** "The checked-in **Token Policy** evaluates the verified GitHub OIDC claims in plain code. The current default policy only permits default-branch `ref` contexts for `schedule`, `workflow_dispatch`, and `push`."

> **Dev:** "Can every org member see every repository in the dashboard once the app is installed on the org?"
> **Domain expert:** "No. A **Dashboard User** may only see repositories that GitHub returns for that user through the app's user-to-server installation repository APIs."

## Flagged ambiguities

- "target repository" was used loosely; resolved: for v1 the only valid repository is the **Calling Repository** derived from OIDC, not a caller-supplied target.
- "requested scope" was used loosely; resolved: the **Caller** does not choose permissions in v1, and Cyspbot narrows repository scope and caller context while GitHub App configuration determines repository permissions.
- "approved workflow" was used loosely; resolved: Cyspbot currently trusts specific verified OIDC claim patterns under checked-in policy code, not a separate mutable approval registry.
