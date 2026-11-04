/** Open only an exact Codex-emitted authentication hyperlink, never reconstructed screen text. */
export function agentSignInUrl(value: unknown, output: string): string {
  if (typeof value !== 'string' || value.length > 16384)
    throw new Error('Invalid Codex sign-in link.')
  // eslint-disable-next-line no-control-regex -- OSC 8 uses ESC/BEL delimiters, not visible text.
  const emitted = [...output.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)].some(
    (match) => match[1] === value,
  )
  const url = new URL(value)
  if (
    !emitted ||
    url.origin !== 'https://auth.openai.com' ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('Only the current Codex sign-in link can open from this console.')
  const keys = [...url.searchParams.keys()]
  if (new Set(keys).size !== keys.length)
    throw new Error('The Codex sign-in link has duplicate parameters.')
  if (url.pathname === '/codex/device' && !url.search) return value
  if (
    url.pathname !== '/oauth/authorize' ||
    !['client_id', 'state', 'code_challenge', 'redirect_uri'].every((key) =>
      url.searchParams.get(key),
    )
  )
    throw new Error('Unsupported Codex sign-in link.')
  const callback = new URL(url.searchParams.get('redirect_uri')!)
  if (
    callback.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname) ||
    callback.pathname !== '/auth/callback' ||
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.search
  )
    throw new Error('The Codex sign-in callback must belong to the local CLI.')
  return value
}

export function latestAgentSignInUrl(output: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- Read exact OSC 8 protocol targets.
  const matches = [...output.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)]
  for (const match of matches.reverse()) {
    try {
      return agentSignInUrl(match[1], output)
    } catch {
      /* Other terminal links stay unavailable. */
    }
  }
  return undefined
}
