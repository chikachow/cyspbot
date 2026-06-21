# cyspbot

cyspbot is the maintainer's hosted automation application. It lets trusted GitHub Actions workflow runs obtain repository-scoped GitHub App installation access tokens without exposing the GitHub App private key outside Cloudflare.

The service contract is [docs/service-contract.md](docs/service-contract.md). The implementation reference is [docs/implementation.md](docs/implementation.md).

## Language

**Caller**:
A GitHub Actions workflow invocation that presents a GitHub-issued OIDC token to **cyspbot**.
_Avoid_: User, human, consumer

**Authenticated Principal**:
The cyspbot-internal identity shape produced after an OIDC token has been cryptographically verified, issuer policy has been applied, and the claims have been mapped to a trusted caller model.
_Avoid_: Raw JWT claims, unverified subject

**GitHub Actions Principal**:
The concrete **Authenticated Principal** implementation for a **Caller**. It contains the verified GitHub Actions OIDC claims and parsed subject context used by the **Token Policy**.
_Avoid_: GitHub user, repository owner

**Installation Token Issuance**:
The cyspbot capability that exchanges a trusted GitHub Actions OIDC token for a short-lived GitHub App installation access token for workflow runs that satisfy cyspbot's checked-in OIDC trust policy.
_Avoid_: cyspbot itself, app login

**Installation Token Request**:
The normalized cyspbot-internal request for one GitHub App installation access token. It contains exactly one canonical GitHub repository API resource and the GitHub App permissions requested for that resource.
_Avoid_: Profile, grant, target selector, raw form values

**Repository Resource**:
A canonical GitHub API repository URI in the form `https://api.github.com/repos/{owner}/{repo}`. One **Installation Token Request** contains exactly one **Repository Resource**.
_Avoid_: `owner/repo` shorthand, GitHub HTML URL, workflow endpoint URL

**GitHub App Installation**:
The installation of the configured GitHub App on a specific repository or owner scope for which GitHub can issue a GitHub App installation access token.
_Avoid_: App session, app login

**Installation Token**:
Project shorthand for the short-lived GitHub App installation access token issued for a **Repository Resource** through one **GitHub App Installation**.
_Avoid_: PAT, app JWT, repository secret

**Token Policy**:
The cyspbot-enforced static allow-list that decides whether a verified **GitHub Actions Principal** may receive exactly the normalized **Installation Token Request**.
_Avoid_: Profile selector, grant builder, ad hoc caller-defined permissions, event-name-only policy, separate policy engine

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
- **cyspbot** normalizes exactly one **Installation Token Request** from the verified **GitHub Actions Principal** and token-exchange `scope` and `resource`.
- **Installation Token Issuance** in **cyspbot** issues at most one **Installation Token** for one **Repository Resource**.
- The **Token Policy** is fixed by **cyspbot** for principal context, repository resource, and GitHub permission request, while the GitHub App configuration remains the upper bound.
- The **Token Policy** evaluates verified GitHub OIDC principal facts such as `repository`, parsed subject context, `ref`, `event_name`, and `workflow_ref`.
- The **Token Exchange Endpoint** is the only public interface for **Installation Token Issuance**.
- The **JWKS Cache** supplies verification keys for a **Trusted OIDC Issuer**, but never stores issued **Installation Tokens**.
- A **GitHub App Installation** is the GitHub-side authority that allows **cyspbot** to issue an **Installation Token**.
- The **Webhook Receiver** accepts GitHub webhook deliveries only after signature and envelope validation.
- The **Webhook Receiver** acknowledges signed unsupported events without writing state.
- The **Webhook Receiver** fails closed with a server-side error when no webhook secret is configured.

## Example dialogue

> **Dev:** "Can this workflow ask for a token for another repository?"
> **Domain expert:** "Only when a checked-in **Token Policy** rule allows that exact **Repository Resource** and permission request for the verified workflow identity."

> **Dev:** "Can the workflow ask for broader permissions when it needs them?"
> **Domain expert:** "The workflow can request exact GitHub permission scopes, but **Token Policy** must explicitly allow the normalized **Installation Token Request**. GitHub also caps the request to the permissions granted to the GitHub App installation."

> **Dev:** "Do we keep the issued tokens for reuse?"
> **Domain expert:** "No. **cyspbot** does not cache issued **Installation Tokens**."

> **Dev:** "What decides whether a workflow run is trusted enough for Installation Token Issuance?"
> **Domain expert:** "The **Token Policy** evaluates the verified GitHub OIDC principal and the normalized **Installation Token Request**. Policy permits only explicit workflow refs and repository resources configured by the service."
