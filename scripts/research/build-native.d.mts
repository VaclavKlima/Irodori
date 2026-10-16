export function buildNative(
  component: string,
  directory?: string,
): { binary: string; manifest: Record<string, unknown> }
