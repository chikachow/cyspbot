# cyspbot

cyspbot is the maintainer's hosted automation application. It lets trusted automation workloads obtain repository-scoped GitHub App installation access tokens without exposing the GitHub App private key outside Cloudflare.

The service contract is [docs/service-contract.md](docs/service-contract.md). The implementation reference is [docs/implementation.md](docs/implementation.md).

## Language

**Token Exchange Client**:
The OAuth Client that sends a token exchange request to **cyspbot**. It presents an OpenID Connect ID Token as the RFC 8693 subject token, but cyspbot does not authenticate the Client and does not assume that the Client is the token's Subject.
_Avoid_: Authenticated Caller, Subject, User, human, consumer

**Fly Machine Identity**:
The organization, Fly App, and Machine identity authenticated from a Fly OIDC token. It uses provider-assigned organization and Fly App IDs plus a stable Machine ID, and binds the organization slug and Subject to the configured Issuer Identifier and Machine name.
_Avoid_: Principal, VM identity, caller-supplied Machine metadata

**Fly Organization Slug**:
The provider-defined slug used in a Fly organization's **OIDC Issuer Identifier** and in the signed `org_name` claim. It selects one configured **OIDC Provider Registration** but is not the provider-assigned organization ID (`org_id`) or, by itself, an authorization grant.
_Avoid_: Organization ID, tenant ID, authorization boundary

**Google Service Account Identity**:
The Google service account identity authenticated from a service account ID Token issued by the Google Cloud IAM authorization server. Its authorization key is the service account unique ID asserted as the Subject with an equal Authorized Party; a verified email can be an additional constraint.
_Avoid_: Principal, service account email as the primary key, downloaded service account key

**Verified Subject Token**:
The cyspbot-internal validated representation of the RFC 8693 subject token after its OpenID Connect ID Token has been cryptographically verified through an **OIDC Provider Registration**, checked for the cyspbot subject-token audience, and accepted by its **OIDC ID Token Profile**. It represents the authenticated Subject, not the **Token Exchange Client**, and is not the serialized token.
_Avoid_: Authenticated Client, Principal, raw JWT, unverified subject

**OIDC Verification Evidence**:
Audit-only facts about how a **Verified Subject Token** was authenticated, currently the resolved signing-key ID. It is retained outside the subject identity and is not exposed to **Token Policy**.
_Avoid_: Subject Token Claims, authorization attribute, provider registration

**Subject Token Claims**:
The verified claims carried by a **Verified Subject Token**. They describe the identity and context asserted by an **OpenID Provider**.
_Avoid_: The serialized subject token, derived principal fields, Client-provided attributes

**Installation Access Token Issuance**:
The cyspbot capability that exchanges a **Verified Subject Token** for a short-lived GitHub App installation access token when **Token Policy** allows that **Verified Subject Token** to receive the **Installation Access Token Request**.
_Avoid_: cyspbot itself, app login

**Installation Access Token Request**:
The normalized cyspbot-internal request for one GitHub App installation access token. It contains exactly one canonical GitHub repository API resource and the GitHub App permissions requested for that resource.
_Avoid_: Profile, grant, target selector, raw form values

**Repository Resource**:
A canonical GitHub API repository URI in the form `https://api.github.com/repos/{owner}/{repo}`. One **Installation Access Token Request** contains exactly one **Repository Resource**.
_Avoid_: `owner/repo` shorthand, GitHub HTML URL, workflow endpoint URL

**GitHub App Installation**:
The installation of the configured GitHub App on a specific repository or owner scope for which GitHub can issue a GitHub App installation access token.
_Avoid_: App session, app login

**Installation Access Token**:
The short-lived GitHub App installation access token issued for a **Repository Resource** through one **GitHub App Installation**.
_Avoid_: PAT, app JWT, repository secret

**Token Policy**:
The cyspbot-enforced static allow-list that decides whether a **Verified Subject Token** may receive exactly the normalized **Installation Access Token Request**. Each rule has a typed issuer guard, a typed GitHub installation-access-token grant that structurally matches the resource and permissions, and a CEL condition over verified **Subject Token Claims** only. The issuer guard is structural and is not a CEL binding.
_Avoid_: Profile selector, grant builder, ad hoc caller-defined permissions, event-name-only policy, provider-specific principal mapper

**Webhook Receiver**:
A cyspbot Worker that validates GitHub webhook authenticity and envelope fields, acknowledges valid signed deliveries, and does not retain raw payloads or run product-specific event handling.
_Avoid_: Business event processor, schema-normalizer

**Token Exchange Endpoint**:
The cyspbot Token Endpoint that accepts an ID Token from a **Token Exchange Client** as the RFC 8693 subject token and returns an **Installation Access Token** using OAuth 2.0 Token Exchange.
_Avoid_: installation collection endpoint, raw GitHub passthrough

**OpenID Provider**:
An external OpenID Connect authority that issues ID Tokens and publishes configuration describing its issuer and verification keys.
_Avoid_: OIDC Provider Registration, cyspbot, token caller

**OIDC Issuer Identifier**:
The exact, case-sensitive HTTPS identifier asserted by an **OpenID Provider** in **OpenID Provider Metadata** and ID Token `iss` claims.
_Avoid_: Provider alias, discovery URL, JWK Set URI

