import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, lstat, open, realpath, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import type { FileIdentity } from './types'

export const identity = (s: FileIdentity): FileIdentity => ({
  dev: s.dev,
  ino: s.ino,
  size: s.size,
  mtimeMs: s.mtimeMs,
  ctimeMs: s.ctimeMs,
})
export const sameFile = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino
export const sameSource = (a: FileIdentity, b: FileIdentity) =>
  sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
export async function hashFile(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export function ownedPartialName(jobId: string, index: number, name: string) {
  return (
    name.startsWith(`.luma-export-${jobId}-${index}-`) &&
    /^\.luma-export-[a-f0-9-]+-\d+-[a-f0-9-]+\.partial$/.test(name)
  )
}
export async function directoryIdentity(path: string) {
  const canonical = await realpath(path)
  const info = await lstat(canonical)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Choose an accessible export folder.')
  await access(canonical, constants.W_OK | constants.X_OK)
  return { path: canonical, identity: identity(info) }
}
export async function validateDirectory(grant: { path: string; identity: FileIdentity }) {
  try {
    const current = await directoryIdentity(grant.path)
    if (current.path !== grant.path || !sameFile(current.identity, grant.identity))
      throw new Error('Folder identity changed.')
    return grant.path
  } catch {
    throw new Error(
      'The export folder is missing, inaccessible, or has changed. Choose another folder.',
    )
  }
}
/** Only a recorded inode owned by this job is eligible for partial cleanup. */
export async function cleanPartial(path: string, witness?: FileIdentity) {
  if (!witness) return
  try {
    const info = await lstat(path)
    if (info.isFile() && !info.isSymbolicLink() && sameFile(info, witness)) await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
export async function syncFile(path: string) {
  const file = await open(path, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}
