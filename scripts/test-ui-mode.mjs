export function testUiMode(env = process.env) {
  const mode = env.LUMA_TEST_UI_MODE ?? 'background'
  if (mode !== 'background' && mode !== 'foreground')
    throw new Error('LUMA_TEST_UI_MODE must be background or foreground.')
  return mode
}
