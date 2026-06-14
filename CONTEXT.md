# cyspbot

cyspbot is the maintainer's hosted automation application. It lets trusted GitHub Actions workflow runs obtain repository-scoped GitHub App installation access tokens without exposing the GitHub App private key outside Cloudflare.

The service contract is [docs/service-contract.md](docs/service-contract.md). The implementation reference is [docs/implementation.md](docs/implementation.md).

## Language

**Caller**:
A GitHub Actions workflow invocation that presents a GitHub-issued OIDC token to **cyspbot**.
_Avoid_: Client, user, consumer

**Authenticated Principal**:
The cyspbot-internal identity shape produced after an OIDC token has been cryptographically verified, issuer policy has been applied, and the claims have been mapped to a trusted caller model.
_Avoid_: Raw JWT claims, unverified subject

**GitHub Actions Principal**:
The concrete **Authenticated Principal** implementation for a **Caller**. It contains the verified GitHub Actions OIDC claims and parsed subject context used by the **Token Policy**.
_Avoid_: GitHub user, repository owner

**Installation Token Issuance**:
The cyspbot capability that exchanges a trusted GitHub Actions OIDC token for a short-lived GitHub App installation access token for workflow runs that satisfy cyspbot's checked-in OIDC trust policy.
_Avoid_: cyspbot itself, app login

**Calling Repository**:
The GitHub repository identified by the verified OIDC claims from the **Caller**.
_Avoid_: Target repository, requested repository

**GitHub App Installation**:
The installation of the configured GitHub App on a specific repository or owner scope for which GitHub can issue a GitHub App installation access token.
_Avoid_: App session, app login

**Installation Token**:
Project shorthand for the short-lived GitHub App installation access token issued for the **Calling Repository** through a **GitHub App Installation**.
_Avoid_: PAT, app JWT, repository secret

**Token Policy**:
The cyspbot-enforced policy code, OIDC trust conditions, repository narrowing, and GitHub permission request used when issuing an **Installation Token**.
_Avoid_: Caller-requested scope, ad hoc caller-defined permissions, event-name-only policy, separate policy engine

**Webhook Receiver**:
A cyspbot Worker that validates GitHub webhook authenticity and envelope fields, acknowledges valid signed deliveries, and does not retain raw payloads or run product-specific event handling.
_Avoid_: Business event processor, schema-normalizer

**Token Exchange Endpoint**:
The primary cyspbot STS endpoint that accepts a **Caller** OIDC token and returns an **Installation Token** using an OAuth token-exchange contract.
_Avoid_: installation collection endpoint, raw GitHub passthrough

**Trusted OIDC Issuer**:
A code-owned cyspbot trust entry that defines one accepted OIDC issuer and the verification material and policy cyspbot uses for that issuer.
_Avoid_: Dynamic issuer discovery, arbitrary identity provider, issuer profile as a separate concept

**JWKS Cache**:
A short-lived, isolate-local `jose` remote JWKS resolver cache for a **Trusted OIDC Issuer**.
_Avoid_: Permanent key store, token cache, caller-controlled key source

## Relationships

- The product surface is `POST /token` and `POST /github/webhooks`.
- A **Caller** authenticates to **cyspbot** with a GitHub OIDC token.
- A verified **Caller** is represented internally as a **GitHub Actions Principal**, which is the **Authenticated Principal** type.
- cyspbot verifies a **Caller** only against a **Trusted OIDC Issuer**.
- **cyspbot** derives exactly one **Calling Repository** from the verified OIDC claims.
- **Installation Token Issuance** in **cyspbot** issues an **Installation Token** only for the **Calling Repository**.
- The **Token Policy** is fixed by **cyspbot** for caller context, repository scope, and the GitHub permission request, while the GitHub App configuration remains the upper bound.
- The **Token Policy** evaluates immutable and workflow-context GitHub OIDC claims such as `sub`, `repository_id`, `repository_owner_id`, `repository_visibility`, and `ref`.
- The **Token Exchange Endpoint** is the only public interface for **Installation Token Issuance**.
- The **JWKS Cache** supplies verification keys for a **Trusted OIDC Issuer**, but never stores issued **Installation Tokens**.
- A **GitHub App Installation** is the GitHub-side authority that allows **cyspbot** to issue an **Installation Token**.
- The **Webhook Receiver** accepts GitHub webhook deliveries only after signature and envelope validation.
- The **Webhook Receiver** acknowledges signed unsupported events without writing state.
- The **Webhook Receiver** fails closed with a server-side error when no webhook secret is configured.

## Example dialogue

> **Dev:** "Can this workflow ask for a token for another repository?"
> **Domain expert:** "No. **cyspbot** only issues an **Installation Token** for the **Calling Repository** named by the verified OIDC claims."

> **Dev:** "Can the workflow ask for broader permissions when it needs them?"
> **Domain expert:** "No. The **Caller** does not choose permissions. **cyspbot** requests the checked-in permissions selected by the **Token Policy**, and GitHub caps them to the permissions granted to the GitHub App installation."

> **Dev:** "Do we keep the issued tokens for reuse?"
> **Domain expert:** "No. **cyspbot** does not cache issued **Installation Tokens**."

> **Dev:** "What decides whether a workflow run is trusted enough for Installation Token Issuance?"
> **Domain expert:** "The checked-in **Token Policy** evaluates the verified GitHub OIDC claims in plain code. The policy only permits default-branch `ref` contexts for `schedule` and `workflow_dispatch`."
