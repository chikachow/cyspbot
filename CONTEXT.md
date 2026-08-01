# cyspbot

cyspbot is the maintainer's hosted automation application. It lets trusted automation workloads obtain repository-scoped GitHub App installation access tokens without exposing the GitHub App private key outside Cloudflare.

The service contract is [docs/service-contract.md](docs/service-contract.md). The implementation reference is [docs/implementation.md](docs/implementation.md).

## Language

**Token Exchange Client**:
The OAuth Client that sends a token exchange request to **cyspbot**. It presents an OpenID Connect ID Token as the RFC 8693 subject token, but cyspbot does not authenticate the Client and does not assume that the Client is the token's Subject.
_Avoid_: Authenticated Caller, Subject, User, human, consumer

**Fly Machine Identity**:
The organization, Fly App, and Machine identity represented by the signed claims in a Fly OIDC token. The Fly provider registration constructor intentionally applies no provider-specific cross-Claim profile; authorization constraints select the signed claims that matter to each Permit Statement.
_Avoid_: Principal, VM identity, caller-supplied Machine metadata

**Fly Organization Slug**:
The provider-defined slug used in a Fly organization's **OIDC Issuer Identifier** and signed claims. A reviewed, checked-in registration may use it to identify one **OIDC Provider Registration**, but a slug never authorizes token issuance.
_Avoid_: Organization ID, tenant ID, authorization boundary

**Google Service Account Identity**:
The Google service account identity authenticated from a service account ID Token issued by the Google Cloud IAM authorization server. Its authorization key is the service account unique ID asserted as the Subject with an equal Authorized Party; a verified email can be an additional constraint.
_Avoid_: Principal, service account email as the primary key, downloaded service account key

**Verified Subject Token**:
The cyspbot-internal validated representation of the RFC 8693 subject token after its OpenID Connect ID Token has been cryptographically verified through an **OIDC Provider Registration**, checked for the cyspbot subject-token audience, and, when the registration specifies one, accepted by its **OIDC ID Token Profile**. It represents the authenticated Subject, not the **Token Exchange Client**, and is not the serialized token.
_Avoid_: Authenticated Client, Principal, raw JWT, unverified subject

**OIDC Verification Evidence**:
Audit-only facts about how a **Verified Subject Token** was authenticated, currently the resolved signing-key ID. It is retained outside the subject identity and is not exposed to **Token Issuance Policy**.
_Avoid_: Subject Token Claims, authorization attribute, provider registration

**Subject Token Claims**:
The verified claims carried by a **Verified Subject Token**; they describe the identity and context asserted by an **OpenID Provider**.
Only `sub` is the OIDC **Subject Identifier**; contextual Claims such as `repository` are not subject identity.
_Avoid_: The serialized subject token, derived principal fields, Client-provided attributes, subject identity for contextual Claims

**Installation Access Token Issuance**:
The cyspbot capability that exchanges a **Verified Subject Token** for a short-lived GitHub App installation access token when **Token Issuance Policy** permits issuance for the combination of that token and an **Installation Access Token Request**.
_Avoid_: cyspbot itself, app login

**Installation Access Token Request**:
The normalized cyspbot-internal request for one GitHub App installation access token. It contains exactly one canonical GitHub repository API resource and the GitHub App permissions requested for that resource.
_Avoid_: Profile, grant, target selector, raw form values

**Requested Permissions**:
The canonical permission map derived from the **Token Exchange Client**'s optional OAuth `scope`, or from the service default when `scope` is omitted, for one **Installation Access Token Request**.
_Avoid_: Client-selected permission map, raw scope string, GitHub `permissions` request object

**Repository Resource**:
A canonical GitHub API repository URI in the form `https://api.github.com/repos/{owner}/{repo}`. One **Installation Access Token Request** contains exactly one **Repository Resource**.
_Avoid_: `owner/repo` shorthand, GitHub HTML URL, workflow endpoint URL

