/* ============ visão: detector, recortador, matting, filtros ============ */
function f16(h){ const s=(h&0x8000)?-1:1, e=(h>>10)&31, f=h&1023; if(e===0) return s*Math.pow(2,-14)*(f/1024); if(e===31) return f?NaN:s*Infinity; return s*Math.pow(2,e-15)*(1+f/1024); }
function tpeFor(idxs){
  const D=st.det[st.detKind], key=idxs.join(","); if(D.tpe.has(key)) return D.tpe.get(key);
  const t=new Float32Array(NSLOT*512);
  for(let k=0;k<NSLOT;k++){ const src=idxs[Math.min(k,idxs.length-1)]*512; for(let j=0;j<512;j++) t[k*512+j]=f16(D.pe[src+j]); }
  const T=new ort.Tensor("float32",t,[1,NSLOT,512]); D.tpe.set(key,T); return T;
}
const lbC=new OffscreenCanvas(S,S), lbX=lbC.getContext("2d",{willReadFrequently:true});
/* texto → caixas; termos em blocos de 8 (k = índice global do termo) */
async function detect(cv, W, H, terms, conf){
  if(!terms.length) return [];
  const s=Math.min(S/W,S/H), nw=W*s, nh=H*s, px=(S-nw)/2, py=(S-nh)/2;
  lbX.fillStyle="rgb(114,114,114)"; lbX.fillRect(0,0,S,S); lbX.imageSmoothingQuality="high"; lbX.drawImage(cv.fc,0,0,W,H,px,py,nw,nh);
  const d=lbX.getImageData(0,0,S,S).data, x=new Float32Array(3*S*S), A=S*S;
  for(let i=0,p=0;i<A;i++,p+=4){ x[i]=d[p]/255; x[A+i]=d[p+1]/255; x[2*A+i]=d[p+2]/255; }
  const img=new ort.Tensor("float32",x,[1,3,S,S]), dets=[];
  for(let c0=0;c0<terms.length;c0+=NSLOT){
    const chunk=terms.slice(c0,c0+NSLOT), r=await runOrt(st.det[st.detKind].sess,{images:img, tpe:tpeFor(chunk.map(t=>t.idx))});
    const o=r.output0.data, nT=chunk.length;
    for(let a=0;a<NA;a++){ let bk=-1,bs=conf; for(let k=0;k<nT;k++){ const sc=o[(4+k)*NA+a]; if(sc>bs){ bs=sc; bk=k; } } if(bk<0) continue;
      const cx=o[a],cy=o[NA+a],w=o[2*NA+a],h=o[3*NA+a]; dets.push({k:c0+bk,conf:bs,b:[(cx-w/2-px)/s,(cy-h/2-py)/s,(cx+w/2-px)/s,(cy+h/2-py)/s]}); }
  }
  dets.sort((p,q)=>q.conf-p.conf); const keep=[];
  for(const d of dets){ if(keep.every(e=>e.k!==d.k||iou(e.b,d.b)<0.6)) keep.push(d); if(keep.length>=80) break; }
  for(const d of keep) d.b=[clamp(d.b[0],0,W),clamp(d.b[1],0,H),clamp(d.b[2],0,W),clamp(d.b[3],0,H)];
  return keep;
}

