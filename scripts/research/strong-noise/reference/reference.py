#!/usr/bin/env python3
"""CC0-1.0 independent Decimal80 direct-patch reference draft for Comparison 7.

Prepared only: do not execute until the parent freezes the candidate equations,
input plan and generator hashes. No application/candidate code is imported.
Global feature variance is a separate frozen input, never estimated here.
"""

from argparse import ArgumentParser
from decimal import Decimal, localcontext
from functools import lru_cache
from hashlib import sha256
import json
from pathlib import Path
import struct

D = Decimal
ZERO, ONE, K = D(0), D(1), D("0.18")
ROOT = Path(__file__).resolve().parent
OUTPUT_ROOT = ROOT.parents[3] / "artifacts/detail-research/strong-noise/reference"
PRIMARY_XY = {
    "srgb": [[".64", ".33"], [".30", ".60"], [".15", ".06"]],
    "rec2020": [[".708", ".292"], [".170", ".797"], [".131", ".046"]],
}


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def luminance_coefficients(name):
    """Solve primary gains against D65; no Irodori matrix constants."""
    columns = []
    for xs, ys in PRIMARY_XY[name]:
        x, y = D(xs), D(ys)
        columns.append([x / y, ONE, (ONE - x - y) / y])
    wx, wy = D(".3127"), D(".3290")
    white = [wx / wy, ONE, (ONE - wx - wy) / wy]
    rows = [[columns[c][r] for c in range(3)] + [white[r]] for r in range(3)]
    for c in range(3):
        pivot = max(range(c, 3), key=lambda r: abs(rows[r][c]))
        rows[c], rows[pivot] = rows[pivot], rows[c]
        divisor = rows[c][c]
        rows[c] = [v / divisor for v in rows[c]]
        for r in range(3):
            if r == c:
                continue
            factor = rows[r][c]
            rows[r] = [a - factor * b for a, b in zip(rows[r], rows[c])]
    # Every unscaled primary's Y entry is exactly one.
    return tuple(rows[r][3] for r in range(3))


def round_even_ratio(numerator, denominator):
    whole, remainder = divmod(numerator, denominator)
    twice = remainder * 2
    return whole + int(twice > denominator or (twice == denominator and whole % 2))


def binary32_word(value):
    """Round Decimal directly to IEEE binary32, retaining negative zero."""
    sign = int(value.is_signed()) << 31
    if not value.is_finite():
        raise ValueError("Nonfinite reference value")
    if not value:
        return sign
    numerator, denominator = abs(value).as_integer_ratio()
    exponent = numerator.bit_length() - denominator.bit_length()
    if exponent >= 0:
        if numerator < (denominator << exponent):
            exponent -= 1
    elif (numerator << -exponent) < denominator:
        exponent -= 1
    shift = 149 if exponent < -126 else 23 - exponent
    if shift >= 0:
        mantissa = round_even_ratio(numerator << shift, denominator)
    else:
        mantissa = round_even_ratio(numerator, denominator << -shift)
    if exponent < -126:
        return sign | mantissa  # 2**23 carries directly into minimum normal.
    if mantissa == 1 << 24:
        exponent += 1
        mantissa >>= 1
    if exponent > 127:
        raise ValueError("Reference exceeds finite binary32")
    return sign | ((exponent + 127) << 23) | (mantissa - (1 << 23))


def word_value(word):
    return struct.unpack("<f", struct.pack("<I", word))[0]


def asinh(value):
    if not value:
        return ZERO
    magnitude = abs(value)
    # Avoid cancellation in ln(1+x) at the extreme tiny-coordinate tail.
    if magnitude < D("1e-28"):
        result = magnitude - magnitude ** 3 / 6
    else:
        result = (magnitude + (ONE + magnitude * magnitude).sqrt()).ln()
    return result.copy_sign(value)


def sinh(value):
    return (value.exp() - (-value).exp()) / 2


def stable_difference(value, scale, delta):
    if not delta:
        return ZERO
    half = sinh(delta / 2)
    return value * 2 * half * half + (value * value + scale * scale).sqrt() * sinh(delta)


def weight_exp(exponent):
    # Omitted tails are below 6e-131, far below the fixed oracle tolerance.
    return ZERO if exponent < -300 else exponent.exp()


def blend(amount):
    return min(ONE, (D(amount) / 50) ** 2)