**Repository Resource Constraint**:
A checked-in owner and repository-name selector that compiles to one exact **Repository Resource** in a **Permit Statement**.
_Avoid_: Repository Resource, arbitrary URI matcher, subject-token repository Claim

**GitHub App Installation**:
The installation of the configured GitHub App on a specific repository or owner scope for which GitHub can issue a GitHub App installation access token.
_Avoid_: App session, app login

**Installation Access Token**:
The short-lived GitHub App installation access token issued for a **Repository Resource** through one **GitHub App Installation**.
_Avoid_: PAT, app JWT, repository secret

**Token Issuance Policy**:
The closed, immutable set of checked-in **Permit Statements** that decides whether issuance is permitted for a **Verified Subject Token** and normalized **Installation Access Token Request**. All applicable statements contribute permissions pointwise; issuance is permitted only when their **Effective Permissions** cover the **Requested Permissions**.
_Avoid_: Ordered rules, first-match policy, caller-defined policy, generic expression language

**Permit Statement**:
One independently complete authorization statement in the **Token Issuance Policy**. It contains an **OIDC Subject Token Constraint**, one exact **Repository Resource Constraint**, and a non-empty permission map. Statements may independently share a subject or target and do not inherit fields from one another.
_Avoid_: Partial rule, inherited default, deny statement

**OIDC Subject Token Constraint**:
An exact **OIDC Issuer Identifier** plus a total predicate over verified **Subject Token Claims**. Missing or wrongly typed selected claims make the constraint non-applicable.
_Avoid_: Authentication profile, claim mapping, unverified JWT inspection

**Effective Permissions**:
The pointwise maximum of permissions contributed by all applicable **Permit Statements**, using `omitted < read < write`. A request is permitted only when the **Effective Permissions** cover the **Requested Permissions**.
_Avoid_: First matching statement, whole-map equality, GitHub installation permissions

**Webhook Receiver**:
A cyspbot Worker that validates GitHub webhook authenticity and envelope fields, acknowledges valid signed deliveries, and does not retain raw payloads or run product-specific event handling.
_Avoid_: Business event processor, schema-normalizer

**Token Exchange Endpoint**:
The cyspbot Token Endpoint that accepts an ID Token from a **Token Exchange Client** as the RFC 8693 subject token and returns an **Installation Access Token** using OAuth 2.0 Token Exchange.
_Avoid_: installation collection endpoint, raw GitHub passthrough

**OpenID Provider**:
An external OpenID Connect provider that issues ID Tokens and publishes configuration describing its issuer and verification keys.
_Avoid_: OIDC Provider Registration, cyspbot, token caller

**OIDC Issuer Identifier**:
The exact, case-sensitive HTTPS identifier asserted by an **OpenID Provider** in **OpenID Provider Metadata** and ID Token `iss` claims.
_Avoid_: Provider alias, discovery URL, JWK Set URI

**OIDC Provider Registration**:
A code-owned cyspbot trust decision for one exact **OIDC Issuer Identifier**, its accepted ID Token signing algorithms, and either one **OIDC ID Token Profile** or an explicit `null` profile.
_Avoid_: Trusted OIDC Issuer, arbitrary identity provider, provider alias

**OIDC ID Token Profile**:
Optional code-owned, application-specific rules that distinguish the accepted kind of ID Token for one **OIDC Provider Registration** after cryptographic, issuer, audience, algorithm, and time validation. An explicit `null` means central validation is sufficient.
_Avoid_: Token Issuance Policy, claim mapping, provider configuration

**OpenID Provider Configuration Document**:
The issuer-published JSON document returned by an OpenID Provider Configuration Response. It contains Claims that are a subset of **OpenID Provider Metadata**.
_Avoid_: OIDC Provider Registration, Token Issuance Policy, Client-supplied metadata

**OpenID Provider Metadata**:
The standards-defined metadata values describing an **OpenID Provider**. cyspbot validates the Issuer Identifier, `jwks_uri`, and advertised ID Token signing algorithms that it needs from the **OpenID Provider Configuration Document**, then retains the immutable intersection of advertised and provider-locally accepted signing algorithms for verification.
_Avoid_: OIDC Provider Registration, the raw Configuration Response, Token Issuance Policy

