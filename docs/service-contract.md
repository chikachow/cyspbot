# Service contract

This document is authoritative for the observable behavior implemented by cyspbot.

## Routes

| Route              | Method | Purpose                                                   | Success    |
| ------------------ | ------ | --------------------------------------------------------- | ---------- |
| `/`                | `GET`  | Identify cyspbot as a bot                                 | `200` HTML |
| `/github/webhooks` | `POST` | Authenticate, classify, and queue GitHub App webhook jobs | `202` JSON |

`HEAD /` returns the same status and headers as `GET /` without a response body. Other methods at `/` return an empty `405` response with `Allow: GET, HEAD`. The root Worker returns an empty `404` response for every other path, regardless of method. More specific production Worker routes run before the root Worker and own the response within their route patterns. Unsupported methods on `/github/webhooks` return `405` problem details with `Allow: POST`.

## Root page

The `/` response has media type `text/html; charset=utf-8` and is equivalent to the minimal document:

```html
<!doctype html><title>cyspbot</title>
<p>beep, boop. i am a bot.</p>
```

## Webhook request requirements

The receiver requires:

- a primary media type of `application/json` (parameters are allowed);
- a body no larger than `256 KiB`;
- `X-GitHub-Event`;
- `X-GitHub-Delivery`;
- `X-Hub-Signature-256` in GitHub's lowercase `sha256=<64 lowercase hex characters>` form;
- `X-GitHub-Hook-Installation-Target-Type: integration`;
- `X-GitHub-Hook-Installation-Target-ID` equal to `GITHUB_APP_ID`; and
- a syntactically valid JSON body.

The signature is verified over the exact request bytes using `GITHUB_WEBHOOK_SECRET`. The body is parsed only after its target and signature authenticate.

## Webhook responses

Accepted ping deliveries return:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{"accepted":true,"event":"ping"}
```

Other accepted events return:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{"accepted":true}
```

An authenticated `issue_comment` delivery creates a queue job only when its
`action` is `created` and the trimmed comment body is exactly
`/cyspbot status`. The job contains:

```json
{
  "kind": "github.issue-comment.status-reaction",
  "version": 1,
  "deliveryId": "delivery-123",
  "repository": {
    "owner": "chikachow",
    "name": "cyspbot"
  },
  "commentId": 42
}
```

The receiver waits for the queue write before returning `202`. Authenticated
events that do not classify to this job receive `202` without a queue write.
The receiver does not apply repository filtering. A queue write failure
returns `503 Service Unavailable` so GitHub can retry the delivery.

The processor requests a GitHub App Installation Access Token with
`issues:write` for the canonical GitHub Repository Resource and posts the
`eyes` reaction to the comment. GitHub `200` and `201` responses complete the
job. Network failures, `429`, `5xx`, and rate-limited `403` responses retry;
other failures are acknowledged. The queue uses one-message batches, five
retries, a 60-second retry delay, and the
`cyspbot-github-webhook-jobs-dlq` dead-letter queue.

Rejections use RFC 9457-style problem-details JSON with `type`, `title`, and `status` fields:

| Condition                                     | Status |
| --------------------------------------------- | -----: |
| Missing or empty webhook secret configuration |  `500` |
| Non-JSON media type                           |  `415` |
| Body exceeds `256 KiB`                        |  `413` |
| Missing event, delivery, or signature header  |  `400` |
| Target type or target App ID mismatch         |  `401` |
| Malformed or invalid signature                |  `401` |
| Authenticated body is not valid JSON          |  `400` |
| A matching job cannot be written to the queue |  `503` |

Repeated delivery IDs are accepted. Queue delivery is at least once, and the
processor treats both successful GitHub reaction response statuses as
completion, so repeated jobs do not require a separate deduplication store.

## Logging and retention

Rejected deliveries may log the delivery ID, event, Cloudflare Ray ID, and response status. Raw request bodies, signature values, and webhook secrets are not logged or retained.
