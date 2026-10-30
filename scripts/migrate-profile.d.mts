export interface ProfileMigrationReport {
  version: number
  from: string
  to: string
  catalog: boolean
  updatedCells: number
  updatedSidecars: { path: string; previousSha256: string }[]
  retiredCaches: string[]
  originals: { path: string; inode: string; bytes: string; modified: string }[]
  complete: boolean
}
export function migrateProfile(
  from: string,
  to: string,
  evidence: string,
): Promise<ProfileMigrationReport>
