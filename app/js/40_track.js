/* ============ camadas, objetos, rastreamento e montagem ============ */
const PRESETS = {
  livre:  {name:"Livre",   layers:[{name:"Máscara", prompt:"pessoa"}]},
  pessoa: {name:"Pessoa",  layers:[{name:"Pessoas", prompt:"pessoa", matting:true}]},
  carro:  {name:"Carro",   layers:[{name:"Carroceria", prompt:"carro"}, {name:"Rodas", prompt:"roda do carro, pneu"},
                                   {name:"Vidros", prompt:"para-brisa, janela do carro, vidro traseiro"}, {name:"Sombra", prompt:"sombra do carro", on:false}],
           parts:{Rodas:"Carroceria", Vidros:"Carroceria"},
           tune:{holes:true, holeFrac:0.06}},
  produto:{name:"Produto", layers:[{name:"Produto", prompt:"produto, garrafa, caixa, lata"}, {name:"Mãos", prompt:"mão"}]},
};
// partes (rodas, vidros) só valem dentro do objeto inteiro (carroceria)
function linkParts(p){ for(const [child,parent] of Object.entries(p.parts||{})){ const c=st.layers.find(l=>l.name===child), pa=st.layers.find(l=>l.name===parent); if(c&&pa) c.partOf=pa.id; } }
function newLayer(o, i){ return {id:"L"+(st.nextId++), name:o.name, prompt:o.prompt||"", on:o.on!==false, matting:!!o.matting, whole:o.whole!==false, color:LAYER_COLORS[i%LAYER_COLORS.length]}; }
function applyPreset(id){
  st.preset=id; const p=PRESETS[id];
  st.layers=p.layers.map(newLayer); st.activeLayer=st.layers[0].id; linkParts(p);
  st.objs=[]; st.edit=null; st.run=null; st.out=null; st.history=[];
  loadPresetMemory(id);
}
/* ajustes que funcionaram ficam guardados por predefinição (só neste navegador) */
const TUNE_IDS=["conf","hold","edge","grow","feather","smooth"], TUNE_CK=["islands","holes","hard","invert"];
function savePresetMemory(){ try{ const o={}; for(const k of TUNE_IDS) o[k]=$("#"+k).value; for(const k of TUNE_CK) o[k]=$("#"+k).checked;
  o.layers=st.layers.map(l=>({name:l.name,prompt:l.prompt,on:l.on,matting:l.matting})); localStorage.setItem("dlm.preset."+st.preset, JSON.stringify(o)); }catch(e){} }
function loadPresetMemory(id){ let o=null; try{ o=JSON.parse(localStorage.getItem("dlm.preset."+id)||"null"); }catch(e){}
  const t=PRESETS[id].tune||{}; $("#holes").checked = t.holes ?? true;
  if(!o) return; for(const k of TUNE_IDS) if(o[k]!=null) $("#"+k).value=o[k]; for(const k of TUNE_CK) if(o[k]!=null) $("#"+k).checked=o[k];
  if(Array.isArray(o.layers) && o.layers.length){ st.layers=o.layers.map(newLayer); st.activeLayer=st.layers[0].id; linkParts(PRESETS[id]); } }
function readParams(){ return { conf:+$("#conf").value, edge:+$("#edge").value, hold:+$("#hold").value, islands:$("#islands").checked, holes:$("#holes").checked,
  holeFrac:(PRESETS[st.preset].tune||{}).holeFrac||0.01, grow:+$("#grow").value, feather:+$("#feather").value, smooth:+$("#smooth").value, hard:$("#hard").checked, invert:$("#invert").checked }; }

/* ---- objetos ----
   modelo (st.objs): o que você marcou; estado de execução: cópia com prev/mask/mb/miss. */
