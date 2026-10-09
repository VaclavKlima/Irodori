"""Generate the forward TypeScript/WGSL ports of the pinned ACES 2 CTL.

Run: python3 scripts/generate-aces.py
The vendored CTL is authoritative. No coefficient fitting or image LUTs are used.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIB = ROOT / 'third_party/aces-core/lib'


def clean(text):
    return re.sub(r'/\*.*?\*/|//[^\n]*', '', text, flags=re.S)


def blocks(text):
    """Read CTL's top-level declarations without altering their expressions."""
    result = []
    start = 0
    depth = 0
    for i, c in enumerate(text):
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0 and (')' in text[start:i].split('{')[0] or text[start:i].lstrip().startswith('struct ')):
                result.append(text[start:i + 1].strip())
                start = i + 1
        elif c == ';' and depth == 0:
            if text[start:i].strip():
                result.append(text[start:i + 1].strip())
            start = i + 1
    return result


source = '\n'.join((LIB / name).read_text() for name in [
    'Lib.Academy.Tonescale.ctl', 'Lib.Academy.OutputTransform.ctl',
    'Lib.Academy.Utilities.ctl'])
items = blocks(clean(source))
structs = {}
functions = {}
constants = []
for item in items:
    if item.startswith('struct '):
        name = item.split()[1]
        structs[name] = item[item.index('{') + 1:item.rindex('}')].strip()
    elif re.match(r'(?:float|int|bool|void|\w+Params)(?:\[[^\]]*\])*\s+\w+\s*\(', item):
        m = re.match(r'(\w+)((?:\[[^\]]*\])*)\s+(\w+)\s*\((.*?)\)\s*\{(.*)\}', item, re.S)
        if m:
            kind, dims, name, args, body = m.groups()
            functions[name] = (kind, dims, args.strip(), body)
    elif item.startswith('const '):
        constants.append(item)

type_pattern = r'(float|int|unsigned int|bool|Chromaticities|TSParams|JMhParams|ODTParams|HueDependentGamutParams)'
declaration = re.compile(r'\b(const\s+)?' + type_pattern + r'\s+(\w+)((?:\[[^\]]*\])*)\s*(?:=\s*([^;]*))?;')
argument = re.compile(r'(?:(input|output)\s+)?' + type_pattern + r'\s+(\w+)((?:\[[^\]]*\])*)(?:\s*=\s*(.*))?$')


def dimensions(s):
    return re.findall(r'\[([^\]]*)\]', s)


def ts_type(kind, dims):
    return {'float': 'number', 'int': 'number', 'unsigned int': 'number', 'bool': 'boolean'}.get(kind, kind) + '[]' * len(dims)


def zero(kind, dims):
    if dims:
        return f'Array.from({{length:{dims[0]}}},()=>{zero(kind, dims[1:])})'
    return 'false' if kind == 'bool' else '0' if kind in ['float', 'int', 'unsigned int'] else f'new{kind}()'


def ts_expr(expr):
    expr = re.sub(r'(?<![.\w])(pow|sqrt|log|log10|cos|sin|atan2|floor|min|max)\(', r'Math.\1(', expr)
    expr = re.sub(r'\bfabs\(', 'Math.abs(', expr)
    expr = re.sub(r'\bround\(', 'roundCtl(', expr)
    expr = re.sub(r'(\w+)\.size\b', r'\1.length', expr)
    expr = expr.replace(' & ', ' && ')
    return expr


