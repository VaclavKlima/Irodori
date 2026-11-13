"""CC0-1.0: independent Torch antialiased RGB sampling and normalization vectors."""
import hashlib,json,pathlib
import numpy as np,torch
from torch.nn import functional as F
root=pathlib.Path(__file__).resolve().parents[3]
torch.set_num_threads(4)
fixtures=[]
for width,height,edge,normalize,monochrome in [(37,29,128,False,False),(1593,621,512,True,False),(517,1001,1024,True,False),(1593,621,512,True,True)]:
 data=((np.arange(width*height*4,dtype=np.int64)*97+31)%256).astype(np.uint8).reshape(height,width,4)
 data[:,:,3]=255
 image=torch.from_numpy(data[:,:,:3].copy()).permute(2,0,1).unsqueeze(0).float()/255
 value=F.interpolate(image,size=(edge,edge),mode='bilinear',align_corners=False,antialias=True)
 if monochrome:value=(value*torch.tensor([.2126,.7152,.0722])[None,:,None,None]).sum(1,keepdim=True).expand(-1,3,-1,-1)
 if normalize:value=(value-torch.tensor([.485,.456,.406])[None,:,None,None])/torch.tensor([.229,.224,.225])[None,:,None,None]
 flat=value.numpy().reshape(-1)
 indices=sorted({c*edge*edge+y*edge+x for c in range(3)for y in [0,1,edge//3,edge//2,edge-2,edge-1]for x in [0,1,edge//3,edge//2,edge-2,edge-1]})
 fixtures.append({'width':width,'height':height,'edge':edge,'normalize':normalize,'monochrome':monochrome,'samples':[{'index':i,'value':float(flat[i])}for i in indices]})
manifest={'version':1,'license':'CC0-1.0','generator':'scripts/research/sky-selection/generate-sampling-reference.py','generatorSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'torch':torch.__version__,'method':'F.interpolate bilinear antialias=True align_corners=False; ImageNet mean/std after resize. Normalized values are compared in RGB units to retain the existing sampler gate.','maxRgbError':1e-6,'fixtures':fixtures}
(root/'assets/tests/references/automatic-selection/sampling.json').write_text(json.dumps(manifest,indent=2)+'\n')