def recipe_pixel(name, x, y, width, height):
    """Original synthetic inputs; no photographs or application generators."""
    noise = D((17 * x + 11 * y) % 9 - 4) / 1024
    if name == "signed-zero":
        return [D("-0"), ZERO, D("-0"), ONE if (x + y) % 2 else D("-0")]
    if name == "flat":
        return [K, K, K, ONE]
    if name == "one-pixel-hdr":
        return [D(16), D(-4), D(8), ONE]
    if name == "signed-hdr":
        if x == width - 1 and y == height - 1:
            return [D(16), D(16), D(16), ONE]
        return [D(4 * x - 8), D(2 * y - 4), D(x + y - 6), ONE]
    if name == "one-axis":
        return [K + noise, D(".125") - noise / 2, D(".25") + noise / 4, ONE]
    if name == "clamped":
        values = [[".18", ".15", ".12"], [".185", ".152", ".118"],
                  [".176", ".148", ".123"], [".182", ".154", ".119"]]
        return [*map(D, values[y * width + x]), ONE]
    pixel = [K + noise, D(".15") - noise / 2, D(".12") + noise / 4, ONE]
    if name in ("hidden-a", "hidden-b") and (x in (0, width - 1) or y in (0, height - 1)):
        hidden = [16, -8, 4] if name == "hidden-a" else [-32, 64, -16]
        return [*map(D, hidden), ZERO]
    if name == "partial-alpha":
        pixel[3] = [ZERO, D(2) ** -20, D(".25"), D(".5"), ONE][(x + 2 * y) % 5]
    if name not in ("pattern-low", "hidden-a", "hidden-b", "partial-alpha"):
        raise ValueError("Unknown frozen input recipe")
    return pixel