function pinsFor(o){ const b=o.box, bw=b[2]-b[0], bh=b[3]-b[1]; return o.pins.map(p=>({x:b[0]+p.u*bw, y:b[1]+p.v*bh, l:p.l})); }
function runtime(o){ return {...o, stroke:o.stroke||null, box:o.box.slice(), pins:o.pins.map(p=>({...p})), prev:null, mask:null, mb:null, miss:0, seen:0}; }
async function segmentObject(cv, W, H, o, P, shared){
  const E = shared || await samEncode(cv, cropRect(o.box, W, H, 0.22));
  o.pinsAbs = o.pins.length? pinsFor(o) : [];
  const prompts=[]; if(!o.pinOnly || o.prev) prompts.push({x:o.box[0],y:o.box[1],l:2},{x:o.box[2],y:o.box[3],l:3});
  for(const p of o.pinsAbs) prompts.push(p);
  // nascimento de um traço de pincel: o próprio traço é o palpite inicial da máscara
  const maskIn = o.prev ? warpLogits(o.prev, E) : (o.stroke ? strokeLogits(o.stroke, E) : null), small=!!(o.parent && o.pinOnly);
  const L=layerById(o.layer); st.wholeObject = !o.parent && !o.stroke && (L?.whole ?? true);
  let D=await samDecode(E, prompts, maskIn, small);
  if(maskIn && !o.stroke && !D.gone && D.score<0.7){ const D2=await samDecode(E, prompts, null, small); if(D2.score>D.score) D=D2; }
  if(o.stroke && !o.prev) o.stroke=null;   // o traço só vale no nascimento; depois segue pela memória
  o.score=D.score; o.prev={rect:E.rect, s:E.s, nw:E.nw, nh:E.nh, logits:D.logits};
  const M=cleanMask(logitsToMask(E, D.logits, !!L?.matting), o.pinsAbs, P); o.mask=M;
  const mb=maskBox(M); if(mb && !D.gone){ o.mb=mb; o.miss=0; } else { o.mb=null; o.miss=(o.miss||0)+1; }
  return o;
}
async function segmentFresh(cv, W, H, o, P, shared){ o.prev=null; await segmentObject(cv,W,H,o,P,shared); if(o.mb) await segmentObject(cv,W,H,o,P,shared); return o; }
function smoothBox(det, mb){ return mb? det.map((v,i)=>0.65*v+0.35*mb[i]) : det.slice(); }

