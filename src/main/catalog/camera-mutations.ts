import {
  CameraRecognition,
  CAMERA_SAMPLE_VERSION,
  type CameraBinding,
  type CameraSourceKey,
} from '../camera-recognition'
import type { ImportSourceWitness } from '../import-source-records'

export class CameraMutations extends CameraRecognition {
  record(
    key: CameraSourceKey,
    witness: ImportSourceWitness,
    photoId: string,
    proof: CameraBinding['proof'],
  ): void {
    if (!this.live(photoId)) return
    this.db
      .prepare(
        'INSERT INTO camera_imports VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(volume_id, relative_path) DO UPDATE SET photo_id = excluded.photo_id, size = excluded.size, mtime_ns = excluded.mtime_ns, birthtime_ns = excluded.birthtime_ns, proof = excluded.proof',
      )
      .run(key.volume, key.path, photoId, witness.size, witness.mtimeNs, witness.birthtimeNs, proof)
  }
  cacheSample(id: string, digest: string): void {
    if (this.live(id))
      this.db
        .prepare(
          'INSERT INTO camera_samples VALUES (?, ?, ?) ON CONFLICT(photo_id) DO UPDATE SET version = excluded.version, digest = excluded.digest',
        )
        .run(id, CAMERA_SAMPLE_VERSION, digest)
  }
}