helpers = '''
export interface Chromaticities { red:number[]; green:number[]; blue:number[]; white:number[] }
const M_PI=Math.PI;
const roundCtl=(x:number)=>Math.trunc(x+(x<0?-.5:.5));
const fmod=(x:number,y:number)=>x%y;
// CTL copysign uses sign(0)=0, unlike C's copysign.
const copysign=(x:number,y:number)=>Math.sign(y)*Math.abs(x);
// Scratch vectors are leased only for a synchronous pixel evaluation; prepared tables own arrays.
const scratch=Array.from({length:256},()=>[0,0,0]);let scratchCursor=-1;
export function beginAcesPixel(){scratchCursor=0;}
export function endAcesPixel(){scratchCursor=-1;}
function acesVec(a:number,b:number,c:number):number[] {
  if(scratchCursor<0)return [a,b,c];
  const v=scratch[scratchCursor++];if(!v)throw new Error('ACES scratch bound exceeded.');
  v[0]=a;v[1]=b;v[2]=c;return v;
}
const acesCopy=(v:number[])=>acesVec(v[0],v[1],v[2]);
const mult_f3_f33=(v:number[],m:number[][])=>acesVec(v[0]*m[0][0]+v[1]*m[1][0]+v[2]*m[2][0],v[0]*m[0][1]+v[1]*m[1][1]+v[2]*m[2][1],v[0]*m[0][2]+v[1]*m[1][2]+v[2]*m[2][2]);
const mult_f_f3=(s:number,v:number[])=>acesVec(s*v[0],s*v[1],s*v[2]);
const mult_f_f33=(s:number,m:number[][])=>m.map(r=>r.map(x=>s*x));
const mult_f33_f33=(a:number[][],b:number[][])=>a.map(r=>mult_f3_f33(r,b));
function invert_f33(m:number[][]):number[][] {
  const [a,b,c]=m;
  const det=a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);
  return [[b[1]*c[2]-b[2]*c[1],a[2]*c[1]-a[1]*c[2],a[1]*b[2]-a[2]*b[1]],
    [b[2]*c[0]-b[0]*c[2],a[0]*c[2]-a[2]*c[0],a[2]*b[0]-a[0]*b[2]],
    [b[0]*c[1]-b[1]*c[0],a[1]*c[0]-a[0]*c[1],a[0]*b[1]-a[1]*b[0]]].map(r=>r.map(x=>x/det));
}
'''

roots = ['init_ODTParams', 'outputTransform_fwd', 'RGBtoXYZ_f33', 'XYZtoRGB_f33']
selected = set()


def visit(name):
    if name in selected or name not in functions:
        return
    selected.add(name)
    for call in re.findall(r'\b(\w+)\s*\(', functions[name][3]):
        if call not in ['min', 'max', 'round', 'copysign']:
            visit(call)


for root in roots:
    visit(root)


def ts_declarations(body, symbols):
    def convert(m):
        const, kind, name, dim_text, value = m.groups()
        dims = dimensions(dim_text)
        symbols[name] = (kind, dims)
        if value is None:
            value = zero(kind, dims)
        elif kind == 'Chromaticities':
            values = re.findall(r'\{([^{}]*)\}', value)
            if values:
                value = '{' + ','.join(k + ':[' + v + ']' for k, v in zip(['red', 'green', 'blue', 'white'], values)) + '}'
        elif dims:
            if value.strip().startswith('{'):
                value = value.replace('{', '[').replace('}', ']')
            else:
                value = f'({value}).slice()' if len(dims) == 1 else f'({value}).map(r=>r.slice())'
        elif kind in ['int', 'unsigned int']:
            value = f'Math.trunc({value})'
        return f'{"const" if const else "let"} {name}:{ts_type(kind, dims)} = {ts_expr(value)};'
    body = declaration.sub(convert, body)
    body = re.sub(r'\bint\s+(\w+)\s*=\s*([^;]+);', lambda m: f'let {m[1]}=Math.trunc({m[2]});', body)
    return body


pixel=set()
def pixel_visit(name):
    if name in pixel or name not in functions:return
    pixel.add(name)
    for call in re.findall(r'\b(\w+)\s*\(',functions[name][3]):
        if call not in ['min','max','round','copysign']:pixel_visit(call)
pixel_visit('outputTransform_fwd')

def pooled_vectors(body):
    # Preserve CTL value semantics while reusing bounded, synchronous pixel scratch.
    body=body.replace('Array.from({length:3},()=>0)','acesVec(0,0,0)')
    body=re.sub(r'\(([^;\n]*?)\)\.slice\(\)',r'acesCopy(\1)',body)
    position=0
    while (m:=re.search(r'(?:=|return)\s*\[',body[position:])):
        start=position+m.end()-1;depth=1;end=start+1
        while depth:
            if body[end]=='[':depth+=1
            elif body[end]==']':depth-=1
            end+=1
        value=body[start+1:end-1];args=[];base=0;level=0
        for i,c in enumerate(value):
            if c in '([':level+=1
            elif c in ')]':level-=1
            elif c==',' and level==0:args.append(value[base:i]);base=i+1
        args.append(value[base:])
        if len(args)==3:
            replacement='acesVec('+','.join(args)+')';body=body[:start]+replacement+body[end:];position=start+len(replacement)
        else:position=end
    return body

