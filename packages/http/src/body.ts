export type BoundedBodyRead =
  | {
      bytes: Uint8Array;
      ok: true;
    }
  | {
      ok: false;
    };

export async function readBodyUpTo(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedBodyRead> {
  if (body === null) {
    return { bytes: new Uint8Array(), ok: true };
  }

  const reader = body.getReader();
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      signal?.throwIfAborted();
      const read = await reader.read();
      signal?.throwIfAborted();

      if (read.done) {
        break;
      }

      totalBytes += read.value.byteLength;

      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return { ok: false };
      }

      chunks.push(read.value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes, ok: true };
}
