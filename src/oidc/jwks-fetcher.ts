import { jwksDocumentSchema, type NormalizedJwk, type ParsedJwk } from "./jwks-schema.ts";
import type { IssuerRegistration } from "./principals.ts";

export interface Clock {
  now(): number;
}

export interface JwksSnapshot {
  fetchedAtMs: number;
  freshUntilMs: number;
  keys: NormalizedJwk[];
  staleUntilMs: number;
}

export type JwksFetchFailureKind = "invalid-jwks" | "transport";

export interface JwksFetchFailure {
  kind: JwksFetchFailureKind;
  message: string;
  ok: false;
}

export interface JwksFetchSuccess {
  ok: true;
  snapshot: JwksSnapshot;
}

export type JwksFetchResult = JwksFetchFailure | JwksFetchSuccess;

export async function fetchJwksSnapshot(
  registration: IssuerRegistration,
  clock: Clock,
  fetchImpl: typeof fetch,
): Promise<JwksFetchResult> {
  let response: Response;

  try {
    response = await fetchImpl(registration.jwksUri, {
      headers: {
        accept: "application/json, application/jwk-set+json",
      },
      method: "GET",
    });
  } catch (error) {
    return {
      kind: "transport",
      message: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }

  if (!response.ok) {
    return {
      kind: "transport",
      message: `unexpected JWKS response status ${response.status}`,
      ok: false,
    };
  }

  let document: unknown;

  try {
    document = await response.json();
  } catch (error) {
    return {
      kind: "invalid-jwks",
      message: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }

  try {
    const normalizedKeys = normalizeJwksDocument(document, registration.allowedAlgorithms);
    const fetchedAtMs = clock.now();
    const freshForMs = boundedFreshLifetimeMs(response.headers, registration);

    return {
      ok: true,
      snapshot: {
        fetchedAtMs,
        freshUntilMs: fetchedAtMs + freshForMs,
        keys: normalizedKeys,
        staleUntilMs: fetchedAtMs + freshForMs + registration.staleWhileErrorMs,
      },
    };
  } catch (error) {
    return {
      kind: "invalid-jwks",
      message: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
}

function boundedFreshLifetimeMs(headers: Headers, registration: IssuerRegistration): number {
  const cacheControl = headers.get("cache-control");
  const maxAge = parseCacheControlMaxAge(cacheControl);
  const candidateMs =
    maxAge === null
      ? registration.defaultFreshMs
      : Math.max(maxAge * 1000, registration.minFreshMs);

  return Math.min(candidateMs, registration.maxFreshMs);
}

function parseCacheControlMaxAge(cacheControl: string | null): number | null {
  if (cacheControl === null) {
    return null;
  }

  for (const directive of cacheControl.split(",")) {
    const [name, value] = directive.trim().split("=", 2);

    if (name !== "max-age" || value === undefined) {
      continue;
    }

    const parsed = Number.parseInt(value, 10);

    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return null;
}

function normalizeJwksDocument(
  document: unknown,
  allowedAlgorithms: readonly string[],
): NormalizedJwk[] {
  const parsed = jwksDocumentSchema.parse(document);
  const normalizedKeys = parsed.keys.map((key) => normalizeJwk(key, allowedAlgorithms));

  if (normalizedKeys.length === 0) {
    throw new Error("JWKS document contains no usable keys");
  }

  return normalizedKeys;
}

function normalizeJwk(key: ParsedJwk, allowedAlgorithms: readonly string[]): NormalizedJwk {
  validateJwkUsage(key);

  if (key.alg !== undefined && !allowedAlgorithms.includes(key.alg)) {
    throw new Error(`JWK algorithm ${key.alg} is not allowed`);
  }

  switch (key.kty) {
    case "RSA":
      if (key.n === undefined || key.e === undefined) {
        throw new Error("RSA JWK must include n and e");
      }

      return { alg: key.alg, e: key.e, kid: key.kid ?? null, kty: "RSA", n: key.n };
    case "EC":
      if (key.crv === undefined || key.x === undefined || key.y === undefined) {
        throw new Error("EC JWK must include crv, x, and y");
      }

      return { alg: key.alg, crv: key.crv, kid: key.kid ?? null, kty: "EC", x: key.x, y: key.y };
    case "OKP":
      if (key.crv === undefined || key.x === undefined) {
        throw new Error("OKP JWK must include crv and x");
      }

      return { alg: key.alg, crv: key.crv, kid: key.kid ?? null, kty: "OKP", x: key.x };
    default:
      throw new Error(`unsupported JWK key type ${String(key.kty)}`);
  }
}

function validateJwkUsage(key: ParsedJwk): void {
  if (key.use !== undefined && key.use !== "sig") {
    throw new Error("JWK use must be sig when present");
  }

  if (Array.isArray(key.key_ops) && !key.key_ops.includes("verify")) {
    throw new Error("JWK key_ops must include verify when present");
  }
}