class Scene:
    def __init__(self, spec, primary):
        self.width, self.height = spec["width"], spec["height"]
        self.y_coeff = luminance_coefficients(primary)
        self.variance = tuple(D.from_float(float(v)) for v in spec["frozenVariance"])
        if len(self.variance) != 3 or any(v < 0 or not v.is_finite() for v in self.variance):
            raise ValueError("Invalid frozen feature variance")
        self.words=[]
        alpha_scale=D(spec.get('alphaScale','1'))
        for y in range(self.height):
            for x in range(self.width):
                values=recipe_pixel(spec['recipe'],x,y,self.width,self.height)
                values[3]*=alpha_scale
                self.words.append([binary32_word(v) for v in values])
        self.pixels = [[D.from_float(word_value(word)) for word in p] for p in self.words]

    def index(self, x, y):
        return min(self.height - 1, max(0, y)) * self.width + min(self.width - 1, max(0, x))

    @lru_cache(maxsize=256)
    def coordinates(self, index):
        p = self.pixels[index]
        if not p[3]:
            raise ValueError("Hidden alpha-zero RGB must never enter features")
        y = sum((p[c] * self.y_coeff[c] for c in range(3)), ZERO)
        scale = (y * y + K * K).sqrt()
        return y, scale, (asinh(y / K), asinh((p[0] - y) / scale), asinh((p[2] - y) / scale))

    @lru_cache(maxsize=32)
    def direct_patches(self, x, y):
        """Enumerate every corresponding patch pair; no prefixes/box sums."""
        records = []
        for dy in range(-3, 4):
            for dx in range(-3, 4):
                neighbor = self.index(x + dx, y + dy)
                if not self.pixels[neighbor][3]:
                    continue
                coverage, dl, dc = ZERO, ZERO, ZERO
                bias = [ZERO, ZERO, ZERO]
                identical_coordinates = 0
                for py in range(-1, 2):
                    for px in range(-1, 2):
                        i, j = self.index(x + px, y + py), self.index(x + dx + px, y + dy + py)
                        alpha = self.pixels[i][3] * self.pixels[j][3]
                        if not alpha:
                            continue
                        left, right = self.coordinates(i)[2], self.coordinates(j)[2]
                        differences = [left[c] - right[c] for c in range(3)]
                        coverage += alpha
                        dl += alpha * differences[0] ** 2
                        dc += alpha * (differences[1] ** 2 + differences[2] ** 2)
                        if i != j:
                            for c in range(3):
                                bias[c] += alpha * (self.variance[c] + self.variance[c])
                        else:
                            identical_coordinates += 1
                if not coverage:
                    continue
                raw_l, raw_c = dl / coverage, dc / coverage
                bias = [b / coverage for b in bias]
                corrected_l = max(ZERO, raw_l - bias[0])
                corrected_c = max(ZERO, raw_c - bias[1] - bias[2])
                spatial = weight_exp(-D(dx * dx + dy * dy) / 8) * self.pixels[neighbor][3]
                records.append((neighbor, corrected_l, corrected_c, spatial,
                                raw_l, raw_c, tuple(bias), identical_coordinates, dx, dy))
        return tuple(records)

    @lru_cache(maxsize=256)
    def center_stage(self, x, y, amount_l, amount_c, max_l, max_c):
        """Direct whole-patch estimation; integer binary32 publication per slot."""
        at = self.index(x,y)
        if not self.pixels[at][3] or (not amount_l and not amount_c):
            return tuple([0]*27)
        hl = max_l*(D(amount_l)/100)**2
        hc = max_c*(D(amount_c)/100)**2
        records = []
        for _,dl,dc,spatial,*tail in self.direct_patches(x,y):
            dx,dy = tail[-2:]
            wl = spatial*weight_exp(-dl/hl**2-dc/D('.12')**2) if amount_l else ZERO
            wc = spatial*weight_exp(-dl/D('.08')**2-dc/hc**2) if amount_c else ZERO
            records.append((dx,dy,wl,wc))
        words = []
        for ry in range(-1,2):
            for rx in range(-1,2):
                tx,ty = x+rx,y+ry
                if tx<0 or tx>=self.width or ty<0 or ty>=self.height:
                    words.extend([0,0,0]); continue
                t = ty*self.width+tx
                if not self.pixels[t][3]:
                    words.extend([0,0,0]); continue
                target = self.coordinates(t)[2]
                numerators,weights = [ZERO]*3,[ZERO]*2
                for dx,dy,wl,wc in records:
                    v = self.index(tx+dx,ty+dy)
                    alpha = self.pixels[v][3]
                    if not alpha:
                        continue
                    sample = self.coordinates(v)[2]
                    left,right = wl*alpha,wc*alpha
                    weights[0]+=left; weights[1]+=right
                    numerators[0]+=left*(sample[0]-target[0])
                    numerators[1]+=right*(sample[1]-target[1])
                    numerators[2]+=right*(sample[2]-target[2])
                for component,amount in enumerate((amount_l,amount_c,amount_c)):
                    denominator = weights[0 if component==0 else 1]
                    if amount and not denominator:
                        raise ArithmeticError('Lost positive center normalization')
                    value = numerators[component]/denominator if amount else ZERO
                    words.append(binary32_word(value))
        return tuple(words)

    def point(self, x, y, amount_l, amount_c, max_l, max_c):
        at=self.index(x,y)
        original,original_words=self.pixels[at],self.words[at]
        if not original[3] or (not amount_l and not amount_c):
            return {'x':x,'y':y,'identityCopy':True,
                'inputWords':[f'{w:08x}' for w in original_words],
                'outputWords':[f'{w:08x}' for w in original_words],
                'outputFloat64':[word_value(w) for w in original_words],
                'outputDecimal80':[str(v) for v in original],
                'proposedFeatureDelta':['0','0','0'],'centerStages':[]}
        y_value,scale,feature=self.coordinates(at)
        numerator,denominator=[ZERO]*3,ZERO
        stages=[]
        for ry in range(-1,2):
            for rx in range(-1,2):
                cx,cy=x-rx,y-ry
                if cx<0 or cx>=self.width or cy<0 or cy>=self.height:
                    continue
                c=cy*self.width+cx
                alpha=self.pixels[c][3]
                if not alpha:
                    continue
                words=self.center_stage(cx,cy,amount_l,amount_c,max_l,max_c)
                slot=((ry+1)*3+rx+1)*3
                published=[D.from_float(word_value(w)) for w in words[slot:slot+3]]
                denominator+=alpha
                for component in range(3):numerator[component]+=alpha*published[component]
                stages.append({'center':[cx,cy],'slot':slot,
                    'publishedWords':[f'{w:08x}' for w in words]})
        if not denominator:raise ArithmeticError('Lost positive outer normalization')
        deltas=[v/denominator for v in numerator]
        factors=[blend(amount_l),blend(amount_c),blend(amount_c)]
        for component in range(3):
            if factors[component]!=ONE:deltas[component]*=factors[component]
        maximum=[ZERO]*3
        for dy in range(-3,4):
            for dx in range(-3,4):
                q=self.index(x+dx,y+dy)
                if not self.pixels[q][3]:continue
                values=self.coordinates(q)[2]
                for component in range(3):maximum[component]=max(maximum[component],abs(values[component]-feature[component]))
        bounds=[]
        for component in range(3):
            r=maximum[component]
            bound=factors[component]*(r*(ONE+D(2)**-24)+D(2)**-150) if r else ZERO
            bounds.append(bound)
            if abs(deltas[component])>bound:raise ArithmeticError('Published feature proposal exceeds quantization-aware local bound')
        dl=stable_difference(y_value,K,deltas[0]) if amount_l else ZERO
        da=stable_difference(original[0]-y_value,scale,deltas[1]) if amount_c else ZERO
        db=stable_difference(original[2]-y_value,scale,deltas[2]) if amount_c else ZERO
        if not(dl or da or db):output,words=original[:],original_words[:]
        else:
            output=[original[0]+dl+da,original[1]+dl-(self.y_coeff[0]*da+self.y_coeff[2]*db)/self.y_coeff[1],original[2]+dl+db,original[3]]
            words=[binary32_word(v) for v in output[:3]]+[original_words[3]]
        return {'x':x,'y':y,'identityCopy':not(dl or da or db),
            'inputWords':[f'{w:08x}' for w in original_words],
            'outputWords':[f'{w:08x}' for w in words],
            'outputFloat64':[float(v) for v in output],
            'outputDecimal80':[str(v) for v in output],
            'proposedFeatureDelta':[str(v) for v in deltas],
            'gentleFeatureBounds':[str(v) for v in bounds],
            'normalizationWeight':str(denominator),'centerStages':stages}