/* ---- SAM: caixa/pins + máscara anterior → contorno ---- */
const samC=new OffscreenCanvas(SAMS,SAMS), samX=samC.getContext("2d",{willReadFrequently:true});
async function samEncode(cv, rect){
  const s=SAMS/Math.max(rect.w,rect.h), nw=Math.round(rect.w*s), nh=Math.round(rect.h*s);
  samX.fillStyle="rgb(124,116,104)"; samX.fillRect(0,0,SAMS,SAMS); samX.imageSmoothingQuality="high";
  samX.drawImage(cv.fc, rect.x, rect.y, rect.w, rect.h, 0, 0, nw, nh);
  const d=samX.getImageData(0,0,SAMS,SAMS).data, A=SAMS*SAMS, x=new Float32Array(3*A);
  for(let i=0,p=0;i<A;i++,p+=4){ x[i]=(d[p]-SAM_MEAN[0])/SAM_STD[0]; x[A+i]=(d[p+1]-SAM_MEAN[1])/SAM_STD[1]; x[2*A+i]=(d[p+2]-SAM_MEAN[2])/SAM_STD[2]; }
  const r=await runOrt(st.enc,{image:new ort.Tensor("float32",x,[1,3,SAMS,SAMS])});
  return {emb:r.emb, s0:r.s0, s1:r.s1, rect, s, nw, nh};
}
async function samDecode(E, prompts, maskIn, small){
  const co=new Float32Array(NP*2), la=new Float32Array(NP).fill(-1);
  prompts.slice(0,NP).forEach((p,i)=>{ co[2*i]=(p.x-E.rect.x)*E.s; co[2*i+1]=(p.y-E.rect.y)*E.s; la[i]=p.l; });
  const feeds={emb:E.emb, coords:new ort.Tensor("float32",co,[1,NP,2]), labels:new ort.Tensor("float32",la,[1,NP]),
    mask_in:new ort.Tensor("float32", maskIn||new Float32Array(65536), [1,1,256,256]), has_mask:new ort.Tensor("float32", new Float32Array([maskIn?1:0]), [1])};
  if(E.s0){ feeds.s0=E.s0; feeds.s1=E.s1; }
  const r=await runOrt(st.dec,feeds);
  if(r.obj && r.obj.data[0] < 0) return {logits:new Float32Array(65536).fill(-20), score:0, gone:true};
  const m=r.masks.data, iou=r.iou.data;
  const hasBox=prompts.some(p=>p.l===2), nPts=prompts.filter(p=>p.l===0||p.l===1).length;
  let pick=0;
  if(!hasBox && nPts===1 && !maskIn){
    pick=1; for(let k=2;k<4;k++) if(iou[k]>iou[pick]) pick=k;
    if(small){ let bestA=Infinity; for(let k=1;k<4;k++){ if(iou[k]<0.72) continue; let a=0; const o=k*65536; for(let i=0;i<65536;i++) if(m[o+i]>0) a++; if(a>30&&a<bestA){ bestA=a; pick=k; } } }
  } else if(hasBox && !maskIn && st.wholeObject){
    // caixa: prefere a resposta que cobre o objeto inteiro (roupa, rodas) quando a confiança é parecida
    let best=0, bestA=0; for(let k=0;k<4;k++){ if(iou[k] < iou[0]-0.06) continue; let a=0; const o=k*65536; for(let i=0;i<65536;i++) if(m[o+i]>0) a++; if(a>bestA){ bestA=a; best=k; } } pick=best;
  }
  return {logits:m.slice(pick*65536,(pick+1)*65536), score:iou[pick]};
}
function warpLogits(prev, cur){
  const out=new Float32Array(65536), L=prev.logits;
  for(let cy=0;cy<256;cy++) for(let cx=0;cx<256;cx++){
    const X=(cx+0.5)*4, Y=(cy+0.5)*4; let v=-20;
    if(X<cur.nw && Y<cur.nh){ const fx=cur.rect.x+X/cur.s, fy=cur.rect.y+Y/cur.s, PX=(fx-prev.rect.x)*prev.s, PY=(fy-prev.rect.y)*prev.s;
      if(PX>=0&&PY>=0&&PX<prev.nw&&PY<prev.nh){ const lx=clamp(PX/4-0.5,0,255), ly=clamp(PY/4-0.5,0,255), x0=lx|0, y0=ly|0, x1=Math.min(255,x0+1), y1=Math.min(255,y0+1), a=lx-x0, b=ly-y0;
        v=(L[y0*256+x0]*(1-a)+L[y0*256+x1]*a)*(1-b)+(L[y1*256+x0]*(1-a)+L[y1*256+x1]*a)*b; } }
    out[cy*256+cx]=v; }
  return out;
}
function logitsToMask(E, logits, soft){
  const R=E.rect, w=R.w, h=R.h, data=new Float32Array(w*h), lo=soft?0.15:0.3, span=soft?0.7:0.4;
  for(let y=0;y<h;y++){ const ly=clamp(((y+0.5)*E.s)/4-0.5,0,255), y0=ly|0, y1=Math.min(255,y0+1), fy=ly-y0;
    for(let x=0;x<w;x++){ const lx=clamp(((x+0.5)*E.s)/4-0.5,0,255), x0=lx|0, x1=Math.min(255,x0+1), fx=lx-x0;
      const v=(logits[y0*256+x0]*(1-fx)+logits[y0*256+x1]*fx)*(1-fy)+(logits[y1*256+x0]*(1-fx)+logits[y1*256+x1]*fx)*fy;
      const pr=1/(1+Math.exp(-v)); data[y*w+x]= pr<=lo?0 : pr>=lo+span?1 : (pr-lo)/span; } }
  return {rect:R, data};
}
function cleanMask(M, pinsAbs, P){
  const {w,h}=M.rect, n=w*h, d=M.data, lab=new Int32Array(n), par=[0];
  const find=a=>{ while(par[a]!==a){ par[a]=par[par[a]]; a=par[a]; } return a; };
  const label=fg=>{ lab.fill(0); par.length=1; let next=1;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){ const i=y*w+x; if((d[i]>=0.5)!==fg) continue; const nb=[];
      if(x>0&&((d[i-1]>=0.5)===fg)) nb.push(lab[i-1]); if(y>0&&((d[i-w]>=0.5)===fg)) nb.push(lab[i-w]);
      if(fg){ if(x>0&&y>0&&d[i-w-1]>=0.5) nb.push(lab[i-w-1]); if(x<w-1&&y>0&&d[i-w+1]>=0.5) nb.push(lab[i-w+1]); }
      if(!nb.length){ par.push(next); lab[i]=next++; } else { let m=find(nb[0]); for(const b of nb){ const r=find(b); if(r<m) m=r; } for(const b of nb){ const r=find(b); if(r!==m) par[r]=m; } lab[i]=m; } }
    const area=new Map(); for(let i=0;i<n;i++) if(lab[i]){ const r=find(lab[i]); lab[i]=r; area.set(r,(area.get(r)||0)+1); } return area; };
  if(P.islands){ const area=label(true); if(area.size>1){ let big=0,bigA=0; for(const [r,a] of area) if(a>bigA){ bigA=a; big=r; }
      const keep=new Set([big]); for(const [r,a] of area) if(a>=0.15*bigA) keep.add(r);
      for(const p of pinsAbs||[]){ if(p.l!==1) continue; const x=Math.round(p.x-M.rect.x), y=Math.round(p.y-M.rect.y); if(x>=0&&y>=0&&x<w&&y<h&&lab[y*w+x]) keep.add(lab[y*w+x]); }
      for(let i=0;i<n;i++) if(lab[i]&&!keep.has(lab[i])) d[i]=0; } }
  if(P.holes){ let fgA=0; for(let i=0;i<n;i++) if(d[i]>=0.5) fgA++;
    const area=label(false), border=new Set(); for(let x=0;x<w;x++){ border.add(lab[x]); border.add(lab[(h-1)*w+x]); } for(let y=0;y<h;y++){ border.add(lab[y*w]); border.add(lab[y*w+w-1]); }
    const lim=(P.holeFrac||0.01)*fgA; for(let i=0;i<n;i++){ const r=lab[i]; if(r&&!border.has(r)&&area.get(r)<lim) d[i]=1; } }
  return M;
}
function maskBox(M){ const {x:ox,y:oy,w,h}=M.rect; let x1=1e9,y1=1e9,x2=-1,y2=-1;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++) if(M.data[y*w+x]>=0.5){ if(x<x1)x1=x; if(x>x2)x2=x; if(y<y1)y1=y; if(y>y2)y2=y; }
  return x2<0? null : [ox+x1, oy+y1, ox+x2+1, oy+y2+1]; }
