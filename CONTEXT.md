# cyspbot domain language

cyspbot is a bot with a minimal root page, a GitHub App webhook receiver, a GitHub webhook processor, and an internal OAuth Token Exchange Client. Use these terms consistently in source, tests, logs, and documentation.

**Root Page**:
The minimal HTML response that identifies cyspbot as a bot at `GET /`. `HEAD /` has the same status and headers without a body. Other root methods receive an empty `405`; other paths receive empty `404` responses, except where a more specific production Worker route takes precedence.

**GitHub App**:
The GitHub integration whose numeric ID must match each webhook delivery target.

**Webhook Delivery**:
One HTTP request sent by GitHub with an event name, delivery ID, target App identity, signature, and JSON body.

**Webhook Receiver**:
The cyspbot Worker that authenticates a Webhook Delivery, classifies status commands, and queues derived jobs.

**Webhook Job**:
A versioned message containing the minimum data required for one asynchronous GitHub operation.

**Webhook Processor**:
The cyspbot Worker that consumes Webhook Jobs and performs the corresponding GitHub operation.

**Status Reaction Job**:
The `github.issue-comment.status-reaction` version-1 Webhook Job containing a delivery ID, repository owner and name, and comment ID.

**Webhook Secret**:
The shared secret used to authenticate the exact request body through GitHub's `X-Hub-Signature-256` convention. It is supplied only through a Worker secret or Cloudflare Secrets Store binding.

**Accepted Delivery**:
A delivery whose media type, size, required headers, target App ID, signature, and JSON representation are valid. For a Status Reaction Job, acceptance includes a successful durable queue write.

**Rejected Delivery**:
A delivery that fails one of the receiver's validation requirements. Logs may retain delivery metadata needed for diagnosis but must not retain the raw body or secret.

**Workload Identity Token**:

A short-lived credential returned by the Cloudflare Workload Identity issuer's RPC `issueToken(audience)` operation. It is a workload identity assertion when presented to a security token service, and it is not an OAuth access token. In the broker integration it is sent as the RFC 8693 `subject_token` with `subject_token_type=urn:ietf:params:oauth:token-type:id_token`, selecting the broker's OIDC ID Token subject-token profile.

**Token Exchange Client**:

The internal cyspbot client that obtains a Workload Identity Token and sends it to the broker's Token Endpoint. The broker is the OAuth Authorization Server; the client is not authenticated by the broker, and the token's Subject is verified independently from the client's transport binding.

**Subject-Token Audience**:

The exact audience requested from the Workload Identity issuer and accepted by the broker's OIDC ID Token subject-token profile. The value is deployment-owned and is not the broker Token Endpoint URL.

**GitHub App Installation Access Token**:

A short-lived GitHub App token returned by the broker's Token Endpoint for one canonical GitHub Repository Resource and the explicitly requested permissions.
