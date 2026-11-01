"""Independent C15 host-Float64 publication graph; source-only until approval.

This module does not import a candidate, an application helper, or a C14 CPU
implementation. Its pilot stage inputs must come from the independently authored
Decimal80 direct-patch oracle. Python's pinned host math primitives are shared
runtime infrastructure, not a claim of portable correctly rounded libm results.
"""

from decimal import localcontext
import math
import struct

ORACLE = {
    'kind': 'host-f64-operation-graph-v1',
    'scope': 'host-runtime-libm-v1',
    'coefficientPolicy': 'independent-Decimal80-primary-solve-rounded-to-binary64-v1',
    'candidateImported': False,
}


def binary64_word(value):
    return struct.pack('>d', value).hex()


def binary32_word(value, canonical_delta=False):
    word = struct.unpack('<I', struct.pack('<f', value))[0]
    return 0 if canonical_delta and (word & 0x7fffffff) == 0 else word


def word_value(word):
    return struct.unpack('<f', struct.pack('<I', word))[0]


def require_published(value, canonical_delta=False):
    """Reject unrounded diagnostics before converting them into expected words."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('Published scalar is not finite.')
    word = binary32_word(value)
    if binary64_word(float(value)) != binary64_word(word_value(word)):
        raise ValueError('Diagnostic scalar was not already a binary32 publication.')
    if canonical_delta and (word & 0x7fffffff) == 0 and word != 0:
        raise ValueError('Published delta zero was not canonical positive zero.')
    return word


def independently_rounded_coefficients(shared, primary):
    with localcontext() as context:
        context.prec = 80
        exact = shared.luminance_coefficients(primary)
        result = tuple(float(value) for value in exact)
    if any(not math.isfinite(value) for value in result):
        raise ValueError('Independent primary solve produced nonfinite coefficients.')
    return result


def source_features(source, coefficients):
    """Independently spell out the declared host feature operation graph."""
    result = []
    for pixel in source:
        if pixel[3] == 0:
            result.append((0.0, 0.0, 0.0))
            continue
        products = [coefficients[index] * pixel[index] for index in range(3)]
        luminance = math.fsum(products)
        scale = math.hypot(luminance, .18)
        result.append((math.asinh(luminance / .18),
                       math.asinh((pixel[0] - luminance) / scale),
                       math.asinh((pixel[2] - luminance) / scale)))
    return result


def gather_guide(features, alpha, width, height, independently_published_stage):
    """Gather only independently generated E59 words; never candidate diagnostics."""
    guide, proposals = [], []
    for py in range(height):
        for px in range(width):
            owner = py * width + px
            if alpha[owner] == 0:
                guide.append((0.0, 0.0, 0.0))
                proposals.append((0.0, 0.0, 0.0))
                continue
            delta = []
            for component, radius in ((0, 1), (1, 2), (2, 2)):
                total, numerator = 0.0, 0.0
                for ry in range(-radius, radius + 1):
                    for rx in range(-radius, radius + 1):
                        cx, cy = px - rx, py - ry
                        if cx < 0 or cx >= width or cy < 0 or cy >= height:
                            continue
                        at = cy * width + cx
                        if alpha[at] == 0:
                            continue
                        words = independently_published_stage(cx, cy)
                        offset = (ry + radius) * (2 * radius + 1) + rx + radius
                        slot = offset if component == 0 else 9 + 2 * offset + component - 1
                        total += alpha[at]
                        numerator += alpha[at] * word_value(words[slot])
                if total <= 0:
                    raise ArithmeticError('Independent guide lost positive outer normalization.')
                delta.append(numerator / total)
            proposals.append(tuple(delta))
            guide.append(tuple(word_value(binary32_word(features[owner][component] +
                                                       delta[component]))
                               for component in range(3)))
    return guide, proposals


def owner_chroma(features, guide, alpha, width, height, amount, variance):
    if amount <= 0:
        raise ValueError('The exact C0 legacy bypass must precede owner estimation.')
    maximum = math.sqrt(.024 * .024 + .4 * .4 * (variance[1] + variance[2]))
    bandwidth = maximum * (amount / 100) ** 2
    published, normalizers, raw_means = [], [], []
    for py in range(height):
        for px in range(width):
            owner = py * width + px
            if alpha[owner] == 0:
                published.append((0, 0))
                normalizers.append(0.0)
                raw_means.append((0.0, 0.0))
                continue
            denominator, first, second = 0.0, 0.0, 0.0
            for dy in range(-10, 11):
                for dx in range(-10, 11):
                    qx = max(0, min(width - 1, px + dx))
                    qy = max(0, min(height - 1, py + dy))
                    neighbor = qy * width + qx
                    if alpha[neighbor] == 0:
                        continue
                    dl = (guide[owner][0] - guide[neighbor][0]) ** 2
                    dc = ((guide[owner][1] - guide[neighbor][1]) ** 2 +
                          (guide[owner][2] - guide[neighbor][2]) ** 2)
                    weight = alpha[neighbor] * alpha[neighbor] * math.exp(
                        -dl / (.08 * .08) - dc / (bandwidth * bandwidth))
                    denominator += weight
                    first += weight * (features[neighbor][1] - features[owner][1])
                    second += weight * (features[neighbor][2] - features[owner][2])
            if denominator <= 0:
                raise ArithmeticError('Independent owner lost positive normalization.')
            published.append((binary32_word(first / denominator, True),
                              binary32_word(second / denominator, True)))
            normalizers.append(denominator)
            raw_means.append((first / denominator, second / denominator))
    return published, normalizers, raw_means


def publication_vectors():
    """Metadata only: fixed exact binary64 operands, no candidate calls or outputs."""
    rows = [
        ('positive-zero', '0x0.0p+0', '0x0.0p+0'),
        ('negative-zero', '-0x0.0p+0', '-0x0.0p+0'),
        ('mixed-zero', '0x0.0p+0', '-0x0.0p+0'),
        ('even-normal-midpoint', '0x1.0000000000000p+0', '0x1.0000000000000p-24'),
        ('even-normal-double-round', '0x1.0000000000000p+0', '0x1.0000000400000p-24'),
        ('negative-double-round', '-0x1.0000000000000p+0', '-0x1.0000000400000p-24'),
        ('odd-normal-midpoint', '0x1.0000020000000p+0', '0x1.0000000000000p-24'),
        ('negative-odd-midpoint', '-0x1.0000020000000p+0', '-0x1.0000000000000p-24'),
        ('half-minsubnormal', '0x0.0p+0', '0x1.0000000000000p-150'),
        ('negative-half-minsubnormal', '-0x0.0p+0', '-0x1.0000000000000p-150'),
        ('three-half-minsubnormal', '0x0.0p+0', '0x1.8000000000000p-149'),
        ('negative-three-half-minsubnormal', '-0x0.0p+0', '-0x1.8000000000000p-149'),
        ('normal-boundary-midpoint', '0x1.0000000000000p-126', '-0x1.0000000000000p-150'),
        ('negative-normal-boundary-midpoint', '-0x1.0000000000000p-126', '0x1.0000000000000p-150'),
        ('exact-cancellation', '0x1.0000000000000p+0', '-0x1.0000000000000p+0'),
    ]
    normalized = {
        'positive-zero': '0x0.0p+0', 'negative-zero': '-0x0.0p+0',
        'mixed-zero': '0x0.0p+0',
        'even-normal-midpoint': '0x1.0000010000000p+0',
        'even-normal-double-round': '0x1.0000010000000p+0',
        'negative-double-round': '-0x1.0000010000000p+0',
        'odd-normal-midpoint': '0x1.0000030000000p+0',
        'negative-odd-midpoint': '-0x1.0000030000000p+0',
        'normal-boundary-midpoint': '0x1.fffffe0000000p-127',
        'negative-normal-boundary-midpoint': '-0x1.fffffe0000000p-127',
        'exact-cancellation': '0x0.0p+0',
    }
    return [{'id': name, 'featureHex': feature, 'proposalHex': proposal,
             'normalizedDeltaHex': normalized.get(name, proposal)}
            for name, feature, proposal in rows]