/* um frame de rastreamento numa direção: casa detecções, cria novos, recorta todos os vivos */
async function trackStep(cv, W, H, live, dets, terms, P, allowNew, fi){
  if(dets){
    const pairs=[]; live.forEach((o,oi)=>{ if(o.k<0) return; const ref=o.mb||o.box; dets.forEach((d,di)=>{ if(d.k===o.k){ const v=iou(ref,d.b); if(v>0.25) pairs.push([v,oi,di]); } }); });
    pairs.sort((a,b)=>b[0]-a[0]); const usedO=new Set(), usedD=new Set();
    for(const [,oi,di] of pairs){ if(usedO.has(oi)||usedD.has(di)) continue; usedO.add(oi); usedD.add(di); live[oi].box=smoothBox(dets[di].b, live[oi].mb); live[oi].seen=0; }
    live.forEach((o,oi)=>{ if(o.k>=0 && !usedO.has(oi)){ if(o.mb) o.box=o.mb.slice(); o.seen=(o.seen||0)+1; } });
    if(allowNew) for(let di=0;di<dets.length;di++){ const d=dets[di]; if(usedD.has(di)||d.conf<P.conf) continue;
      if(live.some(o=>o.k===d.k && iou(o.mb||o.box,d.b)>0.15)) continue;
      const t=terms[d.k]; live.push(runtime({id:"n"+(st.nextId++), layer:t.layer, k:d.k, sign:t.sign, label:t.label, active:true, fb:fi, box:d.b.slice(), pins:[], conf:d.conf})); }
  }
  for(const o of live) if(o.k<0 && o.mb) o.box=o.mb.slice();
  const act=live.filter(o=>o.active && o.miss<=2 && (o.k<0 || o.seen<=P.hold));
  const shared = act.length>4 ? await samEncode(cv,{x:0,y:0,w:W,h:H}) : null;
  for(const o of act) await segmentObject(cv, W, H, o, P, shared);
  for(const o of live) if(!act.includes(o)) o.mask=null;
}
/* compõe por camada: positivos (máx) e negativos (máx) */
function composeLayers(live, W, H){
  const out={};
  const isPart=o=>!!layerById(o.layer)?.partOf; for(const o of live) delete o._area;
  // primeiro os objetos inteiros, depois as partes (que precisam do inteiro pronto)
  const order=[...live.filter(o=>!isPart(o)), ...live.filter(isPart)];
  for(const o of order){ if(!o.mask || !o.active) continue; const R=o.mask.rect, d=o.mask.data, key=o.sign>0?"pos":"neg";
    const L=layerById(o.layer);
    if(L?.partOf && o.sign>0){ const par=out[L.partOf]?.pos; let a=0, inside=0;
      if(par){ for(let y=0;y<R.h;y++){ const row=(R.y+y)*W+R.x, src=y*R.w; for(let x=0;x<R.w;x++) if(d[src+x]>=0.5){ a++; if(par[row+x]>=0.5) inside++; } } }
      // o carro (objeto inteiro) que mais cobre esta parte, e a área total dele
      let parArea=0, best=0; for(const p of order){ if(p.layer!==L.partOf || !p.mask || !p.mb || !o.mb || p.sign<0) continue;
        const ix=Math.max(0,Math.min(p.mb[2],o.mb[2])-Math.max(p.mb[0],o.mb[0])), iy=Math.max(0,Math.min(p.mb[3],o.mb[3])-Math.max(p.mb[1],o.mb[1])), ov=ix*iy;
        if(ov>best){ best=ov; parArea = p._area ??= p.mask.data.reduce((s,v)=>s+(v>=0.5?1:0),0); } }
      // fora do carro, ou do tamanho do carro inteiro → não é roda/vidro
      if(!par || !a || inside/a<0.6 || !parArea || a>0.55*parArea){ o.mask=null; o.miss=(o.miss||0)+1; continue; }
      for(let y=0;y<R.h;y++){ const row=(R.y+y)*W+R.x, src=y*R.w; for(let x=0;x<R.w;x++) d[src+x]*=Math.min(1, par[row+x]*1.6); } }
    const OL=(out[o.layer] ||= {}); const buf=(OL[key] ||= new Float32Array(W*H));
    for(let y=0;y<R.h;y++){ const row=(R.y+y)*W+R.x, src=y*R.w; for(let x=0;x<R.w;x++){ const v=d[src+x]; if(v>buf[row+x]) buf[row+x]=v; } } }
  return out;
}

