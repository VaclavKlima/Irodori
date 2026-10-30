#!/usr/bin/env python3
"""CC0-1.0 Decimal80 oracle for bounded NLM and protected detail sharpening.

No application imports. Derive primary luminance by independent elimination,
enumerate complete patch pairs and convolve two-dimensional Gaussian support.
Each combined stage publishes Float32 before the next operation.
"""
from decimal import Decimal, getcontext
from functools import lru_cache
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import struct
import sys

getcontext().prec = 80
D, K, ZERO, ONE = Decimal, Decimal('0.18'), Decimal(0), Decimal(1)
helper = Path(__file__).with_name('color-reference.py')
spec = importlib.util.spec_from_file_location('detail_decimal_primaries', helper)
primary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(primary)
LUMINANCE = {name: primary.primary_matrix(points)[1] for name, points in primary.PRIMARIES.items()}


def f32(value):
    return struct.unpack('<f', struct.pack('<f', float(value)))[0]


def exp(value):
    # Below 1e-130; its possible contribution is far below Decimal80 fixture precision.
    return ZERO if value < -300 else value.exp()


def asinh(value):
    if value == 0:
        return ZERO
    sign = ONE if value > 0 else -ONE
    x = abs(value)
    return sign * (x + (x*x+1).sqrt()).ln()


def sinh(value):
    return (value.exp() - (-value).exp()) / 2


def changed(value, scale, delta):
    if not delta:
        return ZERO
    return value * 2 * sinh(delta/2)**2 + (value*value+scale*scale).sqrt() * sinh(delta)


class Scene:
    def __init__(self, data, width, height, primaries):
        self.input = data
        self.data = [[D.from_float(v) for v in p] for p in data]
        self.width, self.height, self.y = width, height, LUMINANCE[primaries]
        self.luminance = [sum(a*b for a,b in zip(p[:3],self.y)) for p in self.data]
        self.scale = [(v*v+K*K).sqrt() for v in self.luminance]
        self.features = [[asinh(y/K), asinh((p[0]-y)/s), asinh((p[2]-y)/s)]
                         for p,y,s in zip(self.data,self.luminance,self.scale)]

    def at(self, x, y):
        return max(0,min(self.height-1,y))*self.width+max(0,min(self.width-1,x))

    @lru_cache(maxsize=200)
    def patch_distances(self, x, y):
        values=[]
        for dy in range(-3,4):
            for dx in range(-3,4):
                neighbor=self.at(x+dx,y+dy)
                if not self.data[neighbor][3]:
                    continue
                ld, cd, coverage=ZERO,ZERO,ZERO
                for py in range(-1,2):
                    for px in range(-1,2):
                        a,b=self.at(x+px,y+py),self.at(x+dx+px,y+dy+py)
                        alpha=self.data[a][3]*self.data[b][3]
                        if not alpha:
                            continue
                        differences=[p-q for p,q in zip(self.features[a],self.features[b])]
                        ld+=alpha*differences[0]**2
                        cd+=alpha*(differences[1]**2+differences[2]**2)
                        coverage+=alpha
                if coverage:
                    spatial=exp(-D(dx*dx+dy*dy)/8)*self.data[neighbor][3]
                    values.append((neighbor,ld/coverage,cd/coverage,spatial))
        return values

    def denoise(self, x, y, settings):
        i=self.at(x,y)
        if not self.data[i][3] or settings['luminance']==settings['chroma']==0:
            return self.input[i][:]
        hl=D('0.048')*(D(settings['luminance'])/100)**2
        hc=D('0.16')*(D(settings['chroma'])/100)**2
        ls,aa,bb,lw,cw=ZERO,ZERO,ZERO,ZERO,ZERO
        for j,ld,cd,spatial in self.patch_distances(x,y):
            wl=spatial*exp(-ld/(hl*hl)-cd/D('0.0144')) if hl else ZERO
            wc=spatial*exp(-ld/D('0.0064')-cd/(hc*hc)) if hc else ZERO
            lw+=wl;cw+=wc
            ls+=wl*(self.features[j][0]-self.features[i][0])
            aa+=wc*(self.features[j][1]-self.features[i][1])
            bb+=wc*(self.features[j][2]-self.features[i][2])
        dy=changed(self.luminance[i],K,ls/lw) if hl else ZERO
        da=changed(self.data[i][0]-self.luminance[i],self.scale[i],aa/cw) if hc else ZERO
        db=changed(self.data[i][2]-self.luminance[i],self.scale[i],bb/cw) if hc else ZERO
        if dy==da==db==0:
            return self.input[i][:]
        return [float(self.data[i][0]+dy+da),
                float(self.data[i][1]+dy-(self.y[0]*da+self.y[2]*db)/self.y[1]),
                float(self.data[i][2]+dy+db),self.input[i][3]]

    def sharpen(self, x, y, settings):
        i=self.at(x,y)
        if not settings['amount'] or not self.data[i][3]:
            return self.input[i][:]
        radius=D(str(settings['radius']))
        support=int((3*radius).__ceil__())
        kernel=[exp(-D(k*k)/(2*radius*radius)) for k in range(-support,support+1)]
        difference,total=ZERO,ZERO
        low=high=self.luminance[i]
        for dy in range(-support,support+1):
            for dx in range(-support,support+1):
                j=self.at(x+dx,y+dy)
                if not self.data[j][3]:
                    continue
                weight=kernel[dx+support]*kernel[dy+support]*self.data[j][3]
                difference+=weight*(self.features[i][0]-self.features[j][0])
                total+=weight
                low=min(low,self.luminance[j]);high=max(high,self.luminance[j])
        difference/=total
        t=D('0.08')*D(settings['threshold'])/100
        protection=difference*difference/(difference*difference+t*t) if difference else ZERO
        proposed=self.luminance[i]+changed(self.luminance[i],K,D(settings['amount'])/100*difference*protection)
        limit=(high-low)*D('0.03')
        delta=max(low-limit,min(high+limit,proposed))-self.luminance[i]
        if not delta:
            return self.input[i][:]
        return [*[float(c+delta) for c in self.data[i][:3]],self.input[i][3]]


