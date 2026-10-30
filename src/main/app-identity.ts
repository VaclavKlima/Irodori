import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { App } from 'electron'
import { APP_NAME } from '../shared/app-identity'

type IdentityApp = Pick<App, 'getPath' | 'setPath' | 'setName'> & {
  commandLine: Pick<App['commandLine'], 'hasSwitch'>
}

export function configureAppIdentity(app: IdentityApp): void {
  // Explicit isolated profiles take priority over the normal product profile.
  const profile = app.commandLine.hasSwitch('user-data-dir')
    ? app.getPath('userData')
    : join(app.getPath('appData'), APP_NAME)
  mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  app.setName(APP_NAME)
}