ts = helpers
fields = {}
for name, body in structs.items():
    if name == 'TestData':
        continue
    declarations = list(declaration.finditer(body))
    ts += f'export interface {name} {{' + '\n'.join(f'{m[3]}:{ts_type(m[2], dimensions(m[4]))};' for m in declarations) + '}\n'
    ts += f'function new{name}():{name} {{ return {{' + ','.join(f'{m[3]}:{zero(m[2], dimensions(m[4]))}' for m in declarations) + '}; }\n'
    for m in declarations:
        fields[m[3]] = (m[2], dimensions(m[4]))

for item in constants:
    # Unused constants in the inverse path are harmless exports in generated code.
    ts += ts_declarations(item, {}).replace('const ', 'export const ', 1) + '\n'

for name, (kind, dims, args, body) in functions.items():
    if name not in selected:
        continue
    symbols = {}
    parameters = []
    for arg in args.split(',') if args else []:
        m = argument.fullmatch(arg.strip())
        if not m:
            raise ValueError(arg)
        direction, arg_kind, arg_name, arg_dims, default = m.groups()
        symbols[arg_name] = (arg_kind, dimensions(arg_dims))
        parameters.append(f'{arg_name}:{ts_type(arg_kind, dimensions(arg_dims))}' + (f'={default}' if default else ''))
    body = ts_declarations(body, symbols)
    # Preserve CTL value-array assignments, including the wrapped table rows.
    def assignment(m):
        lhs, rhs = m.groups()
        base = lhs.split('[')[0]
        var = base.split('.')[-1]
        info = fields.get(var) if '.' in base else symbols.get(var)
        if info:
            t, d = info
            remaining = len(d) - lhs.count('[')
            if remaining > 0 and not rhs.strip().startswith('['):
                rhs = f'({rhs}).slice()' if remaining == 1 else f'({rhs}).map(r=>r.slice())'
            elif remaining == 0 and t in ['int', 'unsigned int']:
                rhs = f'Math.trunc({rhs})'
        return f'{lhs} = {rhs};'
    body = re.sub(r'(?<![:\w])([\w.]+(?:\[[^\]\n]+\])*)\s*=(?![=>])\s*([^;{}\n]+);', assignment, body)
    # Float -> integer assignments inside loops are also explicit in JS.
    for unused in ['raw_idx', 'i_float']:
        body = re.sub(r'\s*(?:const|let) ' + unused + r':number\s*=\s*[^;]+;', '', body)
    for unused in ['invert', 'h_hi']:
        if any(arg.startswith(unused + ':') for arg in parameters) and not re.search(r'\b' + unused + r'\b', body):
            body = 'void _' + unused + ';\n' + body
            parameters = [re.sub(r'^' + unused + ':', '_' + unused + ':', arg) for arg in parameters]
    if name in pixel:body=pooled_vectors(body)
    ts += re.sub(r'\bin\b', 'inputValue', f'export function {name}({",".join(parameters)}):{ts_type(kind, dimensions(dims))} {{\n{ts_expr(body)}\n}}\n')

header = '// SPDX-License-Identifier: Apache-2.0\n// Copyright Contributors to the ACES Project.\n// Generated by scripts/generate-aces.py from pinned CTL; do not edit.\n'
(ROOT / 'src/shared/aces-core.ts').write_text(header + '// CTL declarations/initialization are retained for auditable correspondence.\n/* eslint-disable prefer-const, no-useless-assignment */\n' + ts)

# WGSL needs only per-pixel forward functions. Target preparation stays in workers.
pixel = set()


def pixel_visit(name):
    if name in pixel or name not in functions:
        return
    pixel.add(name)
    for call in re.findall(r'\b(\w+)\s*\(', functions[name][3]):
        if call not in ['min', 'max', 'round', 'copysign']:
            pixel_visit(call)


pixel_visit('outputTransform_fwd')


def wg_type(kind, dims):
    if dims == ['3', '3']:
        return 'mat3x3f'
    if dims == ['3']:
        return 'vec3f'
    if dims == ['2']:
        return 'vec2i' if kind == 'int' else 'vec2f'
    base = {'float': 'f32', 'int': 'i32', 'unsigned int': 'i32', 'bool': 'bool'}.get(kind, kind)
    for d in reversed(dims):
        base = f'array<{base},{d or "362"}>'
    return base


