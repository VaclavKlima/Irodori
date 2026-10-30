export function testUiMode(env = process.env) {
  const mode = env.IRODORI_TEST_UI_MODE ?? 'background'
  if (mode !== 'background' && mode !== 'foreground')
    throw new Error('IRODORI_TEST_UI_MODE must be background or foreground.')
  return mode
}
