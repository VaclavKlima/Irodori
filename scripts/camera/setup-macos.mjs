if (process.platform !== 'darwin') throw new Error('Use npm run camera:setup on Linux.')
await import('./setup.mjs')