const MIN_SIDE=Math.round(SAMS/1.25);
function cropRect(b, W, H, margin){ const bw=b[2]-b[0], bh=b[3]-b[1], m=Math.max(24, margin*Math.max(bw,bh));
  let x1=b[0]-m, y1=b[1]-m, x2=b[2]+m, y2=b[3]+m; const side=Math.min(Math.max(W,H), MIN_SIDE);
  if(Math.max(x2-x1,y2-y1)<side){ const cx=(x1+x2)/2, cy=(y1+y2)/2, hw=Math.max(x2-x1,side)/2, hh=Math.max(y2-y1, side*Math.min(1,H/W))/2;
    x1=cx-hw; x2=cx+hw; y1=cy-hh; y2=cy+hh; if(x1<0){ x2-=x1; x1=0; } if(x2>W){ x1-=x2-W; x2=W; } if(y1<0){ y2-=y1; y1=0; } if(y2>H){ y1-=y2-H; y2=H; } }
  const x=Math.floor(clamp(x1,0,W-1)), y=Math.floor(clamp(y1,0,H-1)), xe=Math.ceil(clamp(x2,1,W)), ye=Math.ceil(clamp(y2,1,H));
  return {x, y, w:Math.max(8,xe-x), h:Math.max(8,ye-y)}; }