**OIDC Provider Registration**:
A code-owned cyspbot trust decision for one exact **OIDC Issuer Identifier**, its accepted ID Token signing algorithms, and its **OIDC ID Token Profile**.
_Avoid_: Trusted OIDC Issuer, arbitrary identity provider, provider alias

**OIDC ID Token Profile**:
The code-owned, application-specific rules that distinguish the accepted kind of ID Token for one **OIDC Provider Registration** after cryptographic, issuer, audience, algorithm, and time validation.
_Avoid_: Token Policy, claim mapping, provider configuration

**OpenID Provider Configuration Document**:
The issuer-published JSON document returned by an OpenID Provider Configuration Response. It contains Claims that are a subset of **OpenID Provider Metadata**.
_Avoid_: OIDC Provider Registration, Token Policy, Client-supplied metadata

**OpenID Provider Metadata**:
The standards-defined metadata values describing an **OpenID Provider**. cyspbot validates the Issuer Identifier, `jwks_uri`, and advertised ID Token signing algorithms that it needs from the **OpenID Provider Configuration Document**, then retains the immutable intersection of advertised and provider-locally accepted signing algorithms for verification.
_Avoid_: OIDC Provider Registration, the raw Configuration Response, Token Policy

**OIDC ID Token Authenticator**:
The cyspbot authentication capability that turns an ID Token from an **OIDC Provider Registration** into a **Verified Subject Token**.
_Avoid_: OpenID Federation trust-chain implementation, Token Policy, dynamic issuer discovery

**JWK Set Cache**:
A short-lived cache of verification keys obtained from the `jwks_uri` value in validated **OpenID Provider Metadata** for an **OIDC Provider Registration**.
_Avoid_: Permanent key store, token cache, Client-controlled key source

## Relationships

- The product surface is `POST /token` and `POST /github/webhooks`.
- A **Token Exchange Client** presents an ID Token as the RFC 8693 subject token; cyspbot does not authenticate the Client.
- A successfully validated subject token is represented internally as a **Verified Subject Token** describing its authenticated Subject.
- **OIDC Verification Evidence** can support audit logs but cannot affect **Token Policy**.
- The **OIDC ID Token Profile** for each **OIDC Provider Registration** validates token-kind rules before an ID Token becomes a **Verified Subject Token**.
- The **OIDC ID Token Authenticator** validates a subject token only through an **OIDC Provider Registration**.
- **cyspbot** normalizes exactly one **Installation Access Token Request** from an explicit token-exchange `resource` and optional `scope` before validating the subject token.
- The **Token Policy** is the first layer that combines a normalized **Installation Access Token Request** with a **Verified Subject Token**; subject-token claims never select the target **Repository Resource**.
- **Installation Access Token Issuance** in **cyspbot** issues at most one **Installation Access Token** for one **Repository Resource**.
- The **Token Policy** is fixed by **cyspbot** for subject-token issuer, repository resource, GitHub permission request, and CEL claim condition, while the GitHub App configuration remains the upper bound.
- The **Token Policy** evaluates only verified **Subject Token Claims** named by a checked-in CEL condition, such as Fly `org_id`, `app_id`, and `machine_id`; GitHub `repository`, `sub`, `ref`, `event_name`, and `workflow_ref`; or Google `sub`, `email`, and `email_verified`.
- The **Token Exchange Client** is the OAuth Client, **cyspbot** is the Authorization Server exposing the **Token Exchange Endpoint**, and the GitHub API is the Resource Server for the issued **Installation Access Token**.
- The **Token Exchange Endpoint** is the only public interface for **Installation Access Token Issuance**.
- The **JWK Set Cache** supplies verification keys for an **OIDC Provider Registration**, but never stores issued **Installation Access Tokens**.
- A **GitHub App Installation** is the GitHub-side authority that allows **cyspbot** to issue an **Installation Access Token**.
- The **Webhook Receiver** accepts GitHub webhook deliveries only after signature and envelope validation.
- The **Webhook Receiver** acknowledges signed unsupported events without writing state.
- The **Webhook Receiver** fails closed with a server-side error when no webhook secret is configured.

## Example dialogue

> **Dev:** "Can this workflow ask for a token for another repository?"
> **Domain expert:** "Only when a checked-in **Token Policy** rule allows that exact **Repository Resource** and permission request for the verified **Subject Token Claims**."

> **Dev:** "Can the workflow ask for broader permissions when it needs them?"
> **Domain expert:** "The workflow can request exact GitHub permission scopes, but **Token Policy** must explicitly allow the normalized **Installation Access Token Request**. GitHub also caps the request to the permissions granted to the GitHub App installation."

> **Dev:** "Do we keep the issued tokens for reuse?"
> **Domain expert:** "No. **cyspbot** does not cache issued **Installation Access Tokens**."

> **Dev:** "What decides whether a workflow run is trusted enough for Installation Access Token Issuance?"
> **Domain expert:** "The **Token Policy** evaluates the **Verified Subject Token** and the normalized **Installation Access Token Request**. Policy permits only explicit issuer, claim, repository resource, and permission combinations configured by the service."
