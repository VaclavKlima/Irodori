"""Original independent Float64 candidate equations. Draft only; no application imports.

Reference RGB feature/primary/prefix helpers are passed explicitly by the caller.
This module contains no top-level experiment or file mutation.
"""
import math

Q = 0.6744897501960817
DIRECTIONS = ((1, 0), (0, 1), (1, 1), (1, -1))


def weighted_median(samples):
    values = sorted((value, weight) for value, weight in samples if weight > 0)
    if not values:
        return None
    half = math.fsum(weight for _, weight in values) / 2
    cumulative = 0.0
    for index, (value, weight) in enumerate(values):
        cumulative += weight
        if cumulative == half and index + 1 < len(values):
            return (value + values[index + 1][0]) / 2
        if cumulative > half:
            return value
    return values[-1][0]


def estimate(features, alpha, width, height, maximum=65536):
    directions = []
    for dx, dy in DIRECTIONS:
        x0, y0 = max(0, -dx), max(0, -dy)
        w, h = width - abs(dx), height - abs(dy)
        total = w * h
        count = min(total, maximum)
        components = [[], [], []]
        indices = []
        for sample in range(count):
            index = ((2 * sample + 1) * total) // (2 * count)
            x, y = x0 + index % w, y0 + index // w
            p, q = y * width + x, (y + dy) * width + x + dx
            weight = alpha[p] * alpha[q]
            if weight <= 0:
                continue
            indices.append(p)
            for c in range(3):
                components[c].append((features[p][c] - features[q][c], weight))
        sigmas, centers = [], []
        for component in components:
            center = weighted_median(component)
            centers.append(center)
            mad = None if center is None else weighted_median([(abs(v-center), weight) for v, weight in component])
            sigmas.append(None if mad is None or len(component) < 16 else mad / (Q * math.sqrt(2)))
        directions.append({'direction': [dx, dy], 'validPairs': len(indices),
            'availablePairs': total, 'stratifiedPairs': count, 'centers': centers, 'sigma': sigmas})
    sigma = [min((row['sigma'][c] for row in directions if row['sigma'][c] is not None), default=0.0) for c in range(3)]
    return {'version': 'frozen-global-directional-mad-v1', 'sigma': sigma,
        'variance': [v*v for v in sigma], 'directions': directions,
        'available': all(any(row['sigma'][c] is not None for row in directions) for c in range(3)),
        'limit': 'Conservative finite-sample minimum; no unbiased/calibrated/sensor-noise claim.'}


def reference_denominator(legacy, self_mass, distinct_mass, maximum_final, confidence, policy):
    """A denominator policy only; the accumulated feature numerator is unchanged."""
    if policy == 'legacy':
        return legacy, {'branch':'legacy','g':0.0,'capApplied':False}
    if distinct_mass <= 0:
        return None, {'branch':'no-distinct-positive-final-weight','g':0.0,'capApplied':False}
    cap = min(self_mass,maximum_final)
    if policy == 'aggregate-final-cap-ungated-v1':
        if cap == self_mass:
            return legacy, {'branch':'ungated-no-cap','g':1.0,'capApplied':False}
        return distinct_mass+cap, {'branch':'ungated','g':1.0,'capApplied':cap < self_mass}
    if policy != 'smooth-opacity-reference-cap-v1':
        raise ValueError('Undeclared reference policy.')
    pi = math.exp(-1)
    if confidence <= pi:
        # Keep the old total and its original accumulation order exactly.
        return legacy, {'branch':'g0','g':0.0,'capApplied':False}
    if confidence >= 1:
        if cap == self_mass:
            return legacy, {'branch':'g1-no-cap','g':1.0,'capApplied':False}
        return distinct_mass+cap, {'branch':'g1','g':1.0,'capApplied':True}
    t = (confidence-pi)/(1-pi)
    g = t*t*(3-2*t)
    if cap == self_mass:
        return legacy, {'branch':'smooth-no-cap','g':g,'capApplied':False}
    new_self = (1-g)*self_mass+g*cap
    if new_self == self_mass:
        return legacy, {'branch':'smooth-rounded-no-cap','g':g,'capApplied':False}
    return distinct_mass+new_self, {'branch':'smooth','g':g,'capApplied':new_self < self_mass}


