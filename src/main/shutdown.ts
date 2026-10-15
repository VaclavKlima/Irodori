export async function closeServices(actions: Array<() => Promise<void> | void>): Promise<void> {
  const errors: unknown[] = []
  for (const action of actions) {
    try {
      await action()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Could not close every application service.')
}
