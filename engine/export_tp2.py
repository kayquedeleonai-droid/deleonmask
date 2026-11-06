import torch, sys, numpy as np, json
from ultralytics import YOLOE
from ultralytics.nn.modules.head import Detect, YOLOEDetect
size=sys.argv[1]
y=YOLOE(f'yoloe-11{size}-seg.pt'); m=y.model.eval().float(); m=m.fuse()
head=[x for x in m.modules() if isinstance(x,YOLOEDetect)][0]
# vocabulário já processado (reprta + normalização) -> o navegador não precisa disso
names=json.load(open('../web/vocab.json'))
raw=torch.from_numpy(np.fromfile('../web/vocab_emb_f16.bin',dtype=np.float16).astype(np.float32).reshape(1,-1,512))
with torch.no_grad(): proc=head.get_tpe(raw)[0].numpy()
proc.astype(np.float16).tofile(f'../web/vocab_pe_{size}_f16.bin'); print('pe',proc.shape)
head.get_tpe=lambda t: t
for mod in m.modules():
    if isinstance(mod, Detect): mod.export=True; mod.format='onnx'; mod.dynamic=False
class W(torch.nn.Module):
    def __init__(s,m): super().__init__(); s.m=m
    def forward(s, images, tpe): return s.m.predict(images, tpe=tpe)
w=W(m).eval()
x=torch.zeros(1,3,640,640); tpe=torch.randn(1,8,512)
torch.onnx.export(w,(x,tpe),f'../web/yoloe_{size}_op{sys.argv[2] if len(sys.argv)>2 else 17}.onnx',input_names=['images','tpe'],output_names=['output0','output1'],opset_version=int(sys.argv[2]) if len(sys.argv)>2 else 17,dynamo=False)
