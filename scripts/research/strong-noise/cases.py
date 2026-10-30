"""Frozen original nominal recipes and additional explicitly separated high-noise truth."""
import math
import struct


def legacy_scene(model, name, seed, primaries, sigma=.012, strength=50, high=False, weak=False, fresh=False, controls=None, cohort=None):
    width = height = 136 if high else None
    if not high:
        width, height = 32, 24
    only_l = name.startswith('period-') or name in ('flat-luminance', 'stars')
    only_c = name == 'flat-chroma'
    ls, cs = (0 if only_c else strength), (0 if only_l else strength)
    sl, sc = (0 if only_c else sigma), (0 if only_l else sigma)
    positions = [(32,32),(103,32),(32,103),(103,103)] if high else [(8,8),(23,8),(8,16),(23,16)]
    random = model.Noise(seed)
    clean, entering, variance = [], [], []
    for y in range(height):
        for x in range(width):
            l, a, b = 1.0, .08, -.04
            if name.startswith('period-'):
                period = int(name.split('-')[1])
                amplitude = (.024 if period == 2 else .03) if not high or weak else (2*sigma if period == 2 else 2.5*sigma)
                l += amplitude * ((-1 if x % 2 else 1) if period == 2 else math.sin(2*math.pi*x/period))
            elif name == 'edge':
                l = .7 if x < width//2 else 1.4
            elif name == 'isoluminant':
                a = -.2 if x < width//2 else .2
            elif name == 'stars':
                l, a, b = .04, 0.0, 0.0
                if (x,y) in positions:
                    l += 15*sigma if high else .18
            factor = (2 if x < width//2 else .5) if name == 'merge-boundary' else 1
            clean.append([model.f32(v) for v in model.decode([l,a,b],model.LUMINANCE[primaries])])
            entering.append([model.f32(v) for v in model.decode([l+sl*factor*random.normal(),a+sc*factor*random.normal(),b+sc*factor*random.normal()],model.LUMINANCE[primaries])])
            variance.append([(sl*factor)**2,(sc*factor)**2,(sc*factor)**2])
    return {'name':name,'seed':seed,'sigma':sigma,'strength':strength,'primaries':primaries,
        'width':width,'height':height,'luminance':ls if controls is None else controls[0],'chroma':cs if controls is None else controls[1],'clean':clean,'entering':entering,
        'oracleVariance':variance,'stars':positions,'cohort':cohort or ('high-weak-stress' if weak else 'high-required' if high else 'fresh-nominal-required' if fresh else 'nominal-required')}


def verify_original_inputs(model):
    # These comparisons preserve the exact original nominal RGB source words.
    for old in model.charts(0x4c554d41, True):
        current = scene(model,old['name'],0x4c554d41,'srgb')
        for key in ('clean','entering','width','height','luminance','chroma'):
            if current[key] != old[key]:
                raise RuntimeError(f'Original nominal input changed: {old["name"]}/{key}')


def legacy_evaluate(model, case, output):
    original_name = case['name']
    # The inherited edge/texture/boundary metric definitions stay unchanged.
    metric_case = {**case, 'name':'stars-high-reference' if original_name == 'stars' and case['width'] != 32 else original_name}
    result = model.evaluate(metric_case,output)
    w, h = case['width'], case['height']
    coefficients = model.LUMINANCE[case['primaries']]
    clean, entering, actual = [[model.encode(p,coefficients) for p in values] for values in (case['clean'],case['entering'],output)]
    indices = [y*w+x for y in range(4,h-4) for x in range(4,w-4)]
    result['metricSamples'] = len(indices)
    result['required'] = case['cohort'] != 'high-weak-stress'
    result['cohort'] = case['cohort']
    result['gates']['finite'] = all(math.isfinite(v) for p in output for v in p)
    result['gates']['alphaExact'] = all(struct.pack('<f',p[3]) == struct.pack('<f',q[3]) for p,q in zip(case['entering'],output))
    if original_name == 'mixed-flat' and case['cohort'] == 'high-required':
        result['gates'].update({'luminanceNoise':result['luminanceRmsRatio'] <= .55,
            'chromaNoise':result['chromaRmsRatio'] <= .45,
            'bias':max(abs(x) for x in result['meanBias']) <= .003})
    if original_name == 'stars' and w != 32:
        ratios, locations = [], []
        for x,y in case['stars']:
            i = y*w+x
            ratios.append((actual[i][0]-.04)/(entering[i][0]-.04))
            locations.append(all(actual[yy*w+xx][0] <= actual[i][0] for yy in range(y-2,y+3) for xx in range(x-2,x+3)))
        result['starPeakRetention'] = ratios
        result['gates']['stars'] = min(ratios) >= .9 and all(locations)
    if original_name == 'stars':
        for c in range(3):
            low, high = min(p[c] for p in case['entering']),max(p[c] for p in case['entering'])
            result['gates'][f'noNewStarChannelExtrema{c}'] = all(low <= p[c] <= high for p in output)
    return result


def selections(protocol, stage, scenes=None, seeds=None, primaries=None, sigmas=None, strengths=None):
    if stage == 'screen':
        for plan in protocol['screenAndHoldout']['firstScreen']['parts']:
            for recipe in selections(protocol,plan['stage'],plan['scenes'],[plan['seed']],plan['primaries'],[plan['sigma']],[plan['strength']]):
                if (not scenes or recipe['name'] in scenes) and (not seeds or recipe['seed'] in seeds) and (not primaries or recipe['primaries'] in primaries) and (not sigmas or recipe['sigma'] in sigmas) and (not strengths or recipe['strength'] in strengths):
                    yield recipe
        return
    if stage in ('dosage', 'dose-corners'):
        cohort = protocol['cohorts']['dosage']
        amounts = cohort['amounts' if stage == 'dosage' else 'cornerHoldoutAmounts']
        emitted = set()
        for name in scenes or cohort['scenes']:
            for primary in primaries or cohort['primaries']:
                for sigma in sigmas or cohort['sigma']:
                    modes = ('scene', 'vary-luminance', 'vary-chroma') if name == 'mixed-flat' else ('scene',)
                    for mode in modes:
                        for amount in strengths or amounts:
                            if mode == 'vary-luminance':
                                controls = [amount,50]
                            elif mode == 'vary-chroma':
                                controls = [50,amount]
                            else:
                                controls = [0 if name == 'flat-chroma' else amount,0 if name == 'flat-luminance' else amount]
                            key = (name,primary,sigma,tuple(controls))
                            if key in emitted:
                                continue
                            emitted.add(key)
                            yield {'name':name,'seed':cohort['seed'],'primaries':primary,'sigma':sigma,
                                'strength':amount,'high':False,'weak':False,'fresh':False,
                                'controls':controls,'cohort':'dosage-diagnostic'}
        return
    nominal = stage in ('nominal','fresh-nominal','comparison4-nominal-regression')
    cohort = protocol['cohorts'][stage if nominal else 'high-noise']
    chosen_scenes = scenes or (['period-2','period-4'] if stage == 'weak-stress' else cohort['scenes'])
    chosen_seeds = seeds or cohort['seeds']
    chosen_primaries = primaries or cohort['primaries']
    chosen_sigmas = sigmas or cohort['sigma']
    chosen_strengths = [50] if nominal else strengths or cohort['strengths']
    for name in chosen_scenes:
        for seed in chosen_seeds:
            for primary in chosen_primaries:
                for sigma in chosen_sigmas:
                    for strength in chosen_strengths:
                        yield {'name':name,'seed':seed,'primaries':primary,'sigma':sigma,
                            'strength':strength,'high':not nominal,'weak':stage == 'weak-stress',
                            'fresh':stage == 'fresh-nominal'}


COLOR_SCENES = tuple(f'color-{axis}-period-{period}' for axis in ('a','b') for period in (2,4))


def scene(model, name, seed, primaries, sigma=.012, strength=50, high=False, weak=False, fresh=False, controls=None, cohort=None):
    if name not in COLOR_SCENES:
        return legacy_scene(model,name,seed,primaries,sigma,strength,high,weak,fresh,controls,cohort)
    width,height = (136,136) if high else (32,24)
    axis = 1 if name.split('-')[1] == 'a' else 2
    period = int(name.rsplit('-',1)[1])
    amplitude = (.024 if period == 2 else .03) if not high or weak else (2*sigma if period == 2 else 2.5*sigma)
    random = model.Noise(seed)
    clean,entering,variance = [],[],[]
    for y in range(height):
        for x in range(width):
            values = [1.0,.08,-.04]
            pattern = (-1 if x % 2 else 1) if period == 2 else math.sin(2*math.pi*x/period)
            values[axis] += amplitude*pattern
            clean.append([model.f32(v) for v in model.decode(values,model.LUMINANCE[primaries])])
            # Same three-draw native row-major schedule as original scenes.
            nl,na,nb = random.normal(),random.normal(),random.normal()
            noisy = [values[0],values[1]+sigma*na,values[2]+sigma*nb]
            entering.append([model.f32(v) for v in model.decode(noisy,model.LUMINANCE[primaries])])
            variance.append([0.0,sigma*sigma,sigma*sigma])
    return {'name':name,'seed':seed,'sigma':sigma,'strength':strength,'primaries':primaries,
        'width':width,'height':height,'luminance':0 if controls is None else controls[0],
        'chroma':strength if controls is None else controls[1], 'clean':clean,'entering':entering,
        'oracleVariance':variance,'stars':[], 'cohort':cohort or ('high-weak-stress' if weak else 'high-required' if high else 'fresh-nominal-required' if fresh else 'nominal-required')}


def evaluate(model, case, output):
    result = legacy_evaluate(model,case,output)
    if case['name'] not in COLOR_SCENES:
        return result
    w,h = case['width'],case['height']
    component = 1 if case['name'].split('-')[1] == 'a' else 2
    period = int(case['name'].rsplit('-',1)[1])
    indices = [y*w+x for y in range(4,h-4) for x in range(4,w-4)]
    pattern = [(-1 if i%w%2 else 1) if period == 2 else math.sin(2*math.pi*(i%w)/period) for i in indices]
    def amplitude(pixels):
        f = [model.encode(p,model.LUMINANCE[case['primaries']]) for p in pixels]
        mean = math.fsum(f[i][component] for i in indices)/len(indices)
        return math.fsum((f[i][component]-mean)*p for i,p in zip(indices,pattern))/math.fsum(p*p for p in pattern)
    result['textureComponent'] = component
    result['textureRetention'] = amplitude(output)/amplitude(case['clean'])
    result['gates']['texture'] = .90 <= result['textureRetention'] <= 1.05
    return result
