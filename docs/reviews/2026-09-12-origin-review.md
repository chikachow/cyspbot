# Adversarial implementation review — 12 September 2026

The reviewed origin revision is `a162fb909d45b8bcdb54f1939f2230f0419423c1`.
The review covered all three Workers, shared packages, unit and integration tests,
CI workflows, dependency configuration, and the service/deployment contracts.
Three collaborators independently examined ingress, processing/token exchange,
and tooling; the implementation was then checked against the combined findings.
The original checkout and its untracked research files were preserved in place.

The main problem was failure handling: a green baseline did not prove that a
reaction had been created, that an unreadable error was permanent, or that a
validated job could form its promised URL. The existing package and Worker
interfaces are small and useful. Broad restructuring would add churn without
resolving these defects.

## Implemented findings

### P2: Redirects could acknowledge a reaction that never happened

At origin, `workers/cyspbot-github-webhook-processor/src/github/reactions.ts`
used default Fetch redirect handling and accepted any final `200` or `201`.
A Workerd reproduction showed a `301` transforming the reaction POST into a
GET with no body; a `200` reaction-list response then looked like successful
creation. This matters when a repository URL redirects after a rename or move.

The processor now repeats the original POST for `301`, `302`, `307`, and `308`,
up to three redirects, only within `https://api.github.com` and without URL
credentials. It retains the same token and body. Intermediate body cancellation
does not delay the request. Unsafe, unsupported, or exhausted redirects follow
the existing permanent-failure path. A real Worker integration fixture requires
the redirected request to retain the exact method, credentials, and body.