**OIDC ID Token Authenticator**:
The cyspbot authentication capability that turns an ID Token from an **OIDC Provider Registration** into a **Verified Subject Token**.
_Avoid_: OpenID Federation trust-chain implementation, Token Issuance Policy, dynamic issuer discovery

**JWK Set Cache**:
A short-lived cache of verification keys obtained from the `jwks_uri` value in validated **OpenID Provider Metadata** for an **OIDC Provider Registration**.
_Avoid_: Permanent key store, token cache, Client-controlled key source

## Relationships

- The product surface is `POST /token` and `POST /github/webhooks`.
- A **Token Exchange Client** presents an ID Token as the RFC 8693 subject token; cyspbot does not authenticate the Client.
- A successfully validated subject token is represented internally as a **Verified Subject Token** describing its authenticated Subject.
- **OIDC Verification Evidence** can support audit logs but cannot affect **Token Issuance Policy**.
- An **OIDC ID Token Profile**, when present on an **OIDC Provider Registration**, validates token-kind rules before an ID Token becomes a **Verified Subject Token**.
- The **OIDC ID Token Authenticator** validates a subject token only through an **OIDC Provider Registration**.
- **cyspbot** normalizes exactly one **Installation Access Token Request** from an explicit token-exchange `resource` and optional `scope` before validating the subject token.
- The **Token Issuance Policy** is the first layer that combines a normalized **Installation Access Token Request** with a **Verified Subject Token**; **Subject Token Claims** never select the target **Repository Resource**.
- **Installation Access Token Issuance** in **cyspbot** issues at most one **Installation Access Token** for one **Repository Resource**.
- The **Token Issuance Policy** is fixed by **cyspbot** as checked-in **Permit Statements**, while the GitHub App installation remains the upper bound.
- Applicable **Permit Statements** combine permissions pointwise; broader **Requested Permissions** may be covered by several independently complete statements.
- Every issuer used by **Token Issuance Policy** must have an **OIDC Provider Registration**, but a registration creates no **Permit Statement** by itself.
- The **Token Exchange Client** is the OAuth Client, **cyspbot** is the Authorization Server exposing the **Token Exchange Endpoint**, and the GitHub API is the Resource Server for the issued **Installation Access Token**.
- The **Token Exchange Endpoint** is the only public interface for **Installation Access Token Issuance**.
- The **JWK Set Cache** supplies verification keys for an **OIDC Provider Registration**, but never stores issued **Installation Access Tokens**.
- A **GitHub App Installation** is an independent GitHub authorization control and the upper bound on repositories and permissions available to an **Installation Access Token**.
- The **Webhook Receiver** accepts GitHub webhook deliveries only after signature and envelope validation.
- The **Webhook Receiver** acknowledges signed unsupported events without writing state.
- The **Webhook Receiver** fails closed with a server-side error when no webhook secret is configured.

## Example dialogue

> **Dev:** "Can this workflow ask for a token for another repository?"
> **Domain expert:** "Only when applicable checked-in **Permit Statements** for that exact **Repository Resource** combine to cover the **Requested Permissions**."

> **Dev:** "Can the workflow ask for broader permissions when it needs them?"
> **Domain expert:** "The workflow can request exact GitHub permission scopes, but **Token Issuance Policy** must cover the resulting **Requested Permissions** in the normalized **Installation Access Token Request**. GitHub also caps the request to the permissions granted to the GitHub App installation."

> **Dev:** "Do we keep the issued tokens for reuse?"
> **Domain expert:** "No. **cyspbot** does not cache issued **Installation Access Tokens**."

> **Dev:** "What decides whether a workflow run is trusted enough for Installation Access Token Issuance?"
> **Domain expert:** "The **Token Issuance Policy** evaluates the **Verified Subject Token** and normalized **Installation Access Token Request**. It permits issuance only when the **Effective Permissions** composed from applicable checked-in **Permit Statements** cover the **Requested Permissions**."
