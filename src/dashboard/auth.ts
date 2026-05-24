import type { Env } from "../env.ts";

const dashboardSessionCookieName = "__Host-cyspbot_dashboard_session";
const dashboardStateCookieName = "__Host-cyspbot_oauth_state";
const oauthStateMaxAgeSeconds = 10 * 60;

export interface DashboardOauthState {
  issuedAt: string;
  returnTo: string;
  state: string;
}

export function clearDashboardSessionCookie(): string {
  return serializeCookie(dashboardSessionCookieName, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "Lax",
    secure: true,
  });
}

export function clearDashboardStateCookie(): string {
  return serializeCookie(dashboardStateCookieName, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "Lax",
    secure: true,
  });
}

export async function createEncryptedValue(env: Env, value: string): Promise<string> {
  const secret = requireDashboardTokenEncryptionSecret(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyVersion = "v1";
  const key = await dashboardAesKey(secret, keyVersion);
  const plaintext = new TextEncoder().encode(value);
  const ciphertext = await crypto.subtle.encrypt({ iv, name: "AES-GCM" }, key, plaintext);

  return `${keyVersion}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function createSignedDashboardOauthStateCookie(
  env: Env,
  returnTo: string,
): Promise<{ cookie: string; state: string }> {
  const payload: DashboardOauthState = {
    issuedAt: new Date().toISOString(),
    returnTo,
    state: randomToken(),
  };

  return {
    cookie: serializeCookie(dashboardStateCookieName, await signPayload(env, payload), {
      httpOnly: true,
      maxAge: oauthStateMaxAgeSeconds,
      path: "/",
      sameSite: "Lax",
      secure: true,
    }),
    state: payload.state,
  };
}

export function createDashboardSessionCookie(
  rawSessionToken: string,
  maxAgeSeconds: number,
): string {
  return serializeCookie(dashboardSessionCookieName, rawSessionToken, {
    httpOnly: true,
    maxAge: maxAgeSeconds,
    path: "/",
    sameSite: "Lax",
    secure: true,
  });
}

export async function decryptValue(env: Env, value: string): Promise<string | null> {
  const secret = requireDashboardTokenEncryptionSecret(env);
  const [keyVersion, ivPart, ciphertextPart] = value.split(".", 3);

  if (keyVersion !== "v1" || ivPart === undefined || ciphertextPart === undefined) {
    return null;
  }

  try {
    const key = await dashboardAesKey(secret, keyVersion);
    const plaintext = await crypto.subtle.decrypt(
      {
        iv: bytesAsBufferSource(base64UrlDecode(ivPart)),
        name: "AES-GCM",
      },
      key,
      bytesAsBufferSource(base64UrlDecode(ciphertextPart)),
    );

    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

export async function readDashboardOauthState(
  request: Request,
  env: Env,
): Promise<DashboardOauthState | null> {
  return readSignedCookie(
    request,
    env,
    dashboardStateCookieName,
  ) as Promise<DashboardOauthState | null>;
}

export function readDashboardSessionToken(request: Request): string | null {
  const cookieValue = parseCookieHeader(request.headers.get("cookie")).get(
    dashboardSessionCookieName,
  );

  return cookieValue === undefined || cookieValue.length === 0 ? null : cookieValue;
}

export function randomToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export async function dashboardSessionTokenHash(
  env: Env,
  rawSessionToken: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    await digestSecret("dashboard-session-lookup", requireDashboardSessionLookupSecret(env)),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawSessionToken));

  return base64UrlEncode(new Uint8Array(digest));
}

async function dashboardAesKey(secret: string, keyVersion: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    await digestSecret(`dashboard-token-encryption:${keyVersion}`, secret),
    { length: 256, name: "AES-GCM" },
    false,
    ["decrypt", "encrypt"],
  );
}

async function dashboardHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    await digestSecret("dashboard-hmac", secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4 || 4)) % 4), "=");
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlEncode(value: Uint8Array): string {
  const binary = Array.from(value, (byte) => String.fromCharCode(byte)).join("");

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function digestSecret(prefix: string, secret: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${prefix}:${secret}`));
}

function parseCookieHeader(cookieHeader: string | null): Map<string, string> {
  const cookies = new Map<string, string>();

  if (cookieHeader === null || cookieHeader.length === 0) {
    return cookies;
  }

  for (const part of cookieHeader.split(/;\s*/u)) {
    const [name, ...rest] = part.split("=");

    if (name === undefined || rest.length === 0) {
      continue;
    }

    cookies.set(name, rest.join("="));
  }

  return cookies;
}

async function readSignedCookie(request: Request, env: Env, name: string): Promise<unknown> {
  const cookieValue = parseCookieHeader(request.headers.get("cookie")).get(name);

  if (cookieValue === undefined || cookieValue.length === 0) {
    return null;
  }

  const [payloadPart, signaturePart] = cookieValue.split(".", 2);

  if (payloadPart === undefined || signaturePart === undefined) {
    return null;
  }

  try {
    const key = await dashboardHmacKey(requireDashboardSessionLookupSecret(env));
    const signatureValid = await crypto.subtle.verify(
      "HMAC",
      key,
      bytesAsBufferSource(base64UrlDecode(signaturePart)),
      new TextEncoder().encode(payloadPart),
    );

    if (!signatureValid) {
      return null;
    }

    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadPart));

    return JSON.parse(payloadJson) as unknown;
  } catch {
    return null;
  }
}

function requireDashboardSessionLookupSecret(env: Env): string {
  const secret = env.DASHBOARD_SESSION_LOOKUP_SECRET;

  if (secret === undefined || secret.length === 0) {
    throw new Error("missing dashboard session lookup secret");
  }

  return secret;
}

function requireDashboardTokenEncryptionSecret(env: Env): string {
  const secret = env.DASHBOARD_TOKEN_ENCRYPTION_SECRET;

  if (secret === undefined || secret.length === 0) {
    throw new Error("missing dashboard token encryption secret");
  }

  return secret;
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly: boolean;
    maxAge?: number;
    path: string;
    sameSite: "Lax";
    secure: boolean;
  },
): string {
  const parts = [`${name}=${value}`, `Path=${options.path}`, `SameSite=${options.sameSite}`];

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.secure) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

async function signPayload(env: Env, payload: unknown): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadPart = base64UrlEncode(new TextEncoder().encode(payloadJson));
  const key = await dashboardHmacKey(requireDashboardSessionLookupSecret(env));
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadPart));

  return `${payloadPart}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function bytesAsBufferSource(value: Uint8Array): BufferSource {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);

  return copy;
}
