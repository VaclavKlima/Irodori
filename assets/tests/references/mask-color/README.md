# Relative mask color reference

CC0-1.0 synthetic numerical data; no photographs or personal data. Reproduce with:

```sh
python3 scripts/research/mask-color-reference.py assets/tests/references/mask-color/reference.json
```

The independent Decimal80 oracle derives sRGB/Rec.2020 matrices from published
chromaticities and inverts Bradford by elimination. It freezes the relative D65
mapping, both control directions and endpoints, signed and HDR inputs, exact
neutral/disabled/zero-coverage bypass, Light between balance and saturation,
half coverage blended once, and two ordered masks. RGB inputs are rounded to
binary32 before evaluating the complete pipeline. The reference uses complete
XYZ/Lab conversion rather than the GPU's small-delta formulation.

Temperature uses half a mired per unit around 6500 K. The Kang
locus displacement is anchored to actual D65; Tint follows the negative unit
normal in CIE 1960 UCS at 0.0001 per unit. These are creative relative controls,
not calibrated illuminant recovery. The production neutral path bypasses matrix
and pixel arithmetic. Matrices follow the retained W3C Bradford convention.

The generator and its independent primary-matrix helper are hashed in the data.
Float64 coefficient limits remain `2e-12 + 2e-11*abs(reference)`; GPU RGB limits
remain `2e-6 + 2e-5*abs(reference)`. No tolerance revision is introduced.
