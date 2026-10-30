#!/usr/bin/env python3
"""CC0-1.0. Independent Hermite-basis Decimal80 reconstruction and chart comparisons."""
from decimal import Decimal, getcontext
from hashlib import sha256
from pathlib import Path
import json
import math
import struct
import sys

getcontext().prec = 80


def f32(value):
    return struct.unpack('f', struct.pack('f', float(value)))[0]


def d(value):
    return Decimal.from_float(float(value))


def hermite_weights(t):
    h00, h10 = (1 + 2*t)*(1-t)**2, t*(1-t)**2
    h01, h11 = t*t*(3-2*t), t*t*(t-1)
    return [-h10/2, h00-h11/2, h01+h10/2, h11/2]


def interpolate(data, x, y):
    ix, iy = math.floor(x), math.floor(y)
    if x == ix and y == iy:
        return data[iy*9+ix]
    fx, fy = d(x)-ix, d(y)-iy
    def pixel(row, col):
        return list(map(d, data[max(0,min(8,row))*9+max(0,min(8,col))]))
    support = [[pixel(iy+j-1, ix+i-1) for i in range(4)] for j in range(4)]
    if all(p[3] == 1 for row in support for p in row):
        wx, wy = hermite_weights(fx), hermite_weights(fy)
        return [float(sum(support[j][i][c]*wx[i]*wy[j] for i in range(4) for j in range(4)))
                for c in range(3)] + [1]
    alpha = Decimal(0)
    rgb = [Decimal(0)]*3
    for j in range(2):
        for i in range(2):
            p = support[j+1][i+1]
            w = (fy if j else 1-fy)*(fx if i else 1-fx)*p[3]
            alpha += w
            rgb = [v + p[c]*w for c,v in enumerate(rgb)]
    if f32(alpha) <= 2**-20:
        return [0,0,0,0]
    return [float(v/alpha) for v in rgb] + [float(alpha)]


scenes = {}
for name in ['ramp', 'quadratic', 'random', 'quadrant', 'transparent-edge', 'alpha-ramp', 'tiny-coverage', 'dark']:
    data = []
    for y in range(9):
        for x in range(9):
            if name == 'ramp':
                pixel = [x/4-1, y/4-0.5, 16+(x+y)/4, 1]
            elif name == 'quadratic':
                pixel = [(x-4)**2/16, (y-4)**2/16, x*y/16-1, 1]
            elif name == 'random':
                pixel = [(((x*1664525+y*1013904223+c*22695477)&0xffffffff)/2**32-0.3)*32 for c in range(3)] + [1]
            elif name == 'quadrant':
                pixel = [int(x>=4 and y>=4), int(x>=4), int(y>=4), 1]
            elif name == 'transparent-edge':
                pixel = [0.1*x, 0.4, 8, 1] if x>=4 else [64, -64, 32, 0]
            elif name == 'alpha-ramp':
                pixel = [-2+x/4, y/8, 16, (x+y)/16]
            elif name == 'tiny-coverage':
                pixel = [-0.1, 0.5, 8, [0, 2**-22, 2**-20, 2**-19, 1][(x+y)%5]]
            else:
                pixel = [1e-12, -1e-12, -0.0, 1]
            data.append(list(map(f32, pixel)))
    scenes[name] = data
positions = [0, 0.125, 0.5, 0.875, 1, 1.3, 4.25, 7.75, 8]
result = {'version': 'crop-filter-decimal80-v1', 'license': 'CC0-1.0', 'precision': 80,
          'generatorSha256': sha256(Path(__file__).read_bytes()).hexdigest(),
          'method': 'Independent four-Hermite-basis interpolation; Float32 source values; Decimal80 sums',
          'scenes': [{'name': name, 'width': 9, 'height': 9, 'data': data,
                      'vectors': [{'x': x, 'y': y, 'output': interpolate(data,x,y)} for y in positions for x in positions]}
                     for name,data in scenes.items()]}


def weights(method, x):
    base = math.floor(x)
    if method == 'bilinear':
        t=x-base
        return [(base,1-t),(base+1,t)]
    if method == 'catmull-rom':
        return [(base+i-1,float(w)) for i,w in enumerate(hermite_weights(d(x)-base))]
    sinc=lambda t: 1 if abs(t)<1e-14 else math.sin(math.pi*t)/(math.pi*t)
    taps=[(i,sinc(x-i)*sinc((x-i)/3)) for i in range(base-2,base+4)]
    total=sum(w for _,w in taps)
    return [(i,w/total) for i,w in taps]


quality=[]
for method in ['bilinear', 'catmull-rom', 'lanczos3']:
    error={}
    for frequency in [0.05,0.15,0.2,0.3]:
        total=0
        for phase in range(64):
            for k in range(64):
                x=k+(phase+0.5)/64
                expected=math.sin(2*math.pi*frequency*x)
                actual=sum(math.sin(2*math.pi*frequency*i)*w for i,w in weights(method,x))
                total+=(actual-expected)**2
        error[str(frequency)]=(total/4096)**0.5
    step=[sum(int(i>=0)*w for i,w in weights(method,-2+j/1024)) for j in range(4097)]
    lo,hi=min(step),max(step)
    diagonal=[]
    impulse=[]
    checker_error=0
    for j in range(33):
        y=-2+j/8
        for i in range(33):
            x=-2+i/8
            wx,wy=weights(method,x),weights(method,y)
            diagonal.append(sum(int(xx+yy>=0)*a*b for xx,a in wx for yy,b in wy))
            impulse.append(sum(int(xx==0 and yy==0)*a*b for xx,a in wx for yy,b in wy))
            checker=sum(((xx+yy)%2)*a*b for xx,a in wx for yy,b in wy)
            analytic=0.5-0.5*math.cos(math.pi*x)*math.cos(math.pi*y)
            checker_error+=(checker-analytic)**2
    quality.append({'method':method,'sinusoidRms':error,'stepOvershoot':max(-lo,hi-1),
                    'quadrantOvershoot':max(-lo*hi,hi*hi-1,lo*lo-1),
                    'diagonalStepOvershoot':max(-min(diagonal),max(diagonal)-1),
                    'impulseRange':[min(impulse),max(impulse)],
                    'analyticCheckerRms':math.sqrt(checker_error/1089)})
result['quality']=quality
Path(sys.argv[1]).write_text(json.dumps(result,indent=2)+'\n')
