# cyspbot

cyspbot is a hosted Security Token Service for trusted automation workloads. Its token-exchange application authenticates workload identities using OpenID Connect ID Tokens from configured issuers, then exchanges authorized identities for short-lived, repository-scoped GitHub App installation access tokens without exposing the GitHub App private key outside Cloudflare. The [service contract](docs/service-contract.md) is authoritative for the current provider and policy inventory.

Implemented public endpoints:

- `POST /token` accepts an ID Token from a supported issuer and, after verification and policy authorization, exchanges it for a scoped GitHub App installation access token.
- `POST /github/webhooks` accepts signed GitHub App webhook deliveries and acknowledges them without retaining raw payloads or running downstream product logic.

The primary service contract is [docs/service-contract.md](docs/service-contract.md). The implementation reference is [docs/implementation.md](docs/implementation.md). The documentation map is [docs/README.md](docs/README.md).

## Implemented Architecture

- Two deployable Worker packages under `workers/*`: `@cyspbot/token-exchange` and `@cyspbot/github-webhook-receiver`.
- Worker names are consistently prefixed: `cyspbot-token-exchange` and `cyspbot-github-webhook-receiver`.
- Each Worker package owns its runtime composition, HTTP route, dependency defaults, and Wrangler config. Shared implementation code lives under `packages/*`. The root Wrangler config is only the local/test binding harness.
- A deep OIDC ID Token Authenticator that verifies tokens only through configured OIDC Provider Registrations.
- GitHub App private key in a Cloudflare Worker secret binding.
- A closed, checked-in Token Issuance Policy whose independently complete Permit Statements compose Effective Permissions pointwise.

## Current Public Surface

### `POST /token`

Primary endpoint for Installation Access Token Issuance. It accepts `application/x-www-form-urlencoded` OAuth token exchange input. The automation workload is the OAuth Client, cyspbot is the Authorization Server exposing the Token Endpoint, and the GitHub API is the Resource Server for the issued installation access token. cyspbot does not authenticate the Client or assume that it is the ID Token Subject.

```http
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
requested_token_type=urn:chikachow:github-app-installation-access-token
resource=https://api.github.com/repos/{owner}/{repo}
subject_token=<openid-connect-id-token>
subject_token_type=urn:ietf:params:oauth:token-type:id_token
```

`subject_token_type` must be `urn:ietf:params:oauth:token-type:id_token`; cyspbot does not accept the generic JWT token-type identifier. `requested_token_type` is required and must be the cyspbot GitHub App installation access token URN.
Every OpenID Connect ID Token supplied as the RFC 8693 subject token must have non-empty Issuer Identifier (`iss`), Audience (`aud`), and Subject (`sub`) claims plus numeric Expiration Time (`exp`) and Issued At (`iat`) claims. It must be accepted through an exact OIDC Provider Registration, be unexpired, and have the single audience value `cyspbot`. When the registration specifies an OIDC ID Token Profile, that profile validates the provider-specific token kind before Token Issuance Policy evaluates the request. Non-empty RFC 8693 `audience` form parameters are rejected as unsupported target selectors.

Requests must contain exactly one effective RFC 8693 `resource` value and may include one effective `scope` value to request a concrete GitHub App installation access token shape. Following OAuth token-endpoint rules, exactly empty occurrences are treated as omitted. The effective `resource` must be one canonical GitHub repository API URI in the form `https://api.github.com/repos/{owner}/{repo}` with no leading or trailing whitespace. cyspbot never infers the target Repository Resource from Subject Token Claims; no effective `resource` or more than one effective `resource` is rejected as `invalid_target`.

Each `scope` token has the form `<permission-name>:<level>`, where the level is `read`, `write`, or `admin`. cyspbot does not maintain a closed GitHub permission-name list: it normalizes structurally valid names into Requested Permissions, requires Permit Statements to cover every entry, and lets GitHub validate name and level compatibility. Order is not significant, repeated identical tokens are normalized once, and conflicting levels for one name are rejected. Omitted or exactly empty `scope` defaults to `contents:write pull_requests:write`; whitespace-only or padded values and multiple effective `scope` values are rejected.

Empty `scope` is not a no-permissions request. Following OAuth token endpoint parameter handling for this optional field, `scope=` is treated as omitted and receives the cyspbot default scope. GitHub's installation-access-token API treats an omitted `permissions` object as the app installation's default permissions, and live testing showed that a present empty `permissions: {}` object receives the same default permissions. cyspbot therefore requires a non-empty explicit scope when the Client does not want the cyspbot default.

OAuth client authentication is not supported at `/token`. Requests with an `Authorization` header or non-empty client-authentication form parameters are rejected rather than silently ignored.

Successful responses use OAuth token response shape with `Cache-Control: no-store` and `Pragma: no-cache`. The response always includes the canonical issued `scope`, so Clients can observe defaults and normalized ordering:

```json
{
  "access_token": "ghs_...",
  "issued_token_type": "urn:chikachow:github-app-installation-access-token",
  "token_type": "Bearer",
  "scope": "contents:write pull_requests:write",
  "expires_in": 3600
}
```

#### OIDC identity usage

Every configured provider requires the Client to supply an explicit repository `resource`. The service contract and implementation reference own the exact production OIDC Provider Registration inventory; the provider-specific guidance below describes supported source capabilities and does not itself assert production configuration.

##### GitHub Actions

A GitHub Actions OIDC token is an ID Token issued by `https://token.actions.githubusercontent.com`. An absent Authorized Party (`azp`) claim is accepted; when present, it must equal `cyspbot`. GitHub Actions Clients must explicitly supply `resource`; the signed `repository` Claim is verified context in the Subject Token Claims available to Token Issuance Policy and is not used to select the token target. Authentication does not create a Permit Statement.

##### Google service account ID Tokens

A Google service account Client presents a service account ID Token issued by the Google Cloud IAM authorization server. Its Issuer Identifier (`iss`) is `https://accounts.google.com`, and its signature is verified with the Google JWK Set.

The value supplied as an acquisition method's target audience becomes the ID Token Audience (`aud`) Claim and must be `cyspbot`. This acquisition value and resulting ID Token Claim are distinct from the RFC 8693 `audience` parameter in the later request to cyspbot; cyspbot rejects a non-empty RFC 8693 `audience` parameter.