/* ---- filtros ---- */
function boxBlur(src, W, H, r){ const tmp=new Float32Array(W*H), out=new Float32Array(W*H), n=2*r+1;
  for(let y=0;y<H;y++){ const o=y*W; let acc=0; for(let x=-r;x<=r;x++) acc+=src[o+clamp(x,0,W-1)];
    for(let x=0;x<W;x++){ tmp[o+x]=acc/n; acc+=src[o+Math.min(W-1,x+r+1)]-src[o+Math.max(0,x-r)]; } }
  for(let x=0;x<W;x++){ let acc=0; for(let y=-r;y<=r;y++) acc+=tmp[clamp(y,0,H-1)*W+x];
    for(let y=0;y<H;y++){ out[y*W+x]=acc/n; acc+=tmp[Math.min(H-1,y+r+1)*W+x]-tmp[Math.max(0,y-r)*W+x]; } }
  return out; }
function guidedRegion(cv, q, W, H, r){
  let x1=W,y1=H,x2=-1,y2=-1; for(let y=0;y<H;y+=2) for(let x=0;x<W;x+=2){ const v=q[y*W+x]; if(v>0.02&&v<0.98){ if(x<x1)x1=x; if(x>x2)x2=x; if(y<y1)y1=y; if(y>y2)y2=y; } }
  if(x2<0) return; const m=4*r+4; x1=Math.max(0,x1-m); y1=Math.max(0,y1-m); x2=Math.min(W,x2+m); y2=Math.min(H,y2+m);
  const w=x2-x1, h=y2-y1, fd=cv.fx.getImageData(x1,y1,w,h).data, I=new Float32Array(w*h), p=new Float32Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){ const i=y*w+x, j=i*4; I[i]=(0.299*fd[j]+0.587*fd[j+1]+0.114*fd[j+2])/255; p[i]=q[(y1+y)*W+x1+x]; }
  const N=w*h, Ip=new Float32Array(N), II=new Float32Array(N); for(let i=0;i<N;i++){ Ip[i]=I[i]*p[i]; II[i]=I[i]*I[i]; }
  const mI=boxBlur(I,w,h,r), mp=boxBlur(p,w,h,r), mIp=boxBlur(Ip,w,h,r), mII=boxBlur(II,w,h,r);
  for(let i=0;i<N;i++){ const a=(mIp[i]-mI[i]*mp[i])/(mII[i]-mI[i]*mI[i]+2e-4); Ip[i]=a; II[i]=mp[i]-a*mI[i]; }
  const ma=boxBlur(Ip,w,h,r), mb=boxBlur(II,w,h,r);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){ const i=y*w+x, o=q[(y1+y)*W+x1+x], v=clamp((ma[i]*I[i]+mb[i]-0.2)/0.6,0,1);
    if((o>0.002&&o<0.998)||Math.abs(v-o)<0.5) q[(y1+y)*W+x1+x]=clamp(0.5*o+0.5*v,0,1); }
}
function morph(bin, W, H, r, dilate){ const tmp=new Uint8Array(W*H), out=new Uint8Array(W*H), t=dilate?1:0;
  for(let y=0;y<H;y++){ const o=y*W; for(let x=0;x<W;x++){ let v=1-t; for(let k=Math.max(0,x-r);k<=Math.min(W-1,x+r);k++){ if(bin[o+k]===t){ v=t; break; } } tmp[o+x]=v; } }
  for(let x=0;x<W;x++) for(let y=0;y<H;y++){ let v=1-t; for(let k=Math.max(0,y-r);k<=Math.min(H-1,y+r);k++){ if(tmp[k*W+x]===t){ v=t; break; } } out[y*W+x]=v; }
  return out; }
function finish(q, W, H, P){
  let m=q;
  if(P.grow!==0){ const bin=new Uint8Array(W*H); for(let i=0;i<W*H;i++) bin[i]=m[i]>=0.5?1:0; const r=morph(bin,W,H,Math.abs(P.grow),P.grow>0); m=new Float32Array(W*H); for(let i=0;i<W*H;i++) m[i]=r[i]; }
  else if(P.hard){ m=new Float32Array(W*H); for(let i=0;i<W*H;i++) m[i]=q[i]>=0.5?1:0; }
  if(P.feather>0){ const r=Math.max(1,Math.round(P.feather)); m=boxBlur(boxBlur(boxBlur(m,W,H,r),W,H,r),W,H,r); }
  return m; }
