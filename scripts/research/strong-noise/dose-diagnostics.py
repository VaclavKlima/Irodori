"""Independent source-range control checks; no filter weights or candidate imports."""
from decimal import Decimal, localcontext
import math
import struct


def ranges(model, source, width, height, coefficients):
    features = [model.encode(pixel,coefficients) if pixel[3] > 0 else (0.0,0.0,0.0) for pixel in source]
    result = []
    for y in range(height):
        for x in range(width):
            p = y*width+x
            maximum = [0.0,0.0,0.0]
            if source[p][3] > 0:
                for dy in range(-3,4):
                    for dx in range(-3,4):
                        q = min(height-1,max(0,y+dy))*width+min(width-1,max(0,x+dx))
                        if source[q][3] > 0:
                            for c in range(3):
                                maximum[c] = max(maximum[c],abs(features[q][c]-features[p][c]))
            result.append(maximum)
    return result


def evaluate(model, source, clean, output, deltas, local_ranges, coefficients, luminance, chroma, gentle, patchwise=False):
    with localcontext() as context:
        context.prec = 80
        u = Decimal(2)**-53
        gamma = 49*u/(1-49*u)
        factor = (1+gamma)/(1-gamma)*(1+u)**3
        outer_gamma = 9*u/(1-9*u)
        outer_factor = (1+outer_gamma)/(1-outer_gamma)*(1+u)**3
        stage_relative = Decimal(2)**-24
        stage_absolute = Decimal(2)**-150
    multipliers = [min(1,(amount/50)**2) if gentle else (1 if amount else 0) for amount in (luminance,chroma,chroma)]
    failures, zero_count, maximum_ratio = [],0,0.0
    for p,(proposal,ranges_) in enumerate(zip(deltas,local_ranges)):
        for c in range(3):
            bound = multipliers[c]*ranges_[c]
            if bound == 0:
                zero_count += 1
                valid = proposal[c] == 0
            else:
                # Evaluate the analytic allowance before rounding once upwards.
                with localcontext() as context:
                    context.prec = 80
                    if patchwise:
                        # Inner49 summation/division, mandatory nearest-even f32
                        # E publication, then outer9 and final own-multiply.
                        inner_bound = Decimal.from_float(ranges_[c])*factor
                        published_bound = inner_bound*(1+stage_relative)+stage_absolute
                        exact_allowance = Decimal.from_float(multipliers[c])*published_bound*outer_factor
                    else:
                        exact_allowance = Decimal.from_float(bound)*factor
                    allowed = float(exact_allowance)
                    if Decimal.from_float(allowed) < exact_allowance:
                        allowed = math.nextafter(allowed,math.inf)
                valid = math.isfinite(proposal[c]) and abs(proposal[c]) <= allowed
                maximum_ratio = max(maximum_ratio,abs(proposal[c])/bound)
            if not valid:
                failures.append({'pixel':p,'component':c,'proposal':proposal[c],'boundBeforeAllowance':bound})
    entering_features = [model.encode(p,coefficients) for p in source]
    output_features = [model.encode(p,coefficients) for p in output]
    clean_features = [model.encode(p,coefficients) for p in clean]
    count = len(source)
    effect = [math.sqrt(math.fsum((a[c]-b[c])**2 for a,b in zip(output_features,entering_features))/count) for c in range(3)]
    residual = [math.sqrt(math.fsum((a[c]-b[c])**2 for a,b in zip(output_features,clean_features))/count) for c in range(3)]
    gates = {'finite':all(math.isfinite(v) for pixel in output for v in pixel),
        'alphaExact':all(struct.pack('<f',a[3]) == struct.pack('<f',b[3]) for a,b in zip(source,output)),
        'transparentRgbExact':all(struct.pack('<4f',*a) == struct.pack('<4f',*b) for a,b in zip(source,output) if a[3] == 0),
        'featureDeltaLocalRangeBound':not failures}
    if luminance == chroma == 0:
        gates['neutralSourceWordsExact'] = all(struct.pack('<4f',*a) == struct.pack('<4f',*b) for a,b in zip(source,output))
    return {'required':True,'cohort':'dosage-diagnostic','gates':gates,
        'boundFailureCount':len(failures),'boundFailures':failures,'exactZeroBoundChecks':zero_count,
        'maximumProposalToUninflatedBoundRatio':maximum_ratio,
        'effectFeatureRms':effect,'knownCleanResidualFeatureRms':residual,
        'interpretation':'Published Float32 features, not the captured pre-inverse deltas. RMS and nonmonotone intervals are descriptive; no universal monotonicity gate.'}
