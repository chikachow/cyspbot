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

    if (parsedContentLength > maxBytes) {
      return { ok: false, status: 413 };
    }
  }

  if (request.body === null) {
    return { bytes: new Uint8Array(), ok: true };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (;;) {
    const read = await reader.read();

    if (read.done) {
      break;
    }

    totalBytes += read.value.byteLength;

    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413 };
    }

    chunks.push(read.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, ok: true };
}

function parseContentLength(value: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    return null;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) ? parsed : null;
}
