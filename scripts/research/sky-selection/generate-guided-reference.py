"""CC0-1.0: independent OpenCV RGB guided-filter numeric reference, no photographs."""
import base64,gzip,hashlib,json,pathlib
import cv2,numpy as np
root=pathlib.Path(__file__).resolve().parents[3]
edge=128
y,x=np.mgrid[:edge,:edge]
right=x>=64
rgba=np.empty((edge,edge,4),np.uint8)
rgba[:,:,:3]=np.where(right[:,:,None],np.array([65,153,240]),np.array([40,62,24]))
needle=(x>80)&(x<84)&(y>30)&(y<105)
rgba[needle,:3]=[40,62,24]
rgba[:,:,:3]=np.clip(rgba[:,:,:3].astype(np.int16)+(x*13+y*7)[:,:,None]%7-3,0,255).astype(np.uint8)
rgba[:,:,3]=255
guide=rgba[:,:,:3].astype(np.float32)/255
mask=right.astype(np.float32)
# OpenCV 5's FP32 RGB inverse degenerates at normalized covariance units.
# Equivalent 0..255 guidance scales epsilon by 255 squared.
expected=cv2.ximgproc.guidedFilter(guide*255,mask,8,1e-3*255*255)
# Independently solve the normalized RGB normal equations in float64.
g=guide.astype(np.float64); p=mask.astype(np.float64)
mean=lambda v:cv2.boxFilter(v,-1,(17,17),borderType=cv2.BORDER_REFLECT)
mi,mp=mean(g),mean(p); covariance=np.empty((edge,edge,3,3),np.float64)
for c in range(3):
 for d in range(3): covariance[:,:,c,d]=mean(g[:,:,c]*g[:,:,d])-mi[:,:,c]*mi[:,:,d]+(1e-3 if c==d else 0)
slope=np.linalg.solve(covariance,(mean(g*p[:,:,None])-mi*mp[:,:,None])[:,:,:,None])[:,:,:,0]
intercept=mp-np.sum(slope*mi,axis=2)
oracle=np.clip(np.sum(mean(slope)*g,axis=2)+mean(intercept),0,1)
assert np.max(np.abs(np.rint(oracle*255)-np.rint(np.clip(expected,0,1)*255)))<=1
expected=np.rint(np.clip(expected,0,1)*255).astype(np.uint8).tobytes()
sha=lambda b:hashlib.sha256(b).hexdigest()
manifest={'version':2,'license':'CC0-1.0','generator':'scripts/research/sky-selection/generate-guided-reference.py','generatorSha256':sha(pathlib.Path(__file__).read_bytes()),'reference':{'library':'opencv-contrib-python-headless','version':cv2.__version__,'method':'ximgproc.guidedFilter RGB 0..255, radius 8, epsilon 0.001*255^2, full model grid; independently checked against float64 normalized RGB normal equations'},'edge':edge,'rgbaGzipBase64':base64.b64encode(gzip.compress(rgba.tobytes(),mtime=0)).decode(),'expectedGzipBase64':base64.b64encode(gzip.compress(expected,mtime=0)).decode(),'rgbaSha256':sha(rgba.tobytes()),'expectedSha256':sha(expected),'maxByteError':1}
out=root/'assets/tests/references/automatic-selection/guided-filter.json';out.write_text(json.dumps(manifest,indent=2)+'\n');print(out)
