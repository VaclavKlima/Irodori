#!/usr/bin/env python3
"""CC0-1.0 reproducible small-chart fixtures from the independent prefix-sum candidate.

The production kernel enumerates individual patch taps. This generator imports no
application functions and retains clean truth, entering pixels and independent output.
"""
from hashlib import sha256
import importlib.util
import json
from pathlib import Path
import sys

candidate=Path(__file__).with_name('detail-candidates.py')
spec=importlib.util.spec_from_file_location('detail_quality_candidate',candidate)
model=importlib.util.module_from_spec(spec)
spec.loader.exec_module(model)

def main(destination):
    cases=[]
    for case in model.charts():
        output=model.denoise(case['entering'],case['width'],case['height'],model.LUMINANCE['srgb'],case['luminance'],case['chroma'],'nlm',.048,.16)
        cases.append({**case,'output':output,'reference':model.evaluate(case,output),
            'cleanFeatures':[model.encode(p,model.LUMINANCE['srgb']) for p in case['clean']],
            'enteringFeatures':[model.encode(p,model.LUMINANCE['srgb']) for p in case['entering']]})
    value={'version':'detail-quality-v1','license':'CC0-1.0','coefficients':model.LUMINANCE,
        'sources':{p.name:sha256(p.read_bytes()).hexdigest() for p in [Path(__file__),candidate,model.helper]},'cases':cases}
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_text(json.dumps(value,indent=2)+'\n')
    print('Saved',len(cases),'quality charts:',destination,flush=True)

if __name__=='__main__':main(Path(sys.argv[1]))
