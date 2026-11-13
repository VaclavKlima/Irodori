import { join } from 'node:path'
import { loadBundledSelectionGraph } from './model'

export const AUTOMATIC_SELECTION_ID = 'mask2former-sky-birefnet-background-fp32-v1'
export const automaticSelectionGraphs = {
  sky: {
    bytes: 287_296_604,
    sha256: '2035d1c38fff88ee792d32002b269fe29f5c561009e9256200bdd9e3fbfb515f',
  },
  background: {
    bytes: 199_681_624,
    sha256: '50a57872cc739192446da2a934159f957c81af8b5a161dfda8e3daa51660ca67',
  },
} as const

export function loadAutomaticSelectionGraph(directory: string, selection: 'sky' | 'background') {
  return loadBundledSelectionGraph(
    join(directory, 'automatic'),
    selection,
    AUTOMATIC_SELECTION_ID,
    automaticSelectionGraphs[selection],
  )
}
