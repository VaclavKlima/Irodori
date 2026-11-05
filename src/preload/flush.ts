/** Include synchronous listener failures in the same acknowledgement as rejected saves. */
export function acknowledgeFlush(
  listener: () => Promise<void>,
  reply: (error?: string) => void,
): void {
  void Promise.resolve()
    .then(listener)
    .then(
      () => reply(),
      (error) => reply(String(error)),
    )
}
