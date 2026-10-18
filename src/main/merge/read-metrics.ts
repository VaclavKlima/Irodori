import type { MergeReadMeasurements } from '../../shared/merge'

function emptyMeasurements(): MergeReadMeasurements {
  return {
    bands: {
      requests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      fileReads: 0,
      readBytes: 0,
      readingMs: 0,
      verifiedBytes: 0,
      hashingMs: 0,
      copyingMs: 0,
      allocatedBytes: 0,
      reusedStripBuffers: 0,
      peakCacheBytes: 0,
    },
    nativePlanes: {
      cacheHits: 0,
      cacheMisses: 0,
      fileReads: 0,
      readBytes: 0,
      readingMs: 0,
      verifiedBytes: 0,
      hashingMs: 0,
      conversionMs: 0,
      allocatedBytes: 0,
      stripBufferBytes: 0,
      peakCacheBytes: 0,
    },
    sensors: { files: 0, readBytes: 0, readingMs: 0, verifiedBytes: 0, hashingMs: 0 },
  }
}

// Each merge worker or sequential alignment lane owns its counters. Resetting
// attempt evidence does not discard that lane's immutable native-plane cache.
let measurements = emptyMeasurements()
export function mergeReadMeasurements() {
  return measurements
}
export function resetMergeReadMeasurements() {
  measurements = emptyMeasurements()
}