/* ---- gerar: (A) lê e detecta, (B) rastreia para frente e para trás a partir de cada nascimento, (C) monta ---- */
async function runAll(){
  const v=st.video; if(!v) return;
  await loadEngine();
  const terms=allTerms(); if(terms.some(t=>t.idx<0)) throw new Error("Há termos que o modelo não conhece (em vermelho). Escolha uma sugestão.");
  if(!st.objs.some(o=>o.active && o.sign>0) && !terms.some(t=>t.sign>0)) throw new Error("Nada para rastrear: escreva o que separar ou marque com pins e caixas.");
  if(st.layers.some(L=>L.on && L.matting)) await loadRvm();
  const P=readParams(), W=v.W, H=v.H, N=v.nFrames, t0=performance.now();
  savePresetMemory();
  st.running=true; st.stop=false; setSteps("track"); uiRunning(true);
  try{
    // (A) frames guardados + detecções de texto
    const frames=new Array(N), dets=new Array(N), cv=makeCanvases(W,H); let n=0;
    for await (const f of decodeAll(v)){
      if(st.stop) { f.close(); break; }
      const i=frameIdx(v,f.timestamp); drawFrame(f,cv.fx,W,H,v.rot); f.close();
      frames[i]=await cv.fc.convertToBlob({type:"image/jpeg", quality:0.95});
      if(terms.length) dets[i]=await detect(cv,W,H,terms,Math.min(P.conf,0.2));
      n++; setBar(0.25*n/N); setStatus(`Lendo e procurando: frame ${n}/${N}`);
    }
    if(st.stop) throw new Error("Parado.");
    for(let i=0;i<N;i++) if(!frames[i]){ for(let d=1;d<N;d++){ const j=frames[i-d]?i-d:frames[i+d]?i+d:-1; if(j>=0){ frames[i]=frames[j]; dets[i]=dets[j]; break; } } }
    let models=st.objs.filter(o=>o.active);
    const fbs=models.map(o=>o.fb); const minFb=fbs.length?Math.min(...fbs):0, maxFb=fbs.length?Math.max(...fbs):0;
    const run={N, frames, dets, layers:st.layers.filter(L=>L.on).map(L=>L.id), fwd:{}, bwd:{}, boxes:Array.from({length:N},()=>[])};
    for(const id of run.layers){ run.fwd[id]={pos:new Array(N),neg:new Array(N)}; run.bwd[id]={pos:new Array(N),neg:new Array(N)}; }
    const allowNew = st.sel==="all" && terms.length>0;
    const twoWay = models.length>0, total = twoWay ? (N-minFb)+(maxFb+1) : N; let done=0;
    const sweep=async(dir)=>{
      const live=[]; const start = dir>0 ? (models.length?minFb:0) : (models.length?maxFb:N-1), end = dir>0 ? N : -1;
      for(let i=start;i!==end;i+=dir){
        if(st.stop) return;
        const bm=await createImageBitmap(frames[i]); cv.fx.drawImage(bm,0,0); bm.close();
        for(const o of models) if(o.fb===i) live.push(runtime(o));   // nasce aqui: primeiro recorte só com caixa/pins
        await trackStep(cv,W,H,live, terms.length?dets[i]:null, terms, P, allowNew && (dir>0 || i<minFb), i);   // na volta, só cria novos antes do primeiro nascimento (depois a ida já cobre)
        const comp=composeLayers(live,W,H);
        if(P.edge>0) for(const id in comp) if(comp[id].pos) guidedRegion(cv, comp[id].pos, W, H, Math.max(1,Math.round(P.edge*Math.max(W,H)/1920)));
        const store = dir>0 ? run.fwd : run.bwd;
        for(const id of run.layers){ const c=comp[id]; if(!c) continue; if(c.pos) store[id].pos[i]=await pngGray(f2u8(c.pos),W,H); if(c.neg) store[id].neg[i]=await pngGray(f2u8(c.neg),W,H); }
        for(const o of live) if(o.mask && o.mb) run.boxes[i].push({id:o.id, base:o.parent? o.parent : o.id, layer:o.layer, box:o.mb.slice(), sign:o.sign});
        done++; const el=(performance.now()-t0)/1000; setBar(0.25+0.65*done/total);
        setStatus(`Rastreando ${dir>0?"para frente":"para trás"}: frame ${i} · ${(el/Math.max(1,done)).toFixed(2)} s/frame · faltam ~${fmtTime(el/Math.max(1,done)*(total-done))}`);
        if(done%4===0) showFrame(i);
        // tira quem saiu de cena há muito tempo
        for(let k=live.length-1;k>=0;k--){ const o=live[k]; if(o.miss>6 || (o.k>=0 && o.seen>P.hold+6)) live.splice(k,1); }
      }
    };
    await sweep(+1); if(st.stop) throw new Error("Parado.");
    if(twoWay){ await sweep(-1); if(st.stop) throw new Error("Parado."); }
    run.trackTime=(performance.now()-t0)/1000; st.run=run;
    await assemble();
  } finally { st.running=false; uiRunning(false); }
}

