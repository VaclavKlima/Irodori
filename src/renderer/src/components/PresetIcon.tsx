import {
  SlidersHorizontal,
  Sun,
  Sunrise,
  Sunset,
  Eclipse,
  LampFloor,
  Moon,
  CloudFog,
  Cloud,
  CloudRain,
  Snowflake,
  UserRound,
  Mountain,
  Building2,
  Landmark,
  Flower2,
  Utensils,
  Focus,
  Wind,
  Clapperboard,
  Film,
  Contrast,
  Palette,
  type LucideIcon,
} from 'lucide-react'
import {
  presetColors,
  type PresetAppearance,
  type PresetIconId,
} from '../../../shared/preset-appearance'
import scenarioSprite from '../../../../assets/app/icons/presets/scenarios.svg?url&no-inline'

const glyphs: Record<Exclude<PresetIconId, 'high-noise' | 'soft-look'>, LucideIcon> = {
  general: SlidersHorizontal,
  sunlight: Sun,
  sunrise: Sunrise,
  sunset: Sunset,
  backlight: Eclipse,
  indoor: LampFloor,
  night: Moon,
  fog: CloudFog,
  overcast: Cloud,
  rain: CloudRain,
  snow: Snowflake,
  portrait: UserRound,
  landscape: Mountain,
  street: Building2,
  architecture: Landmark,
  macro: Flower2,
  food: Utensils,
  detail: Focus,
  motion: Wind,
  cinematic: Clapperboard,
  vintage: Film,
  monochrome: Contrast,
  vivid: Palette,
}
export function PresetIcon({
  appearance,
  size = 16,
  className,
}: {
  appearance: PresetAppearance
  size?: 16 | 24
  className?: string
}) {
  const props = {
    width: size,
    height: size,
    className,
    'aria-hidden': true as const,
    'data-preset-icon': appearance.icon,
    'data-preset-color': appearance.color,
    style: { color: presetColors.find((item) => item.id === appearance.color)!.hex, flexShrink: 0 },
  }
  if (appearance.icon === 'high-noise' || appearance.icon === 'soft-look')
    return (
      <svg
        {...props}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <use href={`${scenarioSprite}#${appearance.icon}`} />
      </svg>
    )
  const Glyph = glyphs[appearance.icon]
  return <Glyph {...props} strokeWidth={2} />
}
