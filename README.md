# cyspbot

cyspbot is a hosted Security Token Service for trusted automation workloads. It authenticates Fly Machine, GitHub Actions workflow-job, and Google service account identities using OpenID Connect ID Tokens from configured issuers, then exchanges authorized identities for short-lived, repository-scoped GitHub App installation access tokens without exposing the GitHub App private key outside Cloudflare.

Implemented public endpoints:

- `POST /token` accepts an ID Token from a supported issuer and, after verification and policy authorization, exchanges it for a scoped GitHub App installation access token.
- `POST /github/webhooks` accepts signed GitHub App webhook deliveries and acknowledges them without retaining raw payloads or running downstream product logic.

The primary service contract is [docs/service-contract.md](docs/service-contract.md). The implementation reference is [docs/implementation.md](docs/implementation.md). The documentation map is [docs/README.md](docs/README.md).

## Implemented Architecture

- Two deployable Worker packages under `workers/*`: `@cyspbot/token-exchange` and `@cyspbot/github-webhook-receiver`.
- Worker names are consistently prefixed: `cyspbot-token-exchange` and `cyspbot-github-webhook-receiver`.
- Each Worker package owns its runtime composition, HTTP route, dependency defaults, and Wrangler config. Shared implementation code lives under `packages/*`. The root Wrangler config is only the local/test binding harness.
- `jose`-backed OpenID Connect ID Token verification behind configured issuer adapters.
- GitHub App private key in a Cloudflare Worker secret binding.
- Checked-in Token Policy code that allows Installation Token Issuance only for explicit verified subject-token issuer, CEL claim condition, resource, and permission combinations.

## Current Public Surface

### `POST /token`

Primary endpoint for Installation Token Issuance. It accepts `application/x-www-form-urlencoded` OAuth token exchange input:

```http
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
requested_token_type=urn:chikachow:github-app-installation-access-token
subject_token=<openid-connect-id-token>
subject_token_type=urn:ietf:params:oauth:token-type:id_token
```

`subject_token_type` must be `urn:ietf:params:oauth:token-type:id_token`; cyspbot does not accept the generic JWT token-type identifier. `requested_token_type` is required and must be the cyspbot GitHub App installation token URN.
Every OpenID Connect ID Token supplied as the RFC 8693 subject token must have non-empty Issuer Identifier (`iss`), Audience (`aud`), and Subject (`sub`) claims plus numeric Expiration Time (`exp`) and Issued At (`iat`) claims. It must be signed by a configured issuer, be unexpired, and have the single audience value `cyspbot`. The selected issuer adapter then applies its provider-specific subject binding before Token Policy evaluates the request. Non-empty RFC 8693 `audience` form parameters are rejected as unsupported target selectors.

Requests may include RFC 8693 `scope` and `resource` fields to request a concrete GitHub App installation token shape. `resource` must be one canonical GitHub repository API URI in the form `https://api.github.com/repos/{owner}/{repo}` with no leading or trailing whitespace. `scope` is a single-ASCII-space-delimited list of exact GitHub App permission requests, such as `actions:read`, `actions:write`, or `contents:read pull_requests:read`; order is not significant, and repeated identical scope tokens are normalized once. Omitted or exactly empty `scope` defaults to `contents:write pull_requests:write`. Whitespace-only or padded values and duplicate or multi-value `scope` and `resource` form fields are rejected.

Empty `scope` is not a no-permissions request. Following OAuth token endpoint parameter handling for this optional field, `scope=` is treated as omitted and receives the cyspbot default scope. GitHub's installation-token API treats an omitted `permissions` object as the app installation's default permissions, and live testing showed that a present empty `permissions: {}` object receives the same default permissions. cyspbot therefore requires a non-empty explicit scope when the caller does not want the cyspbot default.

OAuth client authentication is not supported at `/token`. Requests with an `Authorization` header or non-empty client-authentication form parameters are rejected rather than silently ignored.

Successful responses use OAuth token response shape with `Cache-Control: no-store` and `Pragma: no-cache`. The response always includes the canonical issued `scope`, so callers can observe defaults and normalized ordering:

```json
{
  "access_token": "ghs_...",
  "issued_token_type": "urn:chikachow:github-app-installation-access-token",
  "token_type": "Bearer",
  "scope": "contents:write pull_requests:write",
  "expires_in": 3600
}
```

#### Supported issuers

| Token provider/profile           | Issuer Identifier (`iss`)                     | Additional subject binding                        | Omitted `resource`        |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------- | ------------------------- |
| Fly.io                           | `https://oidc.fly.io/{org-slug}`              | Issuer organization and canonical Subject binding | Rejected                  |
| GitHub Actions                   | `https://token.actions.githubusercontent.com` | `azp` is absent or equals `cyspbot`               | Signed `repository` claim |
| Google service account ID Tokens | `https://accounts.google.com`                 | `azp` equals `sub`                                | Rejected                  |

##### Fly.io

