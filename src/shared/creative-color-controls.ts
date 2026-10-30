import { COLOR_MIXER_VERSION, colorRangeIds, colorRangeDefinitions } from './color-mixer'
import { COLOR_GRADING_VERSION, gradingToneIds } from './color-grading'

const amount = { min: -100, max: 100, step: 1, precision: 0, default: 0 } as const

/** Authored units and processing semantics shared by the inspector and typed capability API. */
export const creativeColorCapabilities = {
  domains: ['linear-srgb', 'linear-rec2020'],
  stageOrder: ['colorMixer', 'saturationVibrance', 'colorGrading'],
  colorMixer: {
    supported: true,
    settingsVersion: 1,
    algorithm: COLOR_MIXER_VERSION,
    ranges: colorRangeIds,
    rangeDefinitions: colorRangeDefinitions,
    parameters: {
      hue: { ...amount, unit: 'amount', degreesPerUnit: 0.3 },
      saturation: { ...amount, unit: 'amount', gainPerUnit: 0.01 },
      luminance: { ...amount, unit: 'amount', stopsPerUnit: 0.01 },
    },
  },
  colorGrading: {
    supported: true,
    settingsVersion: 1,
    algorithm: COLOR_GRADING_VERSION,
    tones: gradingToneIds,
    parameters: {
      hue: { min: 0, max: 359.9, step: 0.1, precision: 1, default: 0, unit: 'degrees' },
      saturation: { min: 0, max: 100, step: 1, precision: 0, default: 0, unit: 'amount' },
      luminance: { ...amount, unit: 'amount', stopsPerUnit: 0.01 },
      blending: {
        min: 0,
        max: 100,
        step: 1,
        precision: 0,
        default: 50,
        unit: 'amount',
        minimumWidthStops: 0.5,
        maximumWidthStops: 4,
      },
      balance: { ...amount, unit: 'amount', stopsPerUnit: 0.02 },
    },
  },
} as const