def denoise(model, source, width, height, coefficients, luminance, chroma, candidate, oracle_variance=None, capture_deltas=False, estimate_snapshot=None):
    if luminance == chroma == 0:
        return [p[:] for p in source], {'estimation': 'neutral-bypass', **({'featureDeltas': [[0.0, 0.0, 0.0] for p in source]} if capture_deltas else {})}
    if candidate['id'] == 'legacy':
        return model.denoise(source, width, height, coefficients, luminance, chroma, 'nlm', .048, .16), {'estimation': 'legacy-bypass'}
    features = [model.encode(p, coefficients) for p in source]
    estimate_result = None
    if candidate['variance'] == 'known-per-source-sample':
        if oracle_variance is None or len(oracle_variance) != len(source):
            raise ValueError('Oracle candidate requires independently declared variance for each actual source sample.')
        variance = oracle_variance
        frozen_variance = None
    else:
        estimate_result = estimate_snapshot if estimate_snapshot is not None else estimate(features, [p[3] for p in source], width, height)
        if estimate_result.get('version') != 'frozen-global-directional-mad-v1' or len(estimate_result['variance']) != 3 or not all(math.isfinite(v) and v >= 0 for v in estimate_result['variance']):
            raise ValueError('Invalid frozen estimator snapshot.')
        frozen_variance = estimate_result['variance']
        variance = [frozen_variance] * len(source)
    h_l = candidate['luminanceBandwidthMaximum'] * (luminance / 100) ** 2
    h_c = candidate['chromaBandwidthMaximum'] * (chroma / 100) ** 2
    g_l2, g_c2 = .08**2, .12**2
    if candidate['adaptive'] != 'none':
        v_l, v_a, v_b = frozen_variance
        h_l = (luminance / 100)**2 * math.sqrt(.048**2 + 2*v_l)
        h_c = (chroma / 100)**2 * math.sqrt(.16**2 + 2*(v_a+v_b))
        if candidate['adaptive'] == 'both':
            g_l2 += 2*v_l
            g_c2 += 2*(v_a+v_b)
    sums = [[0.0]*5 for _ in source]
    policy = candidate['selfPolicy']
    # S_L/S_C, M_L/M_C, P_L/P_C, D_L/D_C: no per-neighbor arrays.
    reference = None if policy == 'legacy' else [[0.0]*8 for _ in source]
    padded_width, padded_height = width+2, height+2

    def index(x, y):
        return max(0, min(height-1, y))*width + max(0, min(width-1, x))

    for dy in range(-3, 4):
        for dx in range(-3, 4):
            distance_l, distance_c, bias_l, bias_c, coverage = [], [], [], [], []
            for y in range(-1, height+1):
                for x in range(-1, width+1):
                    p, q = index(x,y), index(x+dx,y+dy)
                    a = source[p][3] * source[q][3]
                    coverage.append(a)
                    distance_l.append(a*(features[p][0]-features[q][0])**2)
                    distance_c.append(a*((features[p][1]-features[q][1])**2+(features[p][2]-features[q][2])**2))
                    # Identical clamped source coordinates have zero difference variance.
                    bias_l.append(0.0 if p == q else a*(variance[p][0]+variance[q][0]))
                    bias_c.append(0.0 if p == q else a*(variance[p][1]+variance[q][1]+variance[p][2]+variance[q][2]))
            tables = [model.prefix(v,padded_width,padded_height) for v in (distance_l,distance_c,bias_l,bias_c,coverage)]
            spatial = math.exp(-(dx*dx+dy*dy)/8)
            for y in range(height):
                for x in range(width):
                    p, q = y*width+x, index(x+dx,y+dy)
                    if source[p][3] == 0 or source[q][3] == 0:
                        continue
                    patch = [model.box(table,padded_width,x,y,3) for table in tables]
                    if patch[4] <= 0:
                        continue
                    dl, dc, bl, bc = [max(0.0, v/patch[4]) for v in patch[:4]]
                    corrected_l, corrected_c = max(dl-bl,0), max(dc-bc,0)
                    own_l = corrected_l if candidate['correction'] in ('range','both') else dl
                    own_c = corrected_c if candidate['correction'] in ('range','both') else dc
                    guide_l = corrected_l if candidate['correction'] in ('guidance','both') else dl
                    guide_c = corrected_c if candidate['correction'] in ('guidance','both') else dc
                    matching_l = math.exp(-own_l/h_l**2-guide_c/g_c2) if h_l else 0
                    matching_c = math.exp(-guide_l/g_l2-own_c/h_c**2) if h_c else 0
                    wl = spatial*source[q][3]*matching_l
                    wc = spatial*source[q][3]*matching_c
                    if reference is not None:
                        state = reference[p]
                        if p == q:
                            state[0] += wl
                            state[1] += wc
                        else:
                            state[2] = max(state[2],wl)
                            state[3] = max(state[3],wc)
                            ratio = min(source[p][3],source[q][3])/source[p][3]
                            state[4] = max(state[4],matching_l*ratio)
                            state[5] = max(state[5],matching_c*ratio)
                            state[6] += wl
                            state[7] += wc
                    sums[p][0] += wl*(features[q][0]-features[p][0])
                    sums[p][1] += wc*(features[q][1]-features[p][1])
                    sums[p][2] += wc*(features[q][2]-features[p][2])
                    sums[p][3] += wl
                    sums[p][4] += wc
    output = []
    feature_deltas = [] if capture_deltas else None
    gentle = candidate['blend'] == 'quadratic-to-50-v1'
    reference_diagnostics = {'policy':policy,'branches':{},'capAppliedChannels':0,'enabledChannels':0}
    for pixel_index,(rgb, weighted) in enumerate(zip(source,sums)):
        if rgb[3] == 0:
            output.append(rgb[:])
            if capture_deltas:
                feature_deltas.append([0.0, 0.0, 0.0])
            continue
        y = math.fsum(a*b for a,b in zip(rgb[:3],coefficients))
        scale = math.hypot(y,.18)
        denominator_l,denominator_c = weighted[3],weighted[4]
        if reference is not None:
            state = reference[pixel_index]
            for component,enabled in ((0,h_l),(1,h_c)):
                if not enabled:
                    continue
                denominator,diagnostic = reference_denominator(weighted[3+component],state[component],state[6+component],state[2+component],state[4+component],policy)
                if component == 0:
                    denominator_l = denominator
                else:
                    denominator_c = denominator
                branch = diagnostic['branch']
                reference_diagnostics['branches'][branch] = reference_diagnostics['branches'].get(branch,0)+1
                reference_diagnostics['capAppliedChannels'] += int(diagnostic['capApplied'])
                reference_diagnostics['enabledChannels'] += 1
        delta_l = weighted[0]/denominator_l if h_l and denominator_l is not None else 0.0
        delta_a = weighted[1]/denominator_c if h_c and denominator_c is not None else 0.0
        delta_b = weighted[2]/denominator_c if h_c and denominator_c is not None else 0.0
        # Preserve the previous arithmetic exactly for enabled amounts >=50.
        if gentle and 0 < luminance < 50:
            delta_l *= (luminance/50)**2
        if gentle and 0 < chroma < 50:
            multiplier = (chroma/50)**2
            delta_a *= multiplier
            delta_b *= multiplier
        if capture_deltas:
            feature_deltas.append([delta_l, delta_a, delta_b])
        dl = model.change(y,.18,delta_l) if h_l else 0
        da = model.change(rgb[0]-y,scale,delta_a) if h_c else 0
        db = model.change(rgb[2]-y,scale,delta_b) if h_c else 0
        if dl == da == db == 0:
            output.append(rgb[:])
        else:
            output.append([model.f32(rgb[0]+dl+da),model.f32(rgb[1]+dl-(coefficients[0]*da+coefficients[2]*db)/coefficients[1]),model.f32(rgb[2]+dl+db),rgb[3]])
    return output, {'referencePolicy':reference_diagnostics,'estimator':estimate_result,'effectiveBandwidths':{'hL':h_l,'hC':h_c,'gL':math.sqrt(g_l2),'gC':math.sqrt(g_c2)}, **({'featureDeltas':feature_deltas} if capture_deltas else {})}