const toU8 = (m, invert) => { const out=new Uint8Array(m.length); for(let i=0;i<m.length;i++){ let v=m[i]; if(invert) v=1-v; out[i]=v<=0?0:v>=1?255:Math.round(v*255); } return out; };

/* ---- matting de pessoas (RVM): a borda/cabelo vêm do RVM, a escolha da pessoa vem do SAM ---- */
async function rvmStep(state, cv, W, H){
  const sc=Math.min(1, 1920/Math.max(W,H)), w=Math.round(W*sc/2)*2, h=Math.round(H*sc/2)*2;
  state.c ||= new OffscreenCanvas(w,h); state.x ||= state.c.getContext("2d",{willReadFrequently:true});
  state.x.drawImage(cv.fc,0,0,w,h); const d=state.x.getImageData(0,0,w,h).data, A=w*h, src=new Float32Array(3*A);
  for(let i=0,p=0;i<A;i++,p+=4){ src[i]=d[p]/255; src[A+i]=d[p+1]/255; src[2*A+i]=d[p+2]/255; }
  const z=()=>new ort.Tensor("float32",new Float32Array(1),[1,1,1,1]);
  const ratio=Math.min(1, 512/Math.max(w,h));
  const feeds=()=>({src:new ort.Tensor("float32",src,[1,3,h,w]), r1i:state.r1||z(), r2i:state.r2||z(), r3i:state.r3||z(), r4i:state.r4||z(), downsample_ratio:new ort.Tensor("float32",new Float32Array([ratio]),[1])});
  let r; try{ r=await runOrt(st.rvm.sess,feeds()); }
  catch(e){ // algumas placas não rodam o AveragePool do RVM na WebGPU: refaz no processador
    if(st.rvm.ep!=="webgpu") throw e; console.warn("RVM na WebGPU falhou, indo para WASM", e);
    note("Matting de pessoas no processador (a placa de vídeo não suporta esse modelo).");
    const [sess,ep]=await makeSession(st.rvm.bytes,"o matting de pessoas",["wasm"]); try{ st.rvm.sess.release?.(); }catch(_){} st.rvm.sess=sess; st.rvm.ep=ep;
    state.r1=state.r2=state.r3=state.r4=null; r=await runOrt(st.rvm.sess,feeds()); }
  state.r1=r.r1o; state.r2=r.r2o; state.r3=r.r3o; state.r4=r.r4o;
  const pha=r.pha.data; if(w===W && h===H) return Float32Array.from(pha);
  // amplia o alfa para a resolução cheia
  const out=new Float32Array(W*H), fx=w/W, fy=h/H;
  for(let y=0;y<H;y++){ const sy=clamp((y+0.5)*fy-0.5,0,h-1), y0=sy|0, y1=Math.min(h-1,y0+1), b=sy-y0;
    for(let x=0;x<W;x++){ const sx=clamp((x+0.5)*fx-0.5,0,w-1), x0=sx|0, x1=Math.min(w-1,x0+1), a=sx-x0;
      out[y*W+x]=(pha[y0*w+x0]*(1-a)+pha[y0*w+x1]*a)*(1-b)+(pha[y1*w+x0]*(1-a)+pha[y1*w+x1]*a)*b; } }
  return out;
}
function mattingMerge(q, pha, W, H){
  // região = máscara do SAM dilatada (só as pessoas escolhidas); núcleo = máscara do SAM erodida
  const r=Math.max(3, Math.round(Math.max(W,H)*0.012)), bin=new Float32Array(W*H); for(let i=0;i<W*H;i++) bin[i]=q[i]>=0.5?1:0;
  const bl=boxBlur(bin,W,H,r), out=new Float32Array(W*H);
  for(let i=0;i<W*H;i++){ const region=clamp(bl[i]*4,0,1), core=bl[i]>0.985?q[i]:0; out[i]=Math.max(pha[i]*region, core); }
  return out;
}