/* ---- montar: junta frente/trás, matting, acabamento, codifica ---- */
async function assemble(){
  const v=st.video, run=st.run, P=readParams(), W=v.W, H=v.H, N=run.N, name=base(v.name);
  st.running=true; uiRunning(true); setSteps(st.refine?"refine":"export");
  try{
    const layers=run.layers.map(layerById).filter(Boolean), zip=new JSZip(), t0=performance.now();
    const tw=Math.min(480,W), th=Math.round(tw*H/W), tctx=new OffscreenCanvas(tw,th).getContext("2d",{willReadFrequently:true}), mc=new OffscreenCanvas(W,H), mx=mc.getContext("2d"), mimg=mx.createImageData(W,H);
    const out={thumbs:{}, cov:{}, png:{}, all:[], allThumbs:[], tw, th, refined:!!R};
    for(const L of layers){ out.thumbs[L.id]=new Array(N); out.cov[L.id]=new Array(N); out.png[L.id]=new Array(N); }
    const needRvm = layers.some(L=>L.matting); const rvmState={}; const cv=makeCanvases(W,H);
    const base_=new Map(); // cache de frames base (antes da estabilização) por camada
    const getBase=async(L,i)=>{ const key=L.id+":"+i; if(base_.has(key)) return base_.get(key);
      const F=run.fwd[L.id], B=run.bwd[L.id]; const [pf,pb,nf,nb]=await Promise.all([pngToFloat(F.pos[i],W,H),pngToFloat(B.pos[i],W,H),F.neg[i]?pngToFloat(F.neg[i],W,H):null,B.neg[i]?pngToFloat(B.neg[i],W,H):null]);
      const q=new Float32Array(W*H); for(let k=0;k<q.length;k++){ let p=Math.max(pf[k],pb[k]); const ng=Math.max(nf?nf[k]:0, nb?nb[k]:0); q[k]=p*(1-ng); }
      if(L.matting && st.rvm){ const ph=rvmCache.get(i); if(ph) { const m=mattingMerge(q,ph,W,H); base_.set(key,m); return m; } }
      base_.set(key,q); return q; };
    const rvmCache=new Map();
    // refino (etapa 2): piscadas → ilhas/furos → colar na borda da imagem
    const R=st.refine, rb=R?R.blip:0, ref_=new Map();
    const getRef=async(L,i)=>{ if(!R) return getBase(L,i); const key=L.id+":"+i; if(ref_.has(key)) return ref_.get(key);
      const c=await getBase(L,i); let q=Float32Array.from(c);
      if(rb>0){ const nb=[]; for(let k=i-rb;k<=i+rb;k++) if(k!==i&&k>=0&&k<N) nb.push(await getBase(L,k));
        if(nb.length>=2){ const n=nb.length; for(let k=0;k<q.length;k++){ let on=0, s=0; for(const a of nb){ const x=a[k]; s+=x; if(x>=0.5) on++; }
          if(c[k]>=0.5 ? on<=Math.floor(n*0.2) : on>=Math.ceil(n*0.8)) q[k]=s/n; } } }
      if(R.isl>0||R.hole>0) cleanFrame(q,W,H,R.isl,R.hole);
      if(R.snap>0){ const bm=await createImageBitmap(run.frames[i]); cv.fx.drawImage(bm,0,0); bm.close(); guidedRegion(cv,q,W,H,Math.max(1,Math.round(R.snap*Math.max(W,H)/1920))); }
      ref_.set(key,q); return q; };
    const toThumb=async(u8)=>{ for(let k=0,j=0;k<u8.length;k++,j+=4){ mimg.data[j]=mimg.data[j+1]=mimg.data[j+2]=u8[k]; mimg.data[j+3]=255; } mx.putImageData(mimg,0,0);
      tctx.drawImage(mc,0,0,tw,th); const d=tctx.getImageData(0,0,tw,th).data, t=new Uint8Array(tw*th); for(let k=0,j=0;k<t.length;k++,j+=4) t[k]=d[j]; return t; };
    for(let i=0;i<N;i++){
      if(st.stop) throw new Error("Parado.");
      // matting precisa dos frames em ordem (memória do RVM): calcula o alfa do frame i+smooth à frente
      if(needRvm){ for(let j=rvmCache.size? Math.max(...rvmCache.keys())+1 : 0; j<=Math.min(N-1,i+P.smooth+rb); j++){ const bm=await createImageBitmap(run.frames[j]); cv.fx.drawImage(bm,0,0); bm.close(); rvmCache.set(j, await rvmStep(rvmState,cv,W,H)); } }
      let all=null;
      for(const L of layers){
        let q; if(P.smooth>0){ const ks=[]; for(let k=i-P.smooth;k<=i+P.smooth;k++) if(k>=0&&k<N) ks.push(k); const arr=[]; for(const k of ks) arr.push(await getRef(L,k)); const c=await getRef(L,i);
          q=new Float32Array(W*H); const n=arr.length;
          for(let k=0;k<q.length;k++){ let s=0, mn=1, mx=0; for(const a of arr){ const x=a[k]; s+=x; if(x<mn) mn=x; if(x>mx) mx=x; } q[k]= mx-mn>0.6 ? c[k] : s/n; } } // tremido de borda é médio; movimento real mantém o frame
        else q=await getRef(L,i);
        const m=finish(q,W,H,P);
        if(!all) all=new Float32Array(W*H); for(let k=0;k<m.length;k++) if(m[k]>all[k]) all[k]=m[k];
        const u8=toU8(m,P.invert); out.png[L.id][i]=await pngGray(u8,W,H); out.thumbs[L.id][i]=await toThumb(toU8(m,false));
        let s=0; for(let k=0;k<m.length;k+=97) s+=m[k]; out.cov[L.id][i]=s/(m.length/97);
      }
      const ua=toU8(all||new Float32Array(W*H),P.invert); out.all[i]=await pngGray(ua,W,H); out.allThumbs[i]=await toThumb(toU8(all||new Float32Array(W*H),false));
      const keep=P.smooth+rb+1;
      for(const k of [...base_.keys()]){ const fi=+k.split(":")[1]; if(fi<i-keep) base_.delete(k); }
      for(const k of [...ref_.keys()]){ const fi=+k.split(":")[1]; if(fi<i-keep) ref_.delete(k); }
      for(const k of [...rvmCache.keys()]) if(k<i-keep-1) rvmCache.delete(k);
      setBar(0.9+0.06*(i+1)/N); if(i%6===0) setStatus(`Montando ${i+1}/${N}…`);
    }
    st.out=out;
    // arquivos
    const outputs=[]; if($("#outAll").checked || layers.length===1) outputs.push({key:"all", label:layers.length===1?slug(layers[0].name):"tudo", png:out.all});
    if(layers.length>1) for(const L of layers) outputs.push({key:L.id, label:slug(L.name), png:out.png[L.id]});
    let enc=0;
    for(const o of outputs){
      if($("#outPng").checked){ const dir=zip.folder(`${name}_${o.label}_png`); o.png.forEach((b,i)=>dir.file(`${name}_${o.label}_${String(i).padStart(5,"0")}.png`, b)); }
      if($("#outMp4").checked){ setStatus(`Codificando ${o.label}.mp4…`); const r=await encodeMp4(o.png,v); zip.file(`${name}_${o.label}.mp4`, r.buf); enc=r.chunks; }
    }
    // conferência e relatório
    const sus=[]; for(const L of layers){ const c=out.cov[L.id]; for(let i=1;i<N-1;i++){ const m=(c[i-1]+c[i+1])/2; if(m>0.002 && Math.abs(c[i]-m)/m>0.12 && Math.abs(c[i-1]-c[i+1])/Math.max(m,1e-6)<0.06) sus.push(i); } }
    st.suspects=[...new Set(sus)].sort((a,b)=>a-b);
    zip.file(`${name}_projeto.json`, JSON.stringify(projectJson(),null,1));
    zip.file(`${name}_relatorio.json`, JSON.stringify({video:v.name, largura:W, altura:H, frames:N, fps:+v.fps.toFixed(4), camadas:layers.map(L=>({nome:L.name, prompt:L.prompt, matting:L.matting})),
      parametros:P, recortador:cutterName(st.cutter), detector:"YOLOE-"+st.detKind.toUpperCase(), motor:st.engine, frames_suspeitos:st.suspects,
      tempo_rastreamento_s:+(run.trackTime||0).toFixed(1), tempo_montagem_s:+((performance.now()-t0)/1000).toFixed(1)},null,1));
    setStatus("Gerando o ZIP…");
    st.zipBlob=await zip.generateAsync({type:"blob",compression:"STORE"}); st.zipName=`${name}_mascaras.zip`;
    const ck=$("#checks"); ck.textContent=""; $("#checksGroup").hidden=false;
    const items=[[true,`${N} de ${N} frames em cada camada, mesmos tempos e resolução ${W}×${H}`],[!$("#outMp4").checked||enc===N, $("#outMp4").checked?`MP4 com ${enc} frames`:"MP4 desligado"],
      [!st.suspects.length, st.suspects.length?`Revise os frames ${st.suspects.slice(0,10).join(", ")}${st.suspects.length>10?"…":""} (marcados em amarelo na linha do tempo)`:"Sem saltos de área entre frames"]];
    for(const [y,t] of items){ const d=document.createElement("div"); d.className=y?"":"n"; d.textContent=t; ck.append(d); }
    setStatus("Analisando a qualidade…"); await analyzeAll();
    setBar(1); $("#saveBtn").disabled=false; $("#finishBtn").disabled=false;
    setStatus(`Pronto. Rastreamento ${fmtTime(run.trackTime||0)}, montagem ${fmtTime((performance.now()-t0)/1000)}.${st.quality?` Nota ${st.quality.score}/100 (aba Refino).`:""} Baixe o ZIP no topo.`);
    drawTimeline(); drawView();
  } finally { st.running=false; uiRunning(false); }
}
async function encodeMp4(pngs, v){
  const W=v.W, H=v.H, N=pngs.length; let chunks=0, err=null, cfg=null;
  const br=Math.min(60e6, Math.max(6e6, W*H*v.fps*0.12));
  for(const c of ["avc1.640034","avc1.640033","avc1.640028","avc1.4d0028"]){ const t={codec:c,width:W,height:H,bitrate:br,framerate:v.fps,avc:{format:"avc"},latencyMode:"quality"}; const s=await VideoEncoder.isConfigSupported(t).catch(()=>({supported:false})); if(s.supported){ cfg=t; break; } }
  if(!cfg) throw new Error(`O navegador não codifica H.264 em ${W}×${H}. Desmarque o MP4 e use a sequência PNG.`);
  const muxer=new Mp4Muxer.Muxer({target:new Mp4Muxer.ArrayBufferTarget(), video:{codec:"avc",width:W,height:H,frameRate:Math.round(v.fps)}, fastStart:"in-memory", firstTimestampBehavior:"offset"});
  const enc=new VideoEncoder({output:(c,m)=>{ muxer.addVideoChunk(c,m); chunks++; }, error:e=>{ err=e; }}); enc.configure(cfg);
  for(let i=0;i<N;i++){ while(enc.encodeQueueSize>4) await sleep(4); if(err) throw err;
    const bm=await createImageBitmap(pngs[i]); const dur=i+1<N? v.ts[i+1]-v.ts[i] : Math.round(1e6/v.fps);
    const vf=new VideoFrame(bm,{timestamp:v.ts[i], duration:dur}); enc.encode(vf,{keyFrame:i%Math.max(1,Math.round(v.fps))===0}); vf.close(); bm.close(); }
  await enc.flush(); enc.close(); if(err) throw err; muxer.finalize(); return {buf:muxer.target.buffer, chunks};
}
/* projeto para o motor pesado (Python): tudo em coordenadas do quadro */
function projectJson(){
  const v=st.video, terms=allTerms();
  return { versao:1, video:{nome:v.name, largura:v.W, altura:v.H, frames:v.nFrames, fps:v.fps, tempos_us:v.ts},
    camadas: st.layers.map(L=>({id:L.id, nome:L.name, prompt:L.prompt, ligada:L.on, matting:L.matting, parte_de:L.partOf||null, termos:layerTerms(L).map(t=>({en:t.en, subtrai:t.sign<0}))})),
    objetos: st.objs.map(o=>({id:o.id, camada:o.layer, termo:o.k>=0? terms[o.k]?.en : null, subtrai:o.sign<0, ligado:o.active, nascimento:o.fb, caixa:o.box.map(Math.round),
      pins:pinsFor(o).map(p=>({x:Math.round(p.x), y:Math.round(p.y), entra:p.l===1})), so_pins:!!o.pinOnly, peca_de:o.parent||null})),
    novos_objetos: st.sel==="all", parametros: readParams() };
}

