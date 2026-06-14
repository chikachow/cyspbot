const githubWebhookSignaturePattern = /^sha256=[a-f0-9]{64}$/u;
const textEncoder = new TextEncoder();

export async function verifyGitHubWebhookSignature(input: {
  body: Uint8Array;
  secret: string;
  signatureHeader: string;
}): Promise<boolean> {
  if (!githubWebhookSignaturePattern.test(input.signatureHeader)) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(input.secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, bytesAsBufferSource(input.body)),
  );
  const actualHex = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  const expectedHex = input.signatureHeader.slice("sha256=".length);

  return constantTimeEquals(actualHex, expectedHex);
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;

  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}

function bytesAsBufferSource(value: Uint8Array): BufferSource {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);

  return copy;
}