wg = '''// Compensated scalar products reduce cancellation near the gamut boundary.
// frexp/ldexp form a rounding boundary on fast-math Metal backends.
fn acesRound(v:f32)->f32 {let p=frexp(v);return ldexp(p.fract,p.exp);}
fn acesSum(a:f32,b:f32)->vec2f {let s=acesRound(a+b);let z=acesRound(s-a);return vec2f(s,acesRound(a-acesRound(s-z))+acesRound(b-z));}
fn acesDot(a:vec3f,b:vec3f)->f32 {
  let p=a*b; let e=fma(a,b,-p);
  let s=acesSum(p.x,p.y);let t=acesSum(s.x,p.z);
  return t.x+(s.y+t.y+e.x+e.y+e.z);
}
fn mult_f3_f33(v:vec3f,m:mat3x3f)->vec3f {
  return vec3f(acesDot(v,vec3f(m[0].x,m[1].x,m[2].x)),acesDot(v,vec3f(m[0].y,m[1].y,m[2].y)),acesDot(v,vec3f(m[0].z,m[1].z,m[2].z)));
}
fn clamp_f3(v:vec3f,lo:f32,hi:f32)->vec3f {return clamp(v,vec3f(lo),vec3f(hi));}
fn lerp(a:f32,b:f32,t:f32)->f32 {return a+t*(b-a);}
fn copysign(x:f32,y:f32)->f32 {return sign(y)*abs(x);}
fn degrees_to_radians(v:f32)->f32 {return v/180.*3.141592653589793;}
fn radians_to_degrees(v:f32)->f32 {return dsValue(dsMul(ds(v),vec2f(57.29577951308232,-6.688024427603523e-7)));}
fn acesLog10(v:f32)->f32 {return log(v)/log(10.);}
'''
provided = ['mult_f3_f33', 'clamp_f3', 'clamp', 'lerp', 'copysign', 'degrees_to_radians', 'radians_to_degrees']

# Target data is a bounded storage buffer of vec4s. Accessors remove giant
# by-value ODT structs from pixel functions while retaining the reference equations.
offsets = {}
cursor = 0


def field_access(prefix, kind, dims):
    global cursor
    start = cursor
    if kind in structs:
        for m in declaration.finditer(structs[kind]):
            field_access(prefix + '.' + m[3], m[2], dimensions(m[4]))
        return
    offsets[prefix] = (start, kind, dims)
    count = 3 if dims == ['3', '3'] else int(dims[0].replace('totalTableSize', '362')) if dims else 1
    cursor += count


for m in declaration.finditer(structs['ODTParams']):
    field_access('p.' + m[3], m[2], dimensions(m[4]))

low_offsets = {}
for key, (_, kind, dims) in offsets.items():
    if key.startswith(('p.input_params.', 'p.reach_params.', 'p.limit_params.')):
        low_offsets[key] = cursor
        cursor += 3 if dims == ['3', '3'] else 1

wg += 'struct AcesData { values:array<vec4f,' + str(cursor) + '> }\n@group(0) @binding(4) var<storage,read> acesData:AcesData;\n'


def wg_access(name):
    offset, kind, dims = offsets[name]
    if dims == ['3', '3']:
        return f'mat3x3f(acesData.values[{offset}].xyz,acesData.values[{offset+1}].xyz,acesData.values[{offset+2}].xyz)'
    if dims == ['2']:
        return f'vec2i(acesData.values[{offset}].xy)'
    return f'acesData.values[{offset}].x'


def low_access(key):
    offset = low_offsets[key]
    if offsets[key][2] == ['3', '3']:
        return f'mat3x3f(acesData.values[{offset}].xyz,acesData.values[{offset+1}].xyz,acesData.values[{offset+2}].xyz)'
    return f'acesData.values[{offset}].x'

for name in ['input_params', 'limit_params']:
    wg += f'fn aces_{name}()->JMhParams {{ return JMhParams(' + ','.join(wg_access('p.' + name + '.' + m[3]) for m in declaration.finditer(structs['JMhParams'])) + ',' + ','.join(low_access('p.' + name + '.' + m[3]) for m in declaration.finditer(structs['JMhParams'])) + '); }\n'
wg += 'fn aces_ts()->TSParams { return TSParams(' + ','.join(wg_access('p.ts.' + m[3]) for m in declaration.finditer(structs['TSParams'])) + '); }\n'