def scenes():
    result=[]
    state=0x4c554d41
    def random():
        nonlocal state
        state=(1664525*state+1013904223)&0xffffffff
        return (state+0.5)/4294967296-0.5
    for name in ['flat','signed-zero','ramp','dark-noise','hdr-noise','signed-hdr','transparent','tiny-alpha']:
        data=[]
        for y in range(9):
            for x in range(9):
                if name=='flat': p=[.18,.18,.18,1]
                elif name=='signed-zero': p=[-0.0,0.0,-0.0,1 if (x+y)%3 else -0.0]
                elif name=='ramp': p=[(x+2)/16,(y+3)/16,(x+y)/24,1]
                elif name=='dark-noise': p=[.003+random()*.001,.005+random()*.001,.002+random()*.001,1]
                elif name=='hdr-noise':
                    p=[3.2+random()*.1,6.4+random()*.1,9.6+random()*.1,1]
                    if x==y==6:p=[16,16,16,1]
                elif name=='signed-hdr':p=[2*x-2,1.5*y-1,x+y-4,[0,.25,.5,1][(x+y)%4]]
                elif name=='transparent':
                    p=[.18+random()*.002,.15+random()*.002,.12+random()*.002,1]
                    if x in [0,8] or y in [0,8]:p=[16,-4,8,0]
                else:p=[random()*1e-12,random()*1e-12,random()*1e-12,[0,2**-80,2**-20,.25,.5,1][(x+y)%6]]
                data.append([f32(v) for v in p])
        result.append({'name':name,'width':9,'height':9,'data':data})
    return result


def main(destination):
    noise=[{'version':1,'luminance':a,'chroma':b} for a,b in [(0,0),(50,0),(0,50),(50,50),(100,100),(1,100)]]
    sharp=[{'version':1,'amount':a,'radius':r,'threshold':t} for a,r,t in [(0,3,0),(50,1,50),(100,.5,0),(100,3,0),(100,3,100)]]
    points=[(0,0),(8,0),(0,8),(8,8),(4,4),(4,1),(1,4),(7,4),(4,7)]
    result=[]
    for scene in scenes():
        cases=[]
        for primaries in LUMINANCE:
            oracle=Scene(scene['data'],9,9,primaries)
            for settings in noise:
                cases.append({'primaries':primaries,'operation':'noise','settings':settings,
                    'points':[{'x':x,'y':y,'output':oracle.denoise(x,y,settings)} for x,y in points]})
            for settings in sharp:
                cases.append({'primaries':primaries,'operation':'sharpen','settings':settings,
                    'points':[{'x':x,'y':y,'output':oracle.sharpen(x,y,settings)} for x,y in points]})
            combined=[[f32(v) for v in oracle.denoise(x,y,noise[3])] for y in range(9) for x in range(9)]
            after=Scene(combined,9,9,primaries)
            cases.append({'primaries':primaries,'operation':'combined','noise':noise[3],'settings':sharp[1],
                'points':[{'x':x,'y':y,'output':after.sharpen(x,y,sharp[1])} for x,y in points]})
            oracle.patch_distances.cache_clear()
        result.append({**scene,'cases':cases,'sha256':sha256(b''.join(struct.pack('<4f',*p) for p in scene['data'])).hexdigest()})
        print('Generated',scene['name'],flush=True)
    value={'version':'detail-decimal80-v1','precision':80,'license':'CC0-1.0',
        'method':'Independent primary elimination, complete alpha-weighted patch enumeration and 2-D convolution; Float32 publication between stages',
        'sources':{p.name:sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),helper]},
        'scenes':result}
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_text(json.dumps(value,indent=2)+'\n')
    print('Saved',destination,flush=True)


if __name__=='__main__':
    main(Path(sys.argv[1]))
