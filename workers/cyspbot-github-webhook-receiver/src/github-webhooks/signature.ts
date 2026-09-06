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
    ["verify"],
  );
  const hex = input.signatureHeader.slice("sha256=".length);
  const signature = new Uint8Array(32);
  for (let index = 0; index < signature.length; index += 1) {
    signature[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }

  return crypto.subtle.verify("HMAC", key, signature, new Uint8Array(input.body));
}
