import onnx, numpy as np, onnxruntime as ort, sys, collections
from onnx import helper
src,dst=sys.argv[1],sys.argv[2]
m=onnx.load(src); g=m.graph
div=[n for n in g.node if n.op_type=='Div' and any('Expand' in i for i in n.input)]
assert len(div)==1, div
out=div[0].output[0]
for n in g.node:
    for k,i in enumerate(n.input):
        if i==out: n.input[k]='tpe'
onnx.save(m,'/tmp/_w.onnx')
import subprocess; subprocess.run([sys.executable,'-m','onnxslim','/tmp/_w.onnx',dst],check=True,capture_output=True)
m2=onnx.load(dst); print(collections.Counter(n.op_type for n in m2.graph.node))
x=np.random.rand(1,3,640,640).astype(np.float32); t=np.random.randn(1,8,512).astype(np.float32); t/=np.linalg.norm(t,axis=-1,keepdims=True)
a=ort.InferenceSession(src).run(None,{'images':x,'tpe':t}); b=ort.InferenceSession(dst).run(None,{'images':x,'tpe':t})
print('diff',[float(np.abs(p-q).max()) for p,q in zip(a,b)])