/* ---- PNG 8-bit cinza ---- */
const CRC=(()=>{const t=new Uint32Array(256); for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c=c&1?0xedb88320^(c>>>1):c>>>1; t[n]=c>>>0; } return t;})();
function crc32(b){ let c=0xffffffff; for(let i=0;i<b.length;i++) c=CRC[(c^b[i])&255]^(c>>>8); return (c^0xffffffff)>>>0; }
async function zlib(data){ const cs=new CompressionStream("deflate"); const w=cs.writable.getWriter(); w.write(data); w.close(); return new Uint8Array(await new Response(cs.readable).arrayBuffer()); }
async function pngGray(px, W, H){
  const raw=new Uint8Array((W+1)*H); for(let y=0;y<H;y++){ raw[y*(W+1)]=0; raw.set(px.subarray(y*W,(y+1)*W), y*(W+1)+1); }
  const idat=await zlib(raw);
  const chunk=(type,data)=>{ const out=new Uint8Array(12+data.length), dv=new DataView(out.buffer); dv.setUint32(0,data.length); for(let i=0;i<4;i++) out[4+i]=type.charCodeAt(i); out.set(data,8); dv.setUint32(8+data.length, crc32(out.subarray(4,8+data.length))); return out; };
  const ih=new Uint8Array(13), dv=new DataView(ih.buffer); dv.setUint32(0,W); dv.setUint32(4,H); ih[8]=8;
  return new Blob([new Uint8Array([137,80,78,71,13,10,26,10]), chunk("IHDR",ih), chunk("IDAT",idat), chunk("IEND",new Uint8Array(0))],{type:"image/png"});
}
const rdC={}; function rdCtx(W,H){ const k=W+"x"+H; return rdC[k] ||= new OffscreenCanvas(W,H).getContext("2d",{willReadFrequently:true}); }
async function pngToFloat(blob, W, H){ if(!blob) return new Float32Array(W*H); const ctx=rdCtx(W,H), bm=await createImageBitmap(blob); ctx.clearRect(0,0,W,H); ctx.drawImage(bm,0,0); bm.close();
  const d=ctx.getImageData(0,0,W,H).data, q=new Float32Array(W*H); for(let i=0,j=0;i<q.length;i++,j+=4) q[i]=d[j]/255; return q; }
const f2u8 = q => { const u=new Uint8Array(q.length); for(let i=0;i<q.length;i++) u[i]=Math.round(clamp(q[i],0,1)*255); return u; };

/* ---- pincel: o traço vira um "palpite" de máscara para o SAM encaixar nas bordas da imagem ---- */
function strokeLogits(stroke, E){
  const c=new OffscreenCanvas(256,256), x=c.getContext("2d",{willReadFrequently:true}), k=E.s/4;
  x.fillStyle="#000"; x.fillRect(0,0,256,256); x.strokeStyle="#fff"; x.fillStyle="#fff"; x.lineCap="round"; x.lineJoin="round"; x.lineWidth=Math.max(1,2*stroke.r*k);
  const P=stroke.pts.map(p=>[(p.x-E.rect.x)*k,(p.y-E.rect.y)*k]);
  x.beginPath(); P.forEach(([a,b],i)=>i?x.lineTo(a,b):x.moveTo(a,b)); if(P.length===1){ x.arc(P[0][0],P[0][1],stroke.r*k,0,7); x.fill(); } else x.stroke();
  const d=x.getImageData(0,0,256,256).data, out=new Float32Array(65536);
  for(let i=0;i<65536;i++) out[i]= d[i*4]>127 ? 6 : -4;
  return out;
}
function strokeBox(stroke, W, H){ let x1=1e9,y1=1e9,x2=-1e9,y2=-1e9; for(const p of stroke.pts){ x1=Math.min(x1,p.x-stroke.r); y1=Math.min(y1,p.y-stroke.r); x2=Math.max(x2,p.x+stroke.r); y2=Math.max(y2,p.y+stroke.r); }
  return [clamp(x1,0,W),clamp(y1,0,H),clamp(x2,0,W),clamp(y2,0,H)]; }
function strokeSamples(stroke, n){ const P=stroke.pts; if(P.length<=n) return P.slice(); const out=[]; for(let i=0;i<n;i++) out.push(P[Math.round(i*(P.length-1)/(n-1))]); return out; }

