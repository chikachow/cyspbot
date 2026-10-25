import { readBodyUpTo } from "./body.ts";

export type BoundedRequestBodyRead =
  | {
      bytes: Uint8Array;
      ok: true;
    }
  | {
      ok: false;
      status: 400 | 413;
    };

export async function readRequestBodyUpTo(
  request: Request,
  maxBytes: number,
): Promise<BoundedRequestBodyRead> {
  const contentLength = request.headers.get("content-length");

  if (contentLength !== null) {
    const parsedContentLength = parseContentLength(contentLength);

    if (parsedContentLength === null) {
      return { ok: false, status: 400 };
    }

    if (parsedContentLength > BigInt(maxBytes)) {
      return { ok: false, status: 413 };
    }
  }

  try {
    const result = await readBodyUpTo(request.body, maxBytes);
    return result.ok ? result : { ok: false, status: 413 };
  } catch {
    return { ok: false, status: 400 };
  }
}

function parseContentLength(value: string): bigint | null {
  if (!/^[0-9]+$/u.test(value)) {
    return null;
  }

  return BigInt(value);
}