def generate(plan):
    scenes = []
    for spec in plan["cases"]:
        cases = []
        input_words = None
        for primary in plan["primaries"]:
            scene = Scene(spec, primary)
            input_words = scene.words
            for ls, cs in plan["controls"]:
                for hl, hc in plan["widthPairs"]:
                    cases.append({"primaries": primary, "luminance": ls, "chroma": cs,
                                  "hLMax": hl, "hCMax": hc,
                                  "points": [scene.point(x, y, ls, cs, D(hl), D(hc))
                                             for x, y in spec["points"]]})
            scene.coordinates.cache_clear()
            scene.center_stage.cache_clear()
            scene.direct_patches.cache_clear()
        source_bytes = b"".join(struct.pack("<4I", *p) for p in input_words)
        scenes.append({"id": spec["id"], "width": spec["width"], "height": spec["height"],
                       "frozenVariance": spec["frozenVariance"],
                       "inputRgba32leHex": source_bytes.hex(), "sourceSha256": sha256(source_bytes).hexdigest(),
                       "cases": cases})
    return scenes


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--approved-freeze", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", action="append")
    parser.add_argument("--width-pair", action="append")
    args = parser.parse_args()
    plan_path = ROOT / "input-plan.json"
    plan = json.loads(plan_path.read_text())
    approval = json.loads(args.approved_freeze.read_text())
    if approval.get("referenceGenerationApproved") is not True:
        raise SystemExit("Reference generation has not been approved by the parent.")
    for key, actual in (("inputPlanSha256", digest(plan_path)),
                        ("generatorSha256", digest(Path(__file__))),
                        ("equationsSha256", sha256(canonical(plan["math"])).hexdigest())):
        if approval.get(key) != actual:
            raise SystemExit(f"Frozen {key} does not match the reviewed artifact.")
    if approval.get("widthPairs") != plan["widthPairs"]:
        raise SystemExit("Frozen candidate width pairs differ.")
    selected=dict(plan)
    if args.case:
        if len(set(args.case))!=len(args.case) or not set(args.case)<={v['id'] for v in plan['cases']}:
            raise SystemExit('Choose distinct declared cases only.')
        selected['cases']=[v for v in plan['cases'] if v['id'] in args.case]
    if args.width_pair:
        choices=[v.split(',') for v in args.width_pair]
        if len({tuple(v) for v in choices})!=len(choices) or any(v not in plan['widthPairs'] for v in choices):
            raise SystemExit('Choose distinct declared comma-separated widthpairs only.')
        selected['widthPairs']=choices
    destination = args.output.resolve()
    if not destination.is_relative_to(OUTPUT_ROOT) or destination.exists():
        raise SystemExit("Choose a new ignored output inside this independent-research folder.")
    with localcontext() as context:
        context.prec = 80
        result = {"version": "comparison-7-independent-decimal80-draft-v1", "license": "CC0-1.0",
                  "precision": 80, "generatorSha256": digest(Path(__file__)),
                  "inputPlanSha256": digest(plan_path), "approvalSha256": digest(args.approved_freeze),
                  "method": "Independently derived primaries, direct patch enumeration and direct IEEE binary32 rounding; no estimator, application or candidate implementation imports.",
                  "selection": {"cases": [v["id"] for v in selected["cases"]], "widthPairs": selected["widthPairs"], "partial": selected != plan},
                  "scenes": generate(selected)}
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