/* ---- componentes conexos (8 vizinhos para frente, 4 para fundo) ---- */
function labelCC(bin, w, h, fg){
  const n=w*h, lab=new Int32Array(n), par=[0]; let next=1;
  const find=a=>{ while(par[a]!==a){ par[a]=par[par[a]]; a=par[a]; } return a; };
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){ const i=y*w+x; if(bin[i]!==fg) continue; const nb=[];
    if(x>0&&bin[i-1]===fg) nb.push(lab[i-1]); if(y>0&&bin[i-w]===fg) nb.push(lab[i-w]);
    if(fg){ if(x>0&&y>0&&bin[i-w-1]) nb.push(lab[i-w-1]); if(x<w-1&&y>0&&bin[i-w+1]) nb.push(lab[i-w+1]); }
    if(!nb.length){ par.push(next); lab[i]=next++; } else { let m=find(nb[0]); for(const b of nb){ const r=find(b); if(r<m) m=r; } for(const b of nb){ const r=find(b); if(r!==m) par[r]=m; } lab[i]=m; } }
  const area=new Map(), border=new Set();
  for(let i=0;i<n;i++) if(lab[i]){ const r=find(lab[i]); lab[i]=r; area.set(r,(area.get(r)||0)+1); }
  for(let x=0;x<w;x++){ border.add(lab[x]); border.add(lab[(h-1)*w+x]); } for(let y=0;y<h;y++){ border.add(lab[y*w]); border.add(lab[y*w+w-1]); }
  return {lab, area, border};
}
/* refino de um frame: tira ilhas e fecha furos (em % da área da máscara), dentro da caixa da máscara */
function cleanFrame(q, W, H, islPct, holePct){
  let x1=W,y1=H,x2=-1,y2=-1; for(let y=0;y<H;y+=2) for(let x=0;x<W;x+=2) if(q[y*W+x]>=0.5){ if(x<x1)x1=x; if(x>x2)x2=x; if(y<y1)y1=y; if(y>y2)y2=y; }
  if(x2<0) return q; x1=Math.max(0,x1-4); y1=Math.max(0,y1-4); x2=Math.min(W,x2+5); y2=Math.min(H,y2+5);
  const w=x2-x1, h=y2-y1, bin=new Uint8Array(w*h); let fgA=0;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){ const v=q[(y1+y)*W+x1+x]>=0.5?1:0; bin[y*w+x]=v; fgA+=v; }
  if(islPct>0){ const {lab,area}=labelCC(bin,w,h,1), lim=islPct/100*fgA;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){ const i=y*w+x, r=lab[i]; if(r && area.get(r)<lim){ q[(y1+y)*W+x1+x]=0; bin[i]=0; } } }
  if(holePct>0){ const {lab,area,border}=labelCC(bin,w,h,0), lim=holePct/100*fgA;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){ const i=y*w+x, r=lab[i]; if(r && !border.has(r) && area.get(r)<lim) q[(y1+y)*W+x1+x]=1; } }
  // borda: some resto suave de ilha removida (< 0.5 sem vizinho forte)
  return q;
}
/* análise de um frame (em miniatura): ilhas, furos, piscada e borda × imagem */
function analyzeThumb(m, prev, next, gray, tw, th){
  const n=tw*th, bin=new Uint8Array(n); let fg=0; for(let i=0;i<n;i++){ bin[i]=m[i]>=128?1:0; fg+=bin[i]; }
  if(fg<20) return {fg, isl:0, hole:0, blip:0, edge:1};
  const F=labelCC(bin,tw,th,1); let big=0; for(const a of F.area.values()) if(a>big) big=a;
  let isl=0; for(const a of F.area.values()) if(a<0.15*big) isl+=a;
  const B=labelCC(bin,tw,th,0); let hole=0; for(const [r,a] of B.area) if(!B.border.has(r) && a<0.05*fg) hole+=a;
  let blip=0; if(prev&&next) for(let i=0;i<n;i++){ const p=prev[i]>=128, q=next[i]>=128; if(p===q && p!==!!bin[i]) blip++; }
  let edges=0, good=0;
  for(let y=1;y<th-1;y++) for(let x=1;x<tw-1;x++){ const i=y*tw+x; if(!bin[i]) continue; if(bin[i-1]&&bin[i+1]&&bin[i-tw]&&bin[i+tw]) continue; edges++;
    let g=0; for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){ const j=i+dy*tw+dx; const gx=gray[j+1]-gray[j-1], gy=gray[j+tw]-gray[j-tw]; const v=Math.abs(gx)+Math.abs(gy); if(v>g) g=v; } if(g>0.07) good++; }
  return {fg, isl:isl/fg, hole:hole/fg, blip:blip/fg, edge:edges?good/edges:1};
}
