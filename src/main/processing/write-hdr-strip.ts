export interface HdrStripWriter {
  write(
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>
}

/** The caller lends one bounded, at most 64-row strip until every write has settled. */
export async function writeHdrStrip(
  file: HdrStripWriter,
  bytes: Uint8Array,
  position: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  let offset = 0
  while (offset < bytes.byteLength) {
    signal?.throwIfAborted()
    const remaining = bytes.byteLength - offset,
      { bytesWritten } = await file.write(bytes, offset, remaining, position + offset)
    // An issued write must finish before cancellation releases the borrowed strip.
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining)
      throw new Error('Cannot write HDR strip.')
    offset += bytesWritten
  }
}
