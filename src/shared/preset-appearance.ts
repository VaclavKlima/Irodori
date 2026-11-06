/** Stable semantic IDs are independent of the glyph used to draw them. */
export const presetIconCategories = [
  { id: 'general', label: 'General' },
  { id: 'light-weather', label: 'Light and weather' },
  { id: 'subjects', label: 'Subjects' },
  { id: 'intent', label: 'Condition and intent' },
  { id: 'looks', label: 'Looks' },
] as const
export const presetIcons = [
  { id: 'general', label: 'General', category: 'general' },
  { id: 'sunlight', label: 'Sunlight', category: 'light-weather' },
  { id: 'sunrise', label: 'Sunrise', category: 'light-weather' },
  { id: 'sunset', label: 'Sunset', category: 'light-weather' },
  { id: 'backlight', label: 'Backlight', category: 'light-weather' },
  { id: 'indoor', label: 'Indoor', category: 'light-weather' },
  { id: 'night', label: 'Night', category: 'light-weather' },
  { id: 'fog', label: 'Fog', category: 'light-weather' },
  { id: 'overcast', label: 'Overcast', category: 'light-weather' },
  { id: 'rain', label: 'Rain', category: 'light-weather' },
  { id: 'snow', label: 'Snow', category: 'light-weather' },
  { id: 'portrait', label: 'Portrait', category: 'subjects' },
  { id: 'landscape', label: 'Landscape', category: 'subjects' },
  { id: 'street', label: 'Street', category: 'subjects' },
  { id: 'architecture', label: 'Architecture', category: 'subjects' },
  { id: 'macro', label: 'Macro', category: 'subjects' },
  { id: 'food', label: 'Food', category: 'subjects' },
  { id: 'high-noise', label: 'High noise', category: 'intent' },
  { id: 'detail', label: 'Soft photo / detail', category: 'intent' },
  { id: 'soft-look', label: 'Soft look / blur', category: 'intent' },
  { id: 'motion', label: 'Motion', category: 'intent' },
  { id: 'cinematic', label: 'Cinematic', category: 'looks' },
  { id: 'vintage', label: 'Vintage', category: 'looks' },
  { id: 'monochrome', label: 'Black and white', category: 'looks' },
  { id: 'vivid', label: 'Vivid', category: 'looks' },
] as const
export const presetColors = [
  { id: 'neutral', label: 'Neutral', hex: '#c0c0c0' },
  { id: 'amber', label: 'Amber', hex: '#e2c18c' },
  { id: 'orange', label: 'Orange', hex: '#e6a574' },
  { id: 'red', label: 'Red', hex: '#e59595' },
  { id: 'rose', label: 'Rose', hex: '#e4a4c5' },
  { id: 'violet', label: 'Violet', hex: '#b5a4e8' },
  { id: 'blue', label: 'Blue', hex: '#8fb8e8' },
  { id: 'teal', label: 'Teal', hex: '#85c9c3' },
  { id: 'green', label: 'Green', hex: '#a4ca96' },
] as const
export type PresetIconId = (typeof presetIcons)[number]['id']
export type PresetColorId = (typeof presetColors)[number]['id']
export interface PresetAppearance {
  icon: PresetIconId
  color: PresetColorId
}
export const DEFAULT_PRESET_APPEARANCE: Readonly<PresetAppearance> = Object.freeze({
  icon: 'general',
  color: 'neutral',
})
export function validatePresetAppearance(
  value: unknown,
  partial?: false,
): asserts value is PresetAppearance
export function validatePresetAppearance(
  value: unknown,
  partial: true,
): asserts value is Partial<PresetAppearance>
export function validatePresetAppearance(value: unknown, partial = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Choose a supported preset icon and color.')
  const appearance = value as Record<string, unknown>
  if (
    Object.keys(appearance).some((key) => !['icon', 'color'].includes(key)) ||
    (partial
      ? Object.keys(appearance).length === 0
      : !['icon', 'color'].every((key) => Object.hasOwn(appearance, key))) ||
    (Object.hasOwn(appearance, 'icon') &&
      !presetIcons.some((item) => item.id === appearance.icon)) ||
    (Object.hasOwn(appearance, 'color') &&
      !presetColors.some((item) => item.id === appearance.color))
  )
    throw new Error('Choose a supported preset icon and color.')
}
export function mergePresetAppearance(
  base: PresetAppearance,
  patch?: Partial<PresetAppearance>,
): PresetAppearance {
  if (patch !== undefined) validatePresetAppearance(patch, true)
  return { ...base, ...patch }
}
export function presetAppearanceLabel(value: PresetAppearance): string {
  return `${presetIcons.find((item) => item.id === value.icon)!.label} · ${presetColors.find((item) => item.id === value.color)!.label}`
}
