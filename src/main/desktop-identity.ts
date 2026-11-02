import { app } from 'electron'
import icon from '../../assets/app/icons/generated/icon-256.png?asset'
import { DESKTOP_FILE, DESKTOP_ID } from '../shared/desktop-identity'

export const desktopIcon = icon
export function configureDesktopIdentity() {
  if (process.platform === 'linux') {
    app.setDesktopName(DESKTOP_FILE)
    app.commandLine.appendSwitch('class', DESKTOP_ID)
  }
  if (process.platform === 'win32') app.setAppUserModelId(DESKTOP_ID)
  void app.whenReady().then(() => app.dock?.setIcon(icon))
}
