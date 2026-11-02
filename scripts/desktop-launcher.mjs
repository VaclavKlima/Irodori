import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, writeFile, cp } from 'node:fs/promises'
import { DESKTOP_FILE, DESKTOP_ID } from '../src/shared/desktop-identity.ts'

const escapeString = (value) => value.replaceAll('\\', '\\\\')
const quote = (value) =>
  escapeString('"' + value.replace(/[\\"`$]/g, '\\$&').replaceAll('%', '%%') + '"')
export function desktopEntry(executable, icon) {
  if (
    ![executable, icon].every(
      (p) => isAbsolute(p) && [...p].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
    )
  )
    throw new Error('Desktop paths must be absolute and contain no control characters.')
  if (executable.includes('='))
    throw new Error('Desktop executable paths cannot contain an equal sign.')
  return `[Desktop Entry]\nType=Application\nVersion=1.0\nName=Irodori\nComment=Personal photo editing\nExec=${quote(executable)}\nIcon=${escapeString(icon)}\nTerminal=false\nCategories=Graphics;Photography;\nStartupNotify=true\nStartupWMClass=${DESKTOP_ID}\n`
}
export async function installLauncher(
  applicationDirectory,
  dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local/share'),
) {
  if (process.platform !== 'linux') throw new Error('Desktop launcher installation requires Linux.')
  const executable = join(applicationDirectory, 'irodori'),
    iconDirectory = join(dataHome, 'icons/hicolor/256x256/apps')
  await mkdir(iconDirectory, { recursive: true })
  const icon = join(iconDirectory, `${DESKTOP_ID}.png`)
  await cp(new URL('../assets/app/icons/generated/icon-256.png', import.meta.url), icon)
  const applications = join(dataHome, 'applications')
  await mkdir(applications, { recursive: true })
  const file = join(applications, DESKTOP_FILE)
  await writeFile(file, desktopEntry(executable, icon), { mode: 0o644 })
  return file
}
