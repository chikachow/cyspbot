# cyspbot

cyspbot is the maintainer's hosted automation application. It lets trusted automation workloads obtain repository-scoped GitHub App installation access tokens without exposing the GitHub App private key outside Cloudflare.

The service contract is [docs/service-contract.md](docs/service-contract.md). The implementation reference is [docs/implementation.md](docs/implementation.md).

## Language

**Caller**:
An automation workload that presents an OIDC token from a configured issuer to **cyspbot**.
_Avoid_: User, human, consumer

**Verified Subject Token**:
The cyspbot-internal authentication result after an OIDC/JWT subject token has been cryptographically verified against a **Trusted OIDC Issuer**, checked for the cyspbot audience, and accepted by issuer-adapter token-binding checks.
_Avoid_: Principal, raw JWT, unverified subject

**Subject Token Claims**:
The verified JWT claims carried by a **Verified Subject Token**. **Token Policy** may read these through CEL as `claims["..."]`, but cyspbot does not require issuer-specific claims unless a checked-in policy condition names them.
_Avoid_: Derived principal fields, caller-provided attributes

**Fly Machine Identity**:
The internally consistent organization, app, and Machine identity authenticated from a Fly.io subject token. It requires immutable IDs, binds the organization name to the configured issuer slug, and binds the subject to the organization, app, and Machine names.
_Avoid_: Fly user, app secret, unverified Machine metadata

**Installation Token Issuance**:
The cyspbot capability that exchanges a trusted OIDC token for a short-lived GitHub App installation access token for callers that satisfy cyspbot's checked-in OIDC trust policy.
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
The cyspbot-enforced static allow-list that decides whether a **Verified Subject Token** may receive exactly the normalized **Installation Token Request**. Each rule has a typed issuer guard, a typed GitHub installation-token grant, and a CEL condition over verified subject-token claims and normalized request fields.
_Avoid_: Profile selector, grant builder, ad hoc caller-defined permissions, event-name-only policy, provider-specific principal mapper

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
- A **Caller** authenticates to **cyspbot** with an OIDC token from a configured issuer.
- A verified **Caller** is represented internally as a **Verified Subject Token**.
- A Fly.io **Verified Subject Token** must carry a canonical **Fly Machine Identity** before its claims can reach **Token Policy**.
- cyspbot verifies a **Caller** only against a **Trusted OIDC Issuer**.
- **cyspbot** normalizes exactly one **Installation Token Request** from token-exchange `scope`, token-exchange `resource`, and, for GitHub Actions defaulting only, the verified `repository` claim.
- **Installation Token Issuance** in **cyspbot** issues at most one **Installation Token** for one **Repository Resource**.
- The **Token Policy** is fixed by **cyspbot** for subject-token issuer, repository resource, GitHub permission request, and CEL claim condition, while the GitHub App configuration remains the upper bound.
- The **Token Policy** evaluates only verified **Subject Token Claims** named by a checked-in CEL condition, such as GitHub `repository`, `sub`, `ref`, `event_name`, and `workflow_ref`.
- The **Token Exchange Endpoint** is the only public interface for **Installation Token Issuance**.
- The **JWKS Cache** supplies verification keys for a **Trusted OIDC Issuer**, but never stores issued **Installation Tokens**.
- A **GitHub App Installation** is the GitHub-side authority that allows **cyspbot** to issue an **Installation Token**.
- The **Webhook Receiver** accepts GitHub webhook deliveries only after signature and envelope validation.
- The **Webhook Receiver** acknowledges signed unsupported events without writing state.
- The **Webhook Receiver** fails closed with a server-side error when no webhook secret is configured.

## Example dialogue

> **Dev:** "Can this workflow ask for a token for another repository?"
> **Domain expert:** "Only when a checked-in **Token Policy** rule allows that exact **Repository Resource** and permission request for the verified **Subject Token Claims**."

> **Dev:** "Can the workflow ask for broader permissions when it needs them?"
> **Domain expert:** "The workflow can request exact GitHub permission scopes, but **Token Policy** must explicitly allow the normalized **Installation Token Request**. GitHub also caps the request to the permissions granted to the GitHub App installation."

> **Dev:** "Do we keep the issued tokens for reuse?"
> **Domain expert:** "No. **cyspbot** does not cache issued **Installation Tokens**."

> **Dev:** "What decides whether a workflow run is trusted enough for Installation Token Issuance?"
> **Domain expert:** "The **Token Policy** evaluates the **Verified Subject Token** and the normalized **Installation Token Request**. Policy permits only explicit issuer, claim, repository resource, and permission combinations configured by the service."