**Direct IAM Credentials API request.** A caller can invoke [`projects.serviceAccounts.generateIdToken`](https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateIdToken) for the target service account with request field `audience` set to `cyspbot`. The caller needs `iam.serviceAccounts.getOpenIdToken` on that target service account. When only OIDC ID Tokens are required, use the least-privilege [Service Account OpenID Connect Identity Token Creator role](https://cloud.google.com/iam/docs/service-account-permissions#service_account_openid_connect_identity_token_creator_role) (`roles/iam.serviceAccountOpenIdTokenCreator`).

**Delegated IAM Credentials API request.** A [delegated request](https://cloud.google.com/iam/docs/create-short-lived-credentials-delegated) names an ordered chain of intermediary service accounts. The caller needs the Service Account Token Creator role (`roles/iam.serviceAccountTokenCreator`) on the first delegate; each delegate needs that role on the next service account; and the last delegate needs it on the target service account. The resulting ID Token represents only the target service account, not the caller or intermediary delegates. Do not substitute the narrower OpenID Connect Identity Token Creator role along delegation edges because delegation also requires the Token Creator role's implicit-delegation capability.

**Attached service account and metadata server.** Code running on a supported Google Cloud resource with an attached service account can [request an ID Token for that attached service account from the resource's metadata server](https://cloud.google.com/docs/authentication/get-id-token#metadata-server), setting the metadata identity endpoint's `audience` query parameter to `cyspbot`. This path does not call `generateIdToken` as the workload, so the direct-caller `iam.serviceAccounts.getOpenIdToken` grant above is not a prerequisite for the workload's metadata-server request. At provisioning time, the identity that attaches the service account needs the permissions required to create or update that kind of resource plus `iam.serviceAccounts.actAs` on the service account; the Service Account User role (`roles/iam.serviceAccountUser`) provides `actAs`. Those provisioning permissions are separate from the workload's runtime metadata request. Prefer this path when the workload already runs as the intended service account.

The Google service-account OIDC ID Token Profile accepts only ID Tokens whose Authorized Party (`azp`) exactly equals their non-empty Subject (`sub`). For this OIDC ID Token Profile, both claims contain the service account unique ID. This rule rejects Google user ID Tokens, whose Authorized Party is an OAuth client ID, while the configured Issuer Identifier rejects self-signed service account JWTs. Google Clients must explicitly supply `resource`; it is not inferred from Google claims. Authentication does not create a Permit Statement.

### `POST /github/webhooks`

Accepts signed JSON GitHub App webhook deliveries up to `256 KiB`. Webhook target headers must identify the configured GitHub App. Raw webhook bodies are not retained.

Signed `ping` deliveries return `202 {"accepted":true,"event":"ping"}`. Any other valid signed JSON event returns `202 {"accepted":true}` with no event-specific parsing or downstream work.

## Token Issuance Policy

Installation Access Token Issuance is allowed only when the closed, immutable set of checked-in Permit Statements covers a normalized Installation Access Token Request. Each independently complete statement contains an exact issuer, Claim Predicates over Subject Token Claims, one exact Repository Resource Constraint, and a non-empty permission map. Applicable statements combine permissions pointwise using `omitted < read < write < admin`; the policy permits the request only when the resulting Effective Permissions cover the Requested Permissions. Statement order has no meaning.

Registering an issuer authenticates its tokens but never creates authorization.
See the service contract for the current checked-in Permit Statement inventory.

### GitHub Actions

- the **Verified Subject Token** is derived from an ID Token issued by the configured GitHub Actions issuer
- the signed subject token audience is `cyspbot`, and any `azp` claim is accepted only if it also matches `cyspbot`
- `event_name` matches the checked-in statement
- `repository` and `ref` exactly match the checked-in statement
- `workflow_ref` exactly matches the checked-in statement
- `ref_type` is `branch`
- the statement's Repository Resource Constraint matches the normalized token request's exact Repository Resource
- the Effective Permissions contributed by all applicable statements cover the Requested Permissions

Repository identity in policy is intentionally based on the signed GitHub owner/repository name and the exact target Repository Resource rather than repository IDs or the `sub` Claim. A repository that is deleted and recreated with the same owner/name can match existing policy for that name, and token issuance still depends on the GitHub App being installed with sufficient permissions.

cyspbot denies forked pull request contexts, unconfigured refs, unconfigured workflow files, tag refs, and unsupported event names.

### Enforcement

The Client cannot select arbitrary GitHub Apps or repository IDs. It may request structurally valid GitHub permission names, but Token Issuance Policy must cover every Requested Permission; parsing a name never authorizes it. Cross-owner requests are possible only when explicitly permitted. Unlisted identities and repositories receive no default token.

cyspbot denies malformed `scope` values, Requested Permissions not covered by policy, and non-canonical resource forms.

## GitHub App Configuration

The GitHub App registration is the upper-bound authorization control plane for repository permissions. cyspbot narrows issued tokens to one checked-in Repository Resource, an allowed workflow context, and Requested Permissions covered by policy.

Webhook delivery requires the GitHub App webhook URL to point at:

```text
https://<your-cyspbot-origin>/github/webhooks
```

## Deployment Boundary

The checked-in Wrangler configs are public-safe templates for local development, tests, and dry-runs. Production deployment is handled by a separate pipeline outside this codebase. See [docs/deployment.md](docs/deployment.md).

Do not commit the downloaded key, converted key, `.dev.vars`, `.env`, `.wrangler/`, `.local-secrets/`, Cloudflare tokens, or deployment overlays.

## Local Development

1. Copy `.dev.vars.example` to `.dev.vars`.
2. Fill in the GitHub App ID, webhook secret, and local PKCS#8 PEM private key.
3. Install dependencies:

   ```bash
   pnpm install
   ```

4. Run checks:

   ```bash
   pnpm run check
   ```

5. Start local dev for both Worker configs with Wrangler's multi-worker mode:

   ```bash
   pnpm run dev
   ```

6. Or start local dev for only the Worker you are changing:

   ```bash
   pnpm --filter @cyspbot/token-exchange run dev
   pnpm --filter @cyspbot/github-webhook-receiver run dev
   ```

The root Wrangler config is a test harness for Vitest bindings, not a deployable product runtime.

Each Worker package generates ignored runtime types from its own Wrangler compatibility date and flags immediately before type-checking. The small Env types remain checked in so the combined test project can consume both generated environment interfaces without including either Worker's runtime types.

The public Wrangler configs declare required secret names. Secret values live in Cloudflare for production and `.dev.vars` for local development.

The token-exchange Worker uses the service-owned GitHub App from `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`.

## GitHub Actions Usage

Workflows that call cyspbot directly need permission to request a GitHub Actions OIDC token:

```yaml
permissions:
  id-token: write
```

That permission is necessary but not sufficient. cyspbot also requires applicable Token Issuance Policy statements for the verified repository, event, branch ref, and `workflow_ref` to cover the requested Repository Resource and Requested Permissions.

The reusable GitHub Action for this hosted service lives in the separate `cyspbot-app-token-action` repository.

## External References

- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [OpenID Connect Core 1.0: ID Token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
- [Fly.io OpenID Connect](https://fly.io/docs/security/openid-connect/)
- [Fly Machines API Tokens resource](https://fly.io/docs/machines/api/tokens-resource/)
- [GitHub Actions OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [Google Cloud authentication token types](https://cloud.google.com/docs/authentication/token-types#service_account_id_tokens)
- [Google IAM service account resource](https://cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts)
- [Google IAM Credentials `generateIdToken`](https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateIdToken)
- [Google IAM roles for service account authentication](https://cloud.google.com/iam/docs/service-account-permissions)
- [Google IAM delegated short-lived credentials](https://cloud.google.com/iam/docs/create-short-lived-credentials-delegated)
- [Google Cloud: Get an ID token](https://cloud.google.com/docs/authentication/get-id-token)
- [GitHub App installation access tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Repository Workflows

This repository has public-safe service workflows:

- `ci`: runs on pull requests and pushes to `main`; coordinates reusable jobs for formatting, linting, generated Env type freshness, type-checking against each Worker's runtime types, Knip, tests, and Wrangler deploy dry runs.
- `run-cyspbot-deploy-update`: runs on `workflow_dispatch`, or on `workflow_run` after the `ci` workflow completes successfully on `main`; it starts the external deployment repository's update workflow.

Production deployment workflows and secrets live outside this codebase.