for name in ['TSParams', 'JMhParams', 'HueDependentGamutParams']:
    fields = [f'{m[3]}:{wg_type(m[2], dimensions(m[4]))}' for m in declaration.finditer(structs[name])]
    if name == 'JMhParams':
        fields += [f'{m[3]}_lo:{wg_type(m[2], dimensions(m[4]))}' for m in declaration.finditer(structs[name])]
    wg += f'struct {name} {{' + ',\n'.join(fields) + '}\n'

for item in constants:
    if any(key in item for key in ['Chromaticities', 'XYZtoRGB', 'RGBtoXYZ', 'mult_f33']):
        continue
    m = declaration.fullmatch(item)
    if m and m[5] and not dimensions(m[4]):
        wg += f'const {m[3]}:{wg_type(m[2], [])}={m[5]};\n'
    elif m and m[3] == 'surround':
        wg += 'const surround=vec3f(.9,.59,.9);\n'
    elif 'MATRIX_IDENTITY' in item:
        pass
# AP0/AP1 matrices are compile-time constants from the CPU's chromaticities.
wg += '${acesMatrices}\n'


def wg_expr(expr):
    expr = re.sub(r'\bfabs\(', 'abs(', expr)
    expr = re.sub(r'\bpow\(', 'acesPow(', expr)
    expr = re.sub(r'\blog10\(', 'acesLog10(', expr)
    expr = expr.replace('fmod(hue, 360.)', '(hue % 360.)')
    expr = expr.replace('gamma_table.size', '362')
    expr = expr.replace(' & ', ' && ')
    return expr


for name, (kind, dims, args, body) in functions.items():
    if name not in pixel or name in provided or name in ['RGB_to_Aab', 'Aab_to_RGB', 'Y_to_J', 'J_to_Y', 'Aab_to_JMh', 'JMh_to_Aab', 'solve_J_intersect']:
        continue
    parameters = []
    symbols = {}
    for arg in args.split(',') if args else []:
        direction, k, n, d, default = argument.fullmatch(arg.strip()).groups()
        if k == 'ODTParams' or n in ['table', 'hue_table', 'hue_linearity_search_range', 'invert']:
            continue
        symbols[n] = (k, dimensions(d))
        parameters.append(f'{n}:{wg_type(k, dimensions(d))}')
    # Default invert=false is the only path used by forward rendering.
    body = re.sub(r'\binvert\b', 'false', body)
    # Table access uses the prepared storage data, without copying table arrays.
    table_names = {'table': 'TABLE_gamut_cusps' if name == 'cusp_from_table' else 'TABLE_reach_M', 'hue_table': 'TABLE_hues'}
    for n, field in table_names.items():
        base = offsets['p.' + field][0]
        body = re.sub(r'\b' + n + r'\[([^\]]*)\]', lambda m: f'acesData.values[{base}+{m[1]}]' + ('.xyz' if field == 'TABLE_gamut_cusps' else '.x'), body)
    body = body.replace('hue_linearity_search_range', wg_access('p.hue_linearity_search_range'))
    for field in ['TABLE_upper_hull_gamma', 'TABLE_hues']:
        base = offsets['p.' + field][0]
        body = re.sub(r'p\.' + field + r'\[([^\]]*)\]', lambda m: f'acesData.values[{base}+{m[1]}].x', body)
    for field in ['input_params', 'limit_params', 'ts']:
        body = re.sub(r'p\.' + field + r'\b', 'aces_' + field + '()', body)
    # Filter calls by their declared argument types, including nested calls.
    def filter_calls(text):
        pattern = re.compile(r'\b(\w+)\s*\(')
        out = ''
        pos = 0
        while (match := pattern.search(text, pos)):
            out += text[pos:match.end()]
            start = match.end()
            depth = 1
            end = start
            while depth:
                if text[end] == '(':
                    depth += 1
                elif text[end] == ')':
                    depth -= 1
                end += 1
            raw_args = text[start:end - 1]
            args = []
            base = 0
            level = 0
            for idx, c in enumerate(raw_args):
                if c == '(':
                    level += 1
                elif c == ')':
                    level -= 1
                elif c == ',' and level == 0:
                    args.append(raw_args[base:idx])
                    base = idx + 1
            args.append(raw_args[base:])
            fn = match[1]
            if fn in functions:
                declared = [argument.fullmatch(arg.strip()).groups() for arg in functions[fn][2].split(',')]
                remove = [i for i, (_, k, n, _, _) in enumerate(declared) if k == 'ODTParams' or n in ['table', 'hue_table', 'hue_linearity_search_range', 'invert']]
                args = [arg for i, arg in enumerate(args) if i not in remove]
            out += ','.join(filter_calls(arg) for arg in args) + ')'
            pos = end
        return out + text[pos:]
    body = filter_calls(body)
    for key, (offset, k, d) in sorted(offsets.items(), key=lambda x: -len(x[0])):
        if not d:
            body = re.sub(re.escape(key) + r'\b', wg_access(key), body)
    def local(m):
        const, k, n, d, value = m.groups()
        ds = dimensions(d)
        symbols[n] = (k, ds)
        t = wg_type(k, ds)
        if value is not None:
            if ds:
                value = value.replace('{', t + '(').replace('}', ')')
            elif k in ['int', 'unsigned int']:
                value = f'i32({value})'
            return f'var {n}:{t}={value};'
        return f'var {n}:{t};'
    body = declaration.sub(local, body)
    body = re.sub(r'(if\s*\([^\n]+\))\s*(return[^;]+;)', r'\1 { \2 }', body)
    def cast_assignment(m):
        n, expr = m.groups()
        if symbols.get(n, ('',))[0] in ['int', 'unsigned int']:
            expr = f'i32({expr})'
        return f'{n}={expr};'
    body = re.sub(r'(?<![:\w.])(\w+)\s*=\s*([^;{}\n]+);', cast_assignment, body)
    body = body.replace('int ', 'var ')
    # CTL freely promotes integers in scalar float expressions; WGSL does not.
    if name == 'hue_position_in_uniform_table':
        body = body.replace('* table_size', '* f32(table_size)')
    if name == 'reach_M_from_table':
        body = body.replace('h - base', 'h - f32(base)')
    body = body.replace('midpoint(low_i, high_i)', '(low_i+high_i)/2')
    body = body.replace('midpoint(i_lo, i_hi)', '(i_lo+i_hi)/2')
    wg += f'fn {name}({",".join(parameters)})->{wg_type(kind, dimensions(dims))} {{\n{wg_expr(body)}\n}}\n'