This follows GitHub's instruction to [repeat redirected requests](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#follow-redirects),
accounts for [Fetch's POST-to-GET behavior](https://fetch.spec.whatwg.org/#http-redirect-fetch),
and avoids Cloudflare's [cross-host forwarding of authorization headers](https://developers.cloudflare.com/workers/runtime-apis/request/#properties).

### P2: Incomplete `403` diagnostics could discard retryable jobs

The processor used error-body text to recognize secondary rate limits. It retried
a timed-out `403` read, but acknowledged an errored or oversized read even though
both also prevented classification. Existing tests explicitly expected that loss.

Stream exceptions and the 16 KiB cutoff now produce `bodyReadFailed: true` and
retry `403` responses. Header diagnostics and retry hints survive. Fully received
empty or malformed bodies keep the status/header policy; other statuses keep
their existing behavior. The one-second diagnostic deadline and best-effort
cancellation remain intact. This policy applies GitHub's [rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately)
without treating a failed diagnostic read as proof of permanent denial.

### P2: The broker client rejected valid OAuth response variants

`packages/token-exchange/src/index.ts` required exactly `Bearer` and an explicit
response `scope`. OAuth token types are case-insensitive, and an unchanged scope
may be omitted. Valid responses therefore threw and caused unnecessary retries.

The client accepts case variations of `Bearer` and uses the validated requested
scope only when response scope is absent. Explicit scope values remain authoritative;
null, empty, and non-string scopes remain invalid. The installation-token profile
still requires its existing expiration and issued-token-type fields. Literal
response regressions failed four times before the fix and pass afterward.
See [RFC 8693 §2.2.1](https://www.rfc-editor.org/rfc/rfc8693.html#section-2.2.1)
and [RFC 6749 §5.1](https://www.rfc-editor.org/rfc/rfc6749.html#section-5.1).

### P2: Accepted jobs could fail or change meaning during URL construction

`packages/github-webhook-jobs/src/index.ts` accepted `.` and `..` repository parts,
which URL parsing normalizes, and lone surrogates, which `encodeURIComponent`
rejects. Signed deliveries could publish jobs that did not preserve the intended
repository resource or failed before reaching the broker.

The shared parser now rejects these values before publication and consumption.
Tests preserve ordinary dotted names, percent literals, and well-formed Unicode.
This is a canonical-resource correctness fix, not a demonstrated authentication
bypass: queue writers and signed webhook bodies remain within the documented trust
model. See the [URL dot-segment rules](https://url.spec.whatwg.org/#single-dot-url-path-segment)
and [ECMAScript URI encoding](https://tc39.es/ecma262/multipage/global-object.html#sec-encodeuricomponent-uricomponent).

### P3: Invalid UTF-8 was silently repaired before JSON parsing

The receiver authenticated exact bytes but decoded them with replacement before
parsing JSON. Signed malformed UTF-8 could therefore receive `202` despite the
valid-JSON contract. Fatal UTF-8 decoding now shares the authenticated JSON error
path and returns `400`. Bad signatures still return `401` before decoding.
Tests cover invalid bytes, overlong/truncated encodings, and valid non-ASCII text.
See [RFC 8259 §8.1](https://www.rfc-editor.org/rfc/rfc8259.html#section-8.1)
and [TextDecoder error handling](https://encoding.spec.whatwg.org/#interface-textdecoder).

### P3: Secret retrieval failures escaped the receiver's response contract

A rejecting Secrets Store `get()` escaped the receiver handler instead of producing
its documented configuration error. The receiver now returns `500` problem details
with a fixed diagnostic event, excluding the exception's text, and publishes no
job. The regression includes a secret-like failure message and checks the exact safe
log. The asynchronous binding is described in [Cloudflare's Secrets Store integration](https://developers.cloudflare.com/secrets-store/integrations/workers/#3-access-the-secret-on-the-env-object).

### P3: Expired dependency exceptions and contradictory README text

Ten version-specific cooldown exceptions had expired on 10 September. An isolated
archive without them passed `pnpm up -r --lockfile-only --ignore-scripts`,
`pnpm dedupe --lockfile-only --ignore-scripts`, and
`pnpm install --lockfile-only --frozen-lockfile --ignore-scripts`. These were
lockfile-only probes. The exceptions
were removed; dependency versions and the source lockfile were preserved.
See [pnpm's release-age exclusions](https://pnpm.io/10.x/settings#minimumreleaseageexclude).

The README incorrectly said that all non-ping events created no job. It now states
that newly created status comments create jobs. The service and implementation
documents describe each changed behavior.

## Simplification decisions

- Exact job-key validation now checks the enumerable key set directly, removing
  two sorts and a copied array. It retains the rejection of unexpected fields,
  including the adversarial non-enumerable-property case.
- The redirect policy stays private to reaction creation. A generic HTTP client,
  configurable retry framework, or extra dependency interface would increase the
  public surface for one operation.
- The HTTP, job-contract, and token-exchange packages retain their existing
  interfaces. Flattening them would spread shared validation or broker knowledge
  across Workers and tests.
- The queue and GitHub's existing-reaction success semantics already address
  repeated delivery. An additional deduplication database is not justified by
  the current operation.
- Repository/author authorization, the permission pair, separate deployment
  ownership, and separate CI workflows are explicit project choices. No evidence
  justified silently replacing them during this review.

## Remaining concerns and verification limits

The source deployment-dispatch workflow does not pass the successful source SHA;
the deployment updater follows the latest source branch. A successful revision A
can therefore trigger a proposal containing newer revision B. At deployment commit
`ebfec79b6abff60591578c8eea2a74349f56fefc`, the
[updater follows the remote submodule branch](https://github.com/chikachow/cyspbot-deploy/blob/ebfec79b6abff60591578c8eea2a74349f56fefc/.github/workflows/update-cyspbot/update-submodule.sh#L6),
and [downstream CI separately checks proposed source](https://github.com/chikachow/cyspbot-deploy/blob/ebfec79b6abff60591578c8eea2a74349f56fefc/.github/workflows/ci-source.yml#L29).
This race is not evidence of an unchecked-deployment bypass; branch-rule enforcement
was not inspected. Exact revision propagation needs a coordinated change in both
repositories; only this project's implementation was changed here.

Issuer RPC, broker response reading, and the initial GitHub fetch have no explicit
application deadline. The existing byte limits do not bound elapsed time. This is
a remaining resilience design question: choose budgets from dependency latency and
queue-processing requirements, then test cancellation and error classification
together. No production latency or outage was measured in this review.

Local fixtures validate the issuer/broker interfaces and actual Worker execution;
they do not validate production broker policy, live GitHub App permissions,
production routes, queue provisioning, or Secrets Store permissions. No production
deployment or live GitHub mutation was performed.

## Validation and final review

Baseline: `node --run check` passed all gates and 153 tests at the pinned origin.
New regressions were first demonstrated against the original implementation.
The implementation is committed as `6c74ede3c762fd21e7d5f1ab4a5fb49b041fafa8`.

- Node 24 and pinned pnpm 10.34.5: frozen install and complete `node --run check`
  pass, including formatting, environment/runtime types, lint, production/test
  TypeScript, Knip, all 195 tests in 15 files, and all three Wrangler deploy dry runs.
- `node --run test:coverage` passes on the committed implementation: 99.69%
  statements, 98.51% branches, 98.18% functions, and 100% lines. The built-Worker
  integration suite remains outside coverage instrumentation.
- `git diff --check` passes. A final origin refresh still resolves to the reviewed
  base. The dependency lockfile has no changes.

### Standards

Independent review of the committed diff found zero mandatory violations and zero
actionable heuristic findings. Service and implementation documentation meet the
contribution rules; terminology, trust ownership, package interfaces, and test
placement are preserved. The redirect helper and shared parser keep their policies
local. Independent test literals provide useful expectations without a new fixture
abstraction.

### Spec

An independent reviewer with no implementation role found zero missing, incorrect,
or out-of-scope requirements in the committed diff. Redirect behavior, incomplete
diagnostics, OAuth response handling, job validation, authenticated decoding, and
safe secret errors match the agreed contracts. The reviewer examined source, tests,
and primary documentation, but did not independently rerun the suite or inspect
production services. Report substantiation concerns were resolved by adding pinned
deployment references, qualifying enforcement claims, and recording the execution
evidence below.

Standards: 0 findings. Spec: 0 findings. Neither axis has an outstanding source issue.

### Execution evidence

These results were observed during implementation before applying the corresponding
source fixes. Additional preservation cases explain why the final test count grows
by more than the number of initial failures.

| Regression run                              | Result before its fix | Result after its fix                                   |
| ------------------------------------------- | --------------------- | ------------------------------------------------------ |
| Token-exchange package tests                | 4 failed, 21 passed   | 25 passed                                              |
| Job parser and webhook acceptance tests     | 12 failed, 27 passed  | Ingress verification passed 80 tests across five files |
| Processor unit and Worker integration tests | 15 failed, 38 passed  | 53 passed                                              |

The processor regression command was:

```sh
fnm exec --using=24 pnpm exec vitest run --project unit workers/cyspbot-github-webhook-processor/test/worker.test.ts --project github-webhook-processor-integration workers/cyspbot-github-webhook-processor/test/integration/worker.test.ts
```

A separate Miniflare experiment with compatibility date `2026-07-24` recorded a
POST of `{"content":"eyes"}` to the old comment URL, a `301`, a GET with an empty
body to the new comment URL, and final response `{"status":200,"body":"[]"}`.
It used a fixed fake token and local outbound handler. The committed integration
regression now verifies the actual redirected POST and queue acknowledgement.

The cooldown probes ran in a fresh archive of the pinned origin after removing
only the exclusions. Under Node 24/pnpm 10.34.5, update, dedupe, and frozen lockfile
validation each exited 0. The probe's transitive updates stayed in the disposable
archive; the committed source lockfile is identical to origin.
