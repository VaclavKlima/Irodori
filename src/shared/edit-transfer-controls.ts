export const editTransferGroups = [
  { id: 'light', label: 'Light', default: true },
  { id: 'color', label: 'Saturation and vibrance', default: true },
  { id: 'mixer', label: 'Color mixer', default: true },
  { id: 'grading', label: 'Color grading', default: true },
  { id: 'noise', label: 'Noise reduction', default: true },
  { id: 'sharpening', label: 'Detail sharpening', default: true },
  { id: 'crop', label: 'Crop and straighten', default: false },
  { id: 'white-balance', label: 'White balance', default: false },
  { id: 'lens', label: 'Lens corrections', default: false },
] as const
export type EditTransferGroup = (typeof editTransferGroups)[number]['id']
export const defaultEditTransferGroups: EditTransferGroup[] = editTransferGroups
  .filter((group) => group.default)
  .map((group) => group.id)

export const editTransferCapabilities = {
  version: 1,
  groups: editTransferGroups,
  clipboard: 'session',
  maxTargets: 100000,
  maxPreparedTargets: 100000,
  maxPreparations: 8,
  maxConcurrentPreparations: 2,
  preparationTtlMs: 15 * 60_000,
  maxActiveJobs: 1,
  history: 'one-step-per-changed-photo',
  recovery: 'retain-results-without-replay',
} as const