A Fly Machine obtains a Fly OIDC token from the [Machines API token endpoint](https://fly.io/docs/machines/api/tokens-resource/) through its local Unix socket:

```bash
curl --unix-socket /.fly/api \
  -X POST http://localhost/v1/tokens/oidc \
  --data '{"aud":"cyspbot"}'
```

The `aud` JSON property customizes the ID Token Audience claim; it is distinct from the unsupported RFC 8693 `audience` token-exchange parameter. cyspbot accepts only configured organization-specific Issuer Identifiers of the form `https://oidc.fly.io/{org-slug}`. Configure the comma-delimited Fly Organization Slugs in `FLY_OIDC_ORG_SLUGS`. Empty entries are ignored, duplicate entries are trusted once, and an entry with unsupported Fly issuer-path syntax is logged and skipped without disabling other configured issuers. A missing binding is logged and configures no Fly Trusted OIDC Issuer without disabling other providers. Syntax acceptance does not establish that a Fly organization exists.

The Fly.io adapter requires the signed organization, Fly App, and Machine names used by the canonical Subject (`sub`) value `{org_name}:{app_name}:{machine_name}`. The organization name must match the configured Issuer Identifier. Other signed claims are available to Token Policy but do not affect authentication unless a rule selects them. The adapter does not use the Authorized Party (`azp`) claim when validating Fly subject-token binding.

Fly callers must explicitly supply `resource`; it is not inferred from Fly claims. Authentication does not create a grant: Token Policy must allow the provider-assigned organization and Fly App IDs, optionally one stable Machine ID, the repository resource, and the exact permissions. Callers should obtain a fresh Fly OIDC token rather than reusing one after its Expiration Time (`exp`).

##### GitHub Actions

A GitHub Actions OIDC token is an ID Token issued by `https://token.actions.githubusercontent.com`. An absent Authorized Party (`azp`) claim is accepted; when present, it must equal `cyspbot`. An omitted or exactly empty `resource` defaults to the token's signed `repository` claim. Authentication does not create a grant: Token Policy must still match the signed workflow identity, repository resource, and exact permissions.

##### Google service account ID Tokens

A Google service account caller presents a service account ID Token issued by the Google Cloud IAM authorization server. Its Issuer Identifier (`iss`) is `https://accounts.google.com`, and its signature is verified with the Google JWKS.

The value supplied as an acquisition method's target audience becomes the ID Token Audience (`aud`) claim and must be `cyspbot`. This acquisition value and signed claim are distinct from the RFC 8693 `audience` parameter in the later request to cyspbot; cyspbot rejects a non-empty RFC 8693 `audience` parameter.

**Direct IAM Credentials API request.** A caller can invoke [`projects.serviceAccounts.generateIdToken`](https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateIdToken) for the target service account with request field `audience` set to `cyspbot`. The caller needs `iam.serviceAccounts.getOpenIdToken` on that target service account. When only OIDC ID Tokens are required, use the least-privilege [Service Account OpenID Connect Identity Token Creator role](https://cloud.google.com/iam/docs/service-account-permissions#service_account_openid_connect_identity_token_creator_role) (`roles/iam.serviceAccountOpenIdTokenCreator`).

**Delegated IAM Credentials API request.** A [delegated request](https://cloud.google.com/iam/docs/create-short-lived-credentials-delegated) names an ordered chain of intermediary service accounts. The caller needs the Service Account Token Creator role (`roles/iam.serviceAccountTokenCreator`) on the first delegate; each delegate needs that role on the next service account; and the last delegate needs it on the target service account. The resulting ID Token represents only the target service account, not the caller or intermediary delegates. Do not substitute the narrower OpenID Connect Identity Token Creator role along delegation edges because delegation also requires the Token Creator role's implicit-delegation capability.

**Attached service account and metadata server.** Code running on a supported Google Cloud resource with an attached service account can [request an ID Token for that attached service account from the resource's metadata server](https://cloud.google.com/docs/authentication/get-id-token#metadata-server), setting the metadata identity endpoint's `audience` query parameter to `cyspbot`. This path does not call `generateIdToken` as the workload, so the direct-caller `iam.serviceAccounts.getOpenIdToken` grant above is not a prerequisite for the workload's metadata-server request. At provisioning time, the identity that attaches the service account needs the permissions required to create or update that kind of resource plus `iam.serviceAccounts.actAs` on the service account; the Service Account User role (`roles/iam.serviceAccountUser`) provides `actAs`. Those provisioning permissions are separate from the workload's runtime metadata request. Prefer this path when the workload already runs as the intended service account.

The Google adapter accepts only ID Tokens whose Authorized Party (`azp`) exactly equals their non-empty Subject (`sub`). For Google's service account ID Token profile, both claims contain the service account unique ID. This binding rejects Google user ID Tokens, whose Authorized Party is an OAuth client ID, while the configured Issuer Identifier rejects self-signed service account JWTs. Google callers must explicitly supply `resource`; it is not inferred from Google claims. Authentication does not create a grant: Token Policy must exactly match the unique ID, repository resource, and permissions.

A policy rule may additionally require the service account email, but the unique ID remains the primary authorization key. IAM Credentials API callers using an email-selecting rule must set `includeEmail` to `true`; Google then includes both `email` and `email_verified`, and the rule requires the signed `email_verified` claim to be `true`.

### `POST /github/webhooks`

Accepts signed JSON GitHub App webhook deliveries up to `256 KiB`. Webhook target headers must identify the configured GitHub App. Raw webhook bodies are not retained.

Signed `ping` deliveries return `202 {"accepted":true,"event":"ping"}`. Any other valid signed JSON event returns `202 {"accepted":true}` with no event-specific parsing or downstream work.

## Token Policy

Installation Token Issuance is allowed only when a normalized token request matches an explicit checked-in Token Policy rule. Rules bind the verified subject-token issuer, exact resource and permissions, and a CEL condition over signed `claims`, `subject`, and normalized `request` data.

### Fly.io

cyspbot supports Fly allow-rule semantics, but the current checked-in Token Policy contains no Fly allow rule. When a Fly allow rule is checked in, Installation Token Issuance requires:

- the **Verified Subject Token** is derived from a Fly OIDC token issued by an organization-specific configured issuer
- the provider-assigned organization and Fly App IDs match that rule
- the organization slug agrees with the Issuer Identifier and the signed `org_name` claim
- the signed Subject (`sub`) agrees with the signed organization, Fly App, and Machine names
- when configured by the rule, the stable Machine ID matches exactly
- the normalized token request `resource` and `permissions` exactly match that rule

Fly policy can use provider-assigned organization and Fly App IDs as authorization keys and may additionally restrict issuance to one stable Machine ID. Claims that a rule does not select, including Machine configuration version, do not affect authorization.

### GitHub Actions

- the **Verified Subject Token** is derived from an ID Token issued by the configured GitHub Actions issuer
- the signed subject token audience is `cyspbot`, and any `azp` claim is accepted only if it also matches `cyspbot`
- `event_name` matches the checked-in rule
- the signed Subject (`sub`) claim uses a `ref` context
- `ref` and the parsed subject ref exactly match the checked-in rule
- the parsed subject repository name matches the signed `repository` claim, and immutable subject IDs are checked when GitHub includes them in `sub`
- `workflow_ref` exactly matches the checked-in rule
- `ref_type` is `branch`
- the normalized token request `resource` and `permissions` exactly match the checked-in rule

Repository identity in policy is intentionally based on GitHub owner/repository names rather than repository IDs. GitHub Actions OIDC tokens may carry repository IDs as separate signed claims, and immutable subject formats may repeat those IDs inside `sub`; the CEL condition requires the immutable `sub` IDs to agree with the corresponding signed claims, but policy matching itself remains name-based. A repository that is deleted and recreated with the same owner/name can match existing policy for that name, and token issuance still depends on the GitHub App being installed with sufficient permissions.

cyspbot denies forked pull request contexts, unconfigured refs, unconfigured workflow files, tag refs, and unsupported event names.

### Google service account ID Tokens

- the **Verified Subject Token** is derived from a service account ID Token issued by the Google Cloud IAM authorization server with Issuer Identifier `https://accounts.google.com`
- the signed Authorized Party (`azp`) equals the non-empty Subject (`sub`)
- the unique ID matches the checked-in rule
- when configured by the rule, the signed service account email matches and `email_verified` is `true`
- the normalized token request `resource` and `permissions` exactly match the checked-in rule

Google policy treats the service account unique ID as an opaque string and compares it exactly. Email is an optional additional constraint, not the primary identity key.

### Enforcement

The caller cannot supply arbitrary GitHub Apps, GitHub permissions, or repository ids. The validated `scope` and validated `resource` are normalized into one installation token request, then policy answers whether the verified subject token may receive exactly that token. Cross-owner requests are possible only when explicitly allowed by policy. Unlisted repositories do not receive a default token.

The exact policy entries are intentionally not documented here. They are service-owned authorization data and may move from checked-in code to live configuration. The durable contract is deny-by-default: unconfigured verified subject-token identities, resources, and permission combinations do not receive tokens.

cyspbot denies unsupported scopes and non-canonical resource forms.

## GitHub App Configuration

The GitHub App registration is the upper-bound authorization control plane for repository permissions. cyspbot narrows issued tokens to one checked-in repository resource, allowed workflow context, and checked-in permission request.

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

The public Wrangler configs declare required secret names. Secret values live in Cloudflare for production and `.dev.vars` for local development.

The token-exchange Worker uses the service-owned GitHub App from `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`.

## GitHub Actions Usage

Workflows that call cyspbot directly need permission to request a GitHub Actions OIDC token:

```yaml
permissions:
  id-token: write
```

That permission is necessary but not sufficient. cyspbot also requires the Verified Subject Token and normalized token request to match Token Policy exactly, including the configured repository, event, branch ref, `workflow_ref`, GitHub App, `resource`, and permission scope.

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

- `ci`: runs on pull requests and pushes to `main`; coordinates reusable jobs for formatting, linting, generated Worker bindings, type checking, Knip, tests, and Worker dry-runs.
- `run-cyspbot-deploy-update`: runs on `workflow_dispatch`, or on `workflow_run` after the `ci` workflow completes successfully on `main`; it starts the external deployment repository's update workflow.

Production deployment workflows and secrets live outside this codebase.
