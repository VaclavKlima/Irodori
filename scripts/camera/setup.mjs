import { assertRuntimeHost, installRuntime, runtimePlatform } from './runtime.ts'

const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--archive' || !args[1]))
  throw new Error('Usage: npm run camera:setup [-- --archive <pinned-runtime.tar.gz>]')
assertRuntimeHost(runtimePlatform())
const result = await installRuntime({ archive: args[1] })
console.log(
  `Camera runtime ${result.reused ? 'verified and reused' : 'installed'}: ${result.directory}`,
)
