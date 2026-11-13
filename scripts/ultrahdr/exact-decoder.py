"""Keep encoding unchanged; remove lookup quantization from ISO HDR decoding."""
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
source = path.read_text()
marker = 'uhdr_error_info_t UltraHdr::applyGainMap('
assert source.count(marker) == 1
encoder, decoder = source.split(marker)
assert decoder.count('#if !USE_APPLY_GAIN_LUT') == 1
assert decoder.count('#if USE_APPLY_GAIN_LUT') == 2
assert decoder.count('#if USE_SRGB_INVOETF_LUT') == 1
decoder = decoder.replace('#if !USE_APPLY_GAIN_LUT', '#if 1')
decoder = decoder.replace('#if USE_APPLY_GAIN_LUT', '#if 0')
decoder = decoder.replace('#if USE_SRGB_INVOETF_LUT', '#if 0')
path.write_text(encoder + marker + decoder)