wg += (ROOT / 'scripts/aces-precision.wgsl').read_text()

# Matrices are filled by the generated CPU port, not independently tuned.
wg_header = header + "import { AP0_TO_AP1, AP1_TO_AP0 } from './aces-core'\nconst matrix=(m:number[][])=>'mat3x3f('+m.map(r=>'vec3f('+r.map(v=>String(v).includes('.')?String(v):v+'.0').join(',')+')').join(',')+')'\nconst acesMatrices='const AP0_TO_AP1='+matrix(AP0_TO_AP1)+';\\nconst AP1_TO_AP0='+matrix(AP1_TO_AP0)+';'\n"
(ROOT / 'src/shared/aces-wgsl.ts').write_text(wg_header + 'export const acesWgsl = `\n' + wg + '`\n')

# Storage packing is generated from the same field layout as shader accessors.
packer = header + "import type { ODTParams } from './aces-core'\nexport const ACES_DATA_BYTES=" + str(cursor * 16) + "\nexport function packAces(p:ODTParams):Float32Array<ArrayBuffer> {\n const result=new Float32Array(" + str(cursor * 4) + ");\n"
for key, (offset, kind, dims) in offsets.items():
    if dims == ['3', '3'] or len(dims) == 2:
        packer += f'{key}.forEach((row,i)=>result.set(row,({offset}+i)*4));\n'
    elif dims and dims[0] == 'totalTableSize':
        packer += f'{key}.forEach((v,i)=>result[({offset}+i)*4]=v);\n'
    elif dims:
        packer += f'result.set({key},{offset}*4);\n'
    else:
        packer += f'result[{offset}*4]={key};\n'
for key, offset in low_offsets.items():
    if offsets[key][2] == ['3', '3']:
        packer += f'{key}.forEach((row,i)=>result.set(row.map(v=>v-Math.fround(v)),({offset}+i)*4));\n'
    else:
        packer += f'result[{offset}*4]={key}-Math.fround({key});\n'
packer += 'return result;\n}\n'
(ROOT / 'src/shared/aces-data.ts').write_text(packer)