/* ---- etapa 2: análise de qualidade (ilhas, furos, piscadas, borda × imagem) ---- */
async function analyzeAll(){
  const O=st.out, run=st.run, v=st.video; if(!O||!run) return null;
  const tw=O.tw, th=O.th, N=run.N, gx=new OffscreenCanvas(tw,th).getContext("2d",{willReadFrequently:true});
  const layers=run.layers.map(layerById).filter(Boolean), per=[];
  for(let i=0;i<N;i++){
    const bm=await createImageBitmap(run.frames[i]); gx.drawImage(bm,0,0,tw,th); bm.close();
    const d=gx.getImageData(0,0,tw,th).data, gray=new Float32Array(tw*th); for(let k=0,j=0;k<gray.length;k++,j+=4) gray[k]=(0.299*d[j]+0.587*d[j+1]+0.114*d[j+2])/255;
    const fr={i, isl:0, hole:0, blip:0, edge:1, fg:0};
    for(const L of layers){ const T=O.thumbs[L.id]; const a=analyzeThumb(T[i], T[i-1], T[i+1], gray, tw, th); if(!a.fg) continue;
      fr.isl=Math.max(fr.isl,a.isl); fr.hole=Math.max(fr.hole,a.hole); fr.blip=Math.max(fr.blip,a.blip); fr.edge=Math.min(fr.edge,a.edge); fr.fg+=a.fg; }
    // nota: 100 menos penalidades (cada critério tem um teto)
    fr.pIsl=Math.min(25, fr.isl*400); fr.pHole=Math.min(15, fr.hole*300); fr.pBlip=Math.min(35, fr.blip*350); fr.pEdge=Math.min(25, Math.max(0,0.85-fr.edge)*60);
    fr.score=fr.fg? Math.round(100-fr.pIsl-fr.pHole-fr.pBlip-fr.pEdge) : 100; per.push(fr);
    if(i%10===0) await sleep(0);
  }
  const avg=k=>per.reduce((s,f)=>s+f[k],0)/Math.max(1,per.length);
  const res={per, score:Math.round(avg("score")), isl:avg("pIsl"), hole:avg("pHole"), blip:avg("pBlip"), edge:avg("pEdge")};
  st.quality=res; renderQuality(); drawTimeline(); return res;
}
