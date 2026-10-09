"""Translate the unmodified CTL into an independent Float64 C++ reference.

This test-only adapter does not read or import any generated/application math.
Usage: python3 scripts/aces-reference.py output.cpp
Compile with a C++17 compiler, then send peak, gamut (0=sRGB, 1=P3), AP0 RGB
samples on stdin. The output is relative linear limiting RGB before white limiting.
"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
lib = root / 'third_party/aces-core/lib'
text = '\n'.join((lib / name).read_text() for name in [
    'Lib.Academy.Utilities.ctl', 'Lib.Academy.Tonescale.ctl', 'Lib.Academy.OutputTransform.ctl'])
text = re.sub(r'/\*.*?\*/|//[^\n]*', '', text, flags=re.S)
# The trailing CTL debug helpers need no C++ implementation.
util_end = text.index('void print_f2')
ts_start = text.index('struct TSParams')
text = text[:util_end] + text[ts_start:]
text = re.sub(r'\bunsigned int\b', 'int', text)
text = re.sub(r'\bfloat\b', 'double', text)
text = re.sub(r'\binput\s+', '', text)
text = text.replace('.size', '.size()')
text = re.sub(r'\b(min|max|round|copysign|ceil|log2)\b', r'ctl_\1', text)
text = re.sub(r'\bin\b', 'inputValue', text)


def array_type(dims, kind='double'):
    t = kind
    for d in reversed(re.findall(r'\[([^\]]*)\]', dims)):
        t = f'std::array<{t},{d or "totalTableSize"}>'
    return t


# Convert array return types and declarations; std::array supplies CTL value semantics.
text = re.sub(r'(double|int)((?:\[[^\]]*\])+)', lambda m: array_type(m[2],m[1]), text)
pattern = re.compile(r'(output\s+)?(double|int)\s+(\w+)((?:\[[^\]]*\])+)', re.S)


def declaration(m):
    output,kind,name,dims = m.groups()
    return array_type(dims,kind) + (' &' if output else ' ') + name


text = pattern.sub(declaration, text)
pos=0
while (match:=re.search(r'std::array<std::array<[^;=]+>\s+\w+\s*=\s*\{',text[pos:])):
    start=pos+match.end()-1
    end=start+1
    depth=1
    while depth:
        if text[end]=='{':depth+=1
        elif text[end]=='}':depth-=1
        end+=1
    text=text[:start]+'{'+text[start:end]+'}'+text[end:]
    pos=end+2
text = re.sub(r'\boutput\s+(\w+)\s+(\w+)', r'\1 &\2', text)
# CTL initializes locals and struct members to zero; C++ requires explicit initialization.
text = re.sub(r'((?:std::array<[^;=\n]+>|double|int|bool|TSParams|JMhParams|ODTParams|HueDependentGamutParams)\s+\w+)\s*;', r'\1{};', text)
# The single parameter table[][3] uses nested types; constants are declared before functions.
prefix = r'''
#include <array>
#include <cmath>
#include <iostream>
#include <iomanip>
constexpr int totalTableSize=362;
constexpr double M_PI_VALUE=3.14159265358979323846;
using V=std::array<double,3>;
using M=std::array<V,3>;
struct Chromaticities {std::array<double,2> red,green,blue,white;};
double ctl_min(double a,double b){return a<b?a:b;}
double ctl_max(double a,double b){return a>b?a:b;}
double ctl_round(double a);
double ctl_copysign(double a,double b);
double pow10(double x){return pow(10.,x);}
M invert_f33(M a) {
  M out{};
  const double d=a[0][0]*(a[1][1]*a[2][2]-a[1][2]*a[2][1])-a[0][1]*(a[1][0]*a[2][2]-a[1][2]*a[2][0])+a[0][2]*(a[1][0]*a[2][1]-a[1][1]*a[2][0]);
  for(int r=0;r<3;r++)for(int c=0;c<3;c++)out[c][r]=(a[(r+1)%3][(c+1)%3]*a[(r+2)%3][(c+2)%3]-a[(r+1)%3][(c+2)%3]*a[(r+2)%3][(c+1)%3])/d;
  return out;
}
V mult_f3_f33(V v,M m){V o{};for(int c=0;c<3;c++)for(int r=0;r<3;r++)o[c]+=v[r]*m[r][c];return o;}
V mult_f_f3(double s,V v){for(auto &x:v)x*=s;return v;}
M mult_f_f33(double s,M m){for(auto &r:m)r=mult_f_f3(s,r);return m;}
M mult_f33_f33(M a,M b){for(auto &r:a)r=mult_f3_f33(r,b);return a;}
'''
# min/max are already supplied above and must not be defined twice.
text = re.sub(r'double ctl_(?:min|max)\([^}]+\}', '', text)
text = re.sub(r'const int totalTableSize\s*=\s*[^;]+;', '', text)
colors=(lib/'Lib.Academy.ColorSpaces.ctl').read_text()
colors=colors[:colors.index('float[3][3] calculate_rgb_to_rgb_matrix')]
colors=re.sub(r'/\*.*?\*/|//[^\n]*','',colors,flags=re.S)
colors=re.sub(r'\bfloat\b','double',colors)
colors=re.sub(r'input varying\s+','',colors)
colors=re.sub(r'double((?:\[[^\]]*\])+)',lambda m:array_type(m[1]),colors)
colors=pattern.sub(declaration,colors)
colors=re.sub(r'\b(max|min)\b',r'ctl_\1',colors)
pos=0
while (match:=re.search(r'std::array<std::array<[^;=]+>\s+\w+\s*=\s*\{',colors[pos:])):
    start=pos+match.end()-1;end=start+1;depth=1
    while depth:
        if colors[end]=='{':depth+=1
        elif colors[end]=='}':depth-=1
        end+=1
    colors=colors[:start]+'{'+colors[start:end]+'}'+colors[end:];pos=end+2
suffix = r'''
int main() {
 double peak,r,g,b; int gamut;
 double previous=-1;int previousGamut=-1;ODTParams p{};
 const Chromaticities rec2020{{.708,.292},{.17,.797},{.131,.046},{.3127,.329}};
 const M input_matrix=mult_f33_f33(RGBtoXYZ_f33(rec2020,1.),mult_f33_f33(calculate_cat_matrix(rec2020.white,AP0.white),AP0_XYZ_TO_RGB));
 while(std::cin>>peak>>gamut>>r>>g>>b) {
   if(peak!=previous||gamut!=previousGamut){
     Chromaticities pri=gamut==2?rec2020:gamut==1?Chromaticities{{.68,.32},{.265,.69},{.15,.06},{.3127,.329}}:Chromaticities{{.64,.33},{.3,.6},{.15,.06},{.3127,.329}};
     p=init_ODTParams(peak,pri);previous=peak;previousGamut=gamut;
   }
   auto result=outputTransform_fwd(mult_f3_f33({r,g,b},input_matrix),p);
   std::cout<<std::setprecision(17)<<result[0]<<' '<<result[1]<<' '<<result[2]<<'\n';
 }
}
'''
Path(sys.argv[1]).write_text(prefix + text + colors + suffix)
