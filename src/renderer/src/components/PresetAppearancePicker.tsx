import { useId, useRef } from 'react'
import { Check } from 'lucide-react'
import {
  presetIcons,
  presetColors,
  presetIconCategories,
  presetAppearanceLabel,
  type PresetAppearance,
} from '../../../shared/preset-appearance'
import { PresetIcon } from './PresetIcon'
import styles from './PresetAppearancePicker.module.css'

export function PresetAppearancePicker({
  value,
  name,
  disabled,
  onChange,
}: {
  value: PresetAppearance
  name: string
  disabled: boolean
  onChange: (value: PresetAppearance) => void
}) {
  const id = useId(),
    summary = useRef<HTMLElement>(null)
  const selectedIcon = presetIcons.find((item) => item.id === value.icon)!
  const selectedColor = presetColors.find((item) => item.id === value.color)!
  return (
    <div className={styles.picker}>
      <div className={styles.preview} role="group" aria-label="Preset appearance">
        <PresetIcon appearance={value} size={24} />
        <strong>{name.trim() || 'New preset'}</strong>
        <span>{presetAppearanceLabel(value)}</span>
      </div>
      <details
        className={styles.icons}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && event.currentTarget.open) {
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.open = false
            summary.current?.focus()
          }
        }}
      >
        <summary
          ref={summary}
          aria-disabled={disabled}
          onClick={(event) => {
            if (disabled) event.preventDefault()
          }}
        >
          Icon — {selectedIcon.label}
        </summary>
        <div className={styles.iconScroll}>
          {presetIconCategories.map((category) => (
            <fieldset key={category.id} disabled={disabled} className={styles.group}>
              <legend>{category.label}</legend>
              <div className={styles.iconGrid}>
                {presetIcons
                  .filter((icon) => icon.category === category.id)
                  .map((icon) => (
                    <label key={icon.id} className={styles.choice} title={icon.label}>
                      <input
                        type="radio"
                        name={`${id}-icon`}
                        aria-label={icon.label}
                        checked={value.icon === icon.id}
                        onChange={() => onChange({ ...value, icon: icon.id })}
                      />
                      <PresetIcon appearance={{ icon: icon.id, color: value.color }} />
                      {value.icon === icon.id && (
                        <Check className={styles.check} size={9} aria-hidden="true" />
                      )}
                    </label>
                  ))}
              </div>
            </fieldset>
          ))}
        </div>
      </details>
      <fieldset disabled={disabled} className={styles.group}>
        <legend>Color — {selectedColor.label}</legend>
        <div className={styles.colors}>
          {presetColors.map((color) => (
            <label key={color.id} className={styles.choice} title={color.label}>
              <input
                type="radio"
                name={`${id}-color`}
                aria-label={color.label}
                checked={value.color === color.id}
                onChange={() => onChange({ ...value, color: color.id })}
              />
              <PresetIcon appearance={{ icon: value.icon, color: color.id }} />
              {value.color === color.id && (
                <Check className={styles.check} size={9} aria-hidden="true" />
              )}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  )
}
