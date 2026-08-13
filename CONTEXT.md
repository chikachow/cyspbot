# cyspbot domain language

cyspbot is a bot with a minimal root page and a GitHub App webhook receiver. Use these terms consistently in source, tests, logs, and documentation.

**Root Page**:
The minimal HTML response that identifies cyspbot as a bot at `GET /`. `HEAD /` has the same status and headers without a body. Other root methods receive an empty `405`; other paths receive empty `404` responses, except where a more specific production Worker route takes precedence.

**GitHub App**:
The GitHub integration whose numeric ID must match each webhook delivery target.

**Webhook Delivery**:
One HTTP request sent by GitHub with an event name, delivery ID, target App identity, signature, and JSON body.

**Webhook Receiver**:
The cyspbot Worker that authenticates and acknowledges a Webhook Delivery.

**Webhook Secret**:
The shared secret used to authenticate the exact request body through GitHub's `X-Hub-Signature-256` convention. It is supplied only through a Worker secret or Cloudflare Secrets Store binding.

**Accepted Delivery**:
A delivery whose media type, size, required headers, target App ID, signature, and JSON representation are valid. Acceptance acknowledges receipt; it does not imply event-specific processing.

**Rejected Delivery**:
A delivery that fails one of the receiver's validation requirements. Logs may retain delivery metadata needed for diagnosis but must not retain the raw body or secret.
