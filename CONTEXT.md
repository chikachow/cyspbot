# Cyspbot

Cyspbot is the hosted automation application for cysp. It currently lets approved GitHub Actions workflows obtain repository-scoped installation tokens without exposing the GitHub App private key outside Cloudflare.

## Language

**Caller**:
A GitHub Actions workflow invocation that presents a GitHub-issued OIDC token to **Cyspbot**.
_Avoid_: Client, user, consumer

**Token Minting**:
The current Cyspbot capability that issues short-lived GitHub installation tokens for approved workflows.
_Avoid_: Cyspbot itself, app login

**Calling Repository**:
The GitHub repository identified by the verified OIDC claims from the **Caller**.
_Avoid_: Target repository, requested repository

**GitHub App Installation**:
The installation of the configured GitHub App on a specific repository or owner scope from which GitHub can mint an installation token.
_Avoid_: App session, app login

**Installation Token**:
The short-lived GitHub access token minted for the **Calling Repository** through a **GitHub App Installation**.
_Avoid_: PAT, app JWT, repository secret

**Token Policy**:
The Cyspbot-enforced fixed permission set and caller constraints used when minting an **Installation Token**.
_Avoid_: Requested scope, ad hoc permissions, caller-defined token shape

**Audit Log**:
A bounded record of token minting attempts and outcomes kept by **Cyspbot** for operational review.
_Avoid_: Analytics, metrics, permanent event history

**Webhook Receiver**:
A Cyspbot endpoint that validates GitHub webhook authenticity and envelope fields, then forwards the delivery to the relevant per-installation Durable Object.
_Avoid_: Business event processor, schema-normalizer

**Webhook Delivery Log**:
A bounded per-installation record of accepted webhook deliveries, including delivery metadata and raw payload for short-term debugging and replay.
_Avoid_: Permanent event store, analytics stream

**Claims Endpoint**:
A non-minting Cyspbot endpoint that verifies a **Caller** OIDC token and returns Cyspbot's derived identity without issuing an **Installation Token**.
_Avoid_: Debug dump, raw JWT inspector

**Issuer Registration**:
A Cyspbot configuration entry that defines one trusted OIDC issuer and the verification material and policy Cyspbot uses for that issuer.
_Avoid_: Dynamic issuer discovery, arbitrary identity provider, issuer profile as a separate concept

**JWKS Cache**:
A short-lived Cyspbot-held store of verification keys for a trusted **Issuer Registration**, which may remain briefly usable during upstream key-distribution failures.
_Avoid_: Permanent key store, token cache, caller-controlled key source

## Relationships

- A **Caller** authenticates to **Cyspbot** with a GitHub OIDC token
- Cyspbot verifies a **Caller** only against a trusted **Issuer Registration**
- Each **Issuer Registration** owns its own verification policy, including JWKS freshness, staleness, and refresh-backoff rules
- **Cyspbot** derives exactly one **Calling Repository** from the verified OIDC claims
- **Token Minting** in **Cyspbot** issues an **Installation Token** only for the **Calling Repository**
- The **Token Policy** is fixed by **Cyspbot**, not selected by the **Caller**
- **Cyspbot** records an **Audit Log** entry for each token minting attempt
- The **Claims Endpoint** verifies caller identity and repository installation relationship without issuing an **Installation Token**
- The **JWKS Cache** supplies verification keys for an **Issuer Registration**, but never stores issued **Installation Tokens**
- A **GitHub App Installation** is the GitHub-side authority that allows **Cyspbot** to mint an **Installation Token**
- The **Webhook Receiver** accepts GitHub webhook deliveries only after signature and envelope validation
- The **Webhook Receiver** routes each accepted webhook delivery to the Durable Object keyed by **GitHub App Installation**
- Cyspbot keeps a bounded **Webhook Delivery Log** per installation, including raw payload for short-term debugging and replay
- The **Webhook Receiver** fails closed with a server-side error when no webhook secret is configured

## Example dialogue

> **Dev:** "Can this workflow ask for a token for another repository?"
> **Domain expert:** "No. **Cyspbot** only mints an **Installation Token** for the **Calling Repository** named by the verified OIDC claims."

> **Dev:** "Can the workflow ask for broader permissions when it needs them?"
> **Domain expert:** "No. The **Token Policy** is fixed by **Cyspbot** for this use case."

> **Dev:** "Do we keep the minted tokens for reuse?"
> **Domain expert:** "No. **Cyspbot** records an **Audit Log**, but it does not cache issued **Installation Tokens**."

> **Dev:** "How do we test auth without issuing a token?"
> **Domain expert:** "Use the **Claims Endpoint** to verify the **Caller** identity and confirm the repository is installed for this app."

## Flagged ambiguities

- "target repository" was used loosely; resolved: for v1 the only valid repository is the **Calling Repository** derived from OIDC, not a caller-supplied target.
- "requested scope" was used loosely; resolved: the **Caller** does not choose permissions in v1, **Cyspbot** applies one fixed **Token Policy**.
