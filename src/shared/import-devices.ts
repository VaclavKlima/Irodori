/** Mounted storage summaries. Mount paths and operating-system identities stay in main. */
export interface ImportDevice {
  id: string
  name: string
  capacityBytes: number | null
  available: boolean
  volumeCount: number
}
