# Intensity-first creative color reference

CC0-1.0 synthetic numerical data; no photographs or personal data.
`reference.json` contains 2,520 binary64 and 2,520 Float32-input Decimal80
vectors. Reproduce with:

```sh
python3 scripts/research/creative-color-v2-reference.py assets/tests/references/creative-color-v2/reference.json
```

The independent oracle derives matrices and evaluates complete XYZ/RGB. Version 2
applies Saturation/Vibrance, then Mixer, then Grading. The user approved this
appearance migration on November 4, 2026 as part of #45. Existing numeric controls
are retained in every migrated snapshot; their rendered appearance adopts this
order. The original `tests/fixtures/creative-color-reference.json` and its generator
remain unchanged as historical evidence. This is a deliberate rendering-policy
change, not a tolerance revision. Float64 and GPU limits are unchanged.
Generator and primary-reference hashes are recorded in `reference.json`.
