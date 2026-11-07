/* ============ interface ============ */
const view=$("#view"), vctx=view.getContext("2d"), vid=$("#vid");
let busy=false, drag=null, srcURL=null;
async function guarded(fn){ if(busy||st.running) return; busy=true; try{ await fn(); }catch(e){ setStatus(e.message); console.error(e); } finally{ busy=false; } }
function setSteps(now){ const order=["video","mark","track","export"], k=order.indexOf(now); $$("#steps li").forEach((li,i)=>{ li.className = i<k?"done": i===k?"now":""; }); }
function uiRunning(on){ $("#runBtn").disabled=on; $("#stopBtn").hidden=!on; $("#stopBtn").disabled=!on; $("#testBtn").disabled=on; $("#finishBtn").disabled=on||!st.run; if(!on) st.stop=false; }

/* ---- abas ---- */
$$(".tabs button").forEach(b=>b.onclick=()=>{ $$(".tabs button").forEach(x=>x.setAttribute("aria-selected",x===b)); $$(".pane").forEach(p=>p.hidden=p.dataset.pane!==b.dataset.tab); });

/* ---- predefinições e camadas ---- */
const PRESET_ICONS={
  livre:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 18c3-8 6-12 8-12s3 4 8 12"/></svg>',
  pessoa:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="7" r="3.2"/><path d="M5.5 20c.8-4.2 3.3-6.5 6.5-6.5s5.7 2.3 6.5 6.5"/></svg>',
  carro:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3.5 15.5v-3l2-4.5h11l3 4.5h1v3"/><circle cx="7.5" cy="16" r="1.8"/><circle cx="16.5" cy="16" r="1.8"/><path d="M9.3 16h5.4M5.5 12.5h14"/></svg>',
  produto:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M10 3h4v3l2 3v12H8V9l2-3z"/><path d="M8 13h8"/></svg>'};
function renderPresets(){ const box=$("#presets"); box.textContent="";
  for(const [id,p] of Object.entries(PRESETS)){ const b=document.createElement("button"); b.className="preset"; b.setAttribute("aria-pressed", st.preset===id); b.innerHTML=PRESET_ICONS[id]+`<span>${p.name}</span>`;
    b.onclick=()=>{ if(st.running) return; if(st.objs.length && st.preset!==id && !confirmInline(`Trocar para ${p.name} apaga as marcações atuais.`)) return; applyPreset(id); renderAll(); }; box.append(b); } }
let confirmArm=null; function confirmInline(msg){ if(confirmArm===msg){ confirmArm=null; return true; } confirmArm=msg; setStatus(msg+" Clique de novo para confirmar."); setTimeout(()=>{ if(confirmArm===msg) confirmArm=null; },4000); return false; }
const ICON_X='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_EYE='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
const ICON_EYEOFF='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 3l18 18M10.6 6c.5-.1.9-.1 1.4-.1 6 0 9.5 6.5 9.5 6.5a17 17 0 01-3 3.6M6.4 7.6A16.6 16.6 0 002.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1"/></svg>';
const PERSON_EN=new Set(["person","man","woman","child","boy","girl","baby","people"]);
function isPersonLayer(L){ return L.matting || layerTerms(L).some(t=>t.sign>0 && PERSON_EN.has(t.en)); }
function renderLayers(){
  const box=$("#layers"); box.textContent="";
  for(const L of st.layers){
    const c=document.createElement("div"); c.className="layer"+(L.id===st.activeLayer?" active":"")+(L.on?"":" off"); c.style.setProperty("--lc",L.color);
    c.innerHTML=`<div class="lhead"><span class="swatch"></span><input class="lname" aria-label="Nome da camada"><button class="icon-btn" data-a="eye" title="${L.on?"Desligar":"Ligar"} camada">${L.on?ICON_EYE:ICON_EYEOFF}</button>${st.layers.length>1?`<button class="icon-btn" data-a="del" title="Remover camada">${ICON_X}</button>`:""}</div>
      <input class="prompt" aria-label="O que entra nesta camada" placeholder="ex.: carro, -vidro (ou vazio e marque com pins)">
      <div class="terms"></div>
      <div class="lfoot" ${isPersonLayer(L)?"":"hidden"}><label class="ck"><input type="checkbox" data-a="matte"> Borda fina de pessoa (cabelo, roupa)</label></div>`;
    const nm=c.querySelector(".lname"); nm.value=L.name; nm.oninput=()=>{ L.name=nm.value||"Camada"; drawTimeline(); };
    const pr=c.querySelector(".prompt"); pr.value=L.prompt; pr.oninput=()=>{ L.prompt=pr.value; renderTerms(c.querySelector(".terms"),L,pr); c.querySelector(".lfoot").hidden=!isPersonLayer(L); };
    c.querySelector('[data-a=matte]').checked=L.matting; c.querySelector('[data-a=matte]').onchange=e=>{ L.matting=e.target.checked; };
    c.querySelector('[data-a=eye]').onclick=e=>{ e.stopPropagation(); L.on=!L.on; renderLayers(); drawView(); drawTimeline(); };
    const del=c.querySelector('[data-a=del]'); if(del) del.onclick=e=>{ e.stopPropagation(); st.layers=st.layers.filter(x=>x!==L); st.objs=st.objs.filter(o=>o.layer!==L.id); if(st.activeLayer===L.id) st.activeLayer=st.layers[0].id; renderAll(); };
    c.addEventListener("pointerdown",e=>{ if(e.target.closest("input,button")) return; st.activeLayer=L.id; renderLayers(); drawView(); });
    pr.addEventListener("focus",()=>{ if(st.activeLayer!==L.id){ st.activeLayer=L.id; $$(".layer").forEach(x=>x.classList.toggle("active",x===c)); } });
    renderTerms(c.querySelector(".terms"),L,pr); box.append(c);
  }
}
function renderTerms(box, L, input){
  box.textContent=""; const ts=layerTerms(L);
  for(const t of ts){ const el=document.createElement("span"); el.className="term"+(t.idx<0?" miss":t.sign<0?" neg":"");
    el.textContent=(t.sign<0?"− ":"")+t.label; const i=document.createElement("i"); i.textContent = t.idx<0 ? (st.vocab?"desconhecido":"…") : (norm(t.label)!==t.en? t.en : ""); if(i.textContent) el.append(i);
    if(t.idx<0 && t.sugg.length){ const sg=document.createElement("span"); sg.className="sugg"; for(const s of t.sugg){ const b=document.createElement("button"); b.type="button"; b.textContent=s;
        b.onclick=()=>{ const parts=L.prompt.split(/[,;]/); const k=parts.findIndex(p=>p.trim()&&resolveTerm(p).label===t.label); if(k>=0){ parts[k]=(t.sign<0?"-":"")+s; L.prompt=parts.map(x=>x.trim()).join(", "); input.value=L.prompt; renderTerms(box,L,input); } }; sg.append(b); } el.append(sg); }
    box.append(el); }
}
$("#addLayer").onclick=()=>{ const L=newLayer({name:`Camada ${st.layers.length+1}`, prompt:""}, st.layers.length); st.layers.push(L); st.activeLayer=L.id; renderLayers(); };
function objName(o){ const same=st.objs.filter(x=>x.label===o.label && x.layer===o.layer); const n=same.indexOf(o); return (o.sign<0&&!o.parent?"Tira: ":"")+o.label+(same.length>1&&n>=0?` ${n+1}`:""); }
function renderObjs(){
  const box=$("#objs"); box.textContent="";
  if(!st.objs.length){ box.innerHTML='<p class="empty">Nada marcado ainda. Analise um frame ou use Pin + e Caixa no monitor.</p>'; return; }
  for(const o of st.objs){ const L=layerById(o.layer); if(!L) continue;
    const r=document.createElement("label"); r.className="obj"; r.style.setProperty("--lc",L.color);
    r.innerHTML=`<input type="checkbox"><span class="sw"></span><span></span><span class="meta2"></span>`;
    const cb=r.querySelector("input"); cb.checked=o.active; cb.onchange=()=>{ o.active=cb.checked; if(st.edit) refreshDisp(); drawView(); };
    r.children[2].textContent=objName(o);
    r.children[3].textContent=`frame ${o.fb}`; r.title="Ir para o frame onde foi marcado";
    r.addEventListener("dblclick",()=>seekFrame(o.fb)); box.append(r); }
}
function renderAll(){ renderPresets(); renderLayers(); renderObjs(); drawView(); drawTimeline(); }

/* ---- monitor ---- */
function fitView(W,H){ const s=Math.min(1,1600/Math.max(W,H)); view.width=Math.round(W*s); view.height=Math.round(H*s); }
function curFrame(){ const v=st.video; if(!v) return 0; const t=Math.round((vid.currentTime||0)*1e6)+v.ts[0]; let lo=0,hi=v.ts.length-1; while(lo<hi){ const m=(lo+hi+1)>>1; if(v.ts[m]<=t+100) lo=m; else hi=m-1; } return lo; }
function seekFrame(i){ const v=st.video; if(!v) return; vid.pause(); vid.currentTime=(v.ts[clamp(i,0,v.nFrames-1)]-v.ts[0])/1e6+1e-3; }
let shownFrame=null; function showFrame(i){ shownFrame=i; seekFrame(i); }
function hexRgb(h){ const n=parseInt(h.slice(1),16); return [n>>16&255,n>>8&255,n&255]; }
function overlayCanvas(fi){
  const O=st.out; if(!O) return null; const tw=O.tw||Math.min(480,st.video.W), th=Math.round(tw*st.video.H/st.video.W);
  const c=new OffscreenCanvas(tw,th), x=c.getContext("2d"), img=x.createImageData(tw,th), d=img.data;
  if(st.view==="mask"){ const L=st.layers.length>1? layerById(st.activeLayer) : null; const m=L? O.thumbs[L.id]?.[fi] : O.allThumbs[fi]; if(!m) return null;
    for(let i=0,j=0;i<m.length;i++,j+=4){ d[j]=d[j+1]=d[j+2]=m[i]; d[j+3]=255; } }
  else { for(const L of st.layers){ if(!L.on) continue; const m=O.thumbs[L.id]?.[fi]; if(!m) continue; const [r,g,b]=hexRgb(L.color);
      for(let i=0,j=0;i<m.length;i++,j+=4){ const a=m[i]/255*0.55; if(a<=0) continue; d[j]=d[j]*(1-a)+r*a; d[j+1]=d[j+1]*(1-a)+g*a; d[j+2]=d[j+2]*(1-a)+b*a; d[j+3]=Math.max(d[j+3],m[i]*0.75); } } }
  x.putImageData(img,0,0); return c;
}
function drawView(){
  const v=st.video; if(!v) return; const W=view.width, H=view.height;
  if(vid.readyState>=2) vctx.drawImage(vid,0,0,W,H); else { vctx.fillStyle="#000"; vctx.fillRect(0,0,W,H); }
  const fi=curFrame(); $("#tc").innerHTML=`<b>${fi}</b> / ${v.nFrames-1} · ${(vid.currentTime||0).toFixed(2)} s`;
  const hud=[]; const E=st.edit;
  if(st.view!=="orig"){
    if(E && E.fi===fi){
      if(st.view==="mask"){ vctx.fillStyle="#000"; vctx.fillRect(0,0,W,H); }
      const sx=W/v.W, sy=H/v.H;
      for(const [,dd] of E.disp){ if(dd.ov) vctx.drawImage(dd.ov.c, dd.ov.rect.x*sx, dd.ov.rect.y*sy, dd.ov.rect.w*sx, dd.ov.rect.h*sy); }
      const k=view.width/Math.max(1,contentRect().width); vctx.font=`600 ${Math.round(12.5*k)}px ${getComputedStyle(document.body).getPropertyValue("--sans")}`;
      for(const [,dd] of E.disp){ const o=dd.o, L=layerById(o.layer); if(!L||!L.on) continue; const b=dd.mb||o.box;
        vctx.lineWidth=1.5*k; vctx.strokeStyle=o.active?L.color:"rgba(255,255,255,.4)"; vctx.setLineDash(o.k<0?[5*k,4*k]:[]); vctx.strokeRect(b[0]*sx,b[1]*sy,(b[2]-b[0])*sx,(b[3]-b[1])*sy); vctx.setLineDash([]);
        const lab=objName(dd.tpl||o); const tw=vctx.measureText(lab).width+12*k, th=20*k; vctx.fillStyle="rgba(16,17,20,.85)"; vctx.fillRect(b[0]*sx, Math.max(0,b[1]*sy-th), tw, th); vctx.fillStyle=o.active?L.color:"#aaa"; vctx.fillText(lab, b[0]*sx+6*k, Math.max(14*k,b[1]*sy-6*k));
        if(o.fb===fi) for(const p of (o.pins.length&&!o.pinOnly?pinsFor(o):[])){ vctx.beginPath(); vctx.arc(p.x*sx,p.y*sy,6*k,0,7); vctx.fillStyle=p.l===1?"#4ed69a":"#ff5a4e"; vctx.fill(); vctx.lineWidth=2*k; vctx.strokeStyle="#fff"; vctx.stroke(); } }
      if(drag){ vctx.strokeStyle="#f4f3ee"; vctx.setLineDash([6,4]); vctx.strokeRect(drag.x0*sx,drag.y0*sy,(drag.x1-drag.x0)*sx,(drag.y1-drag.y0)*sy); vctx.setLineDash([]); }
      hud.push(st.objs.some(o=>o.fb===fi && o.k>=0) ? "Frame analisado" : "Correção neste frame");
    } else { const c=overlayCanvas(fi); if(c) vctx.drawImage(c,0,0,W,H); if(st.view==="mask" && st.out) hud.push(st.layers.length>1? `Máscara: ${layerById(st.activeLayer)?.name}` : "Máscara"); }
  }
  if(st.suspects && st.suspects.includes(fi)) hud.push("Revisar este frame");
  $("#hud").innerHTML=hud.map(t=>`<span>${t}</span>`).join("");
}
vid.addEventListener("seeked",()=>{ drawView(); drawTimeline(); }); vid.addEventListener("loadeddata",drawView);
let raf=0; function loop(){ drawView(); drawTimeline(); if(!vid.paused) raf=requestAnimationFrame(loop); }
vid.addEventListener("play",()=>{ $("#playBtn").textContent="❚❚"; loop(); });
vid.addEventListener("pause",()=>{ $("#playBtn").textContent="▶"; cancelAnimationFrame(raf); drawView(); drawTimeline(); });
vid.loop=true;
$("#playBtn").onclick=()=>{ if(!st.video) return; vid.paused? vid.play().catch(()=>{}) : vid.pause(); };
$$("[data-v]").forEach(b=>b.onclick=()=>{ st.view=b.dataset.v; $$("[data-v]").forEach(x=>x.setAttribute("aria-pressed",x===b)); drawView(); });
$$("[data-sel]").forEach(b=>b.onclick=()=>{ st.sel=b.dataset.sel; $$("[data-sel]").forEach(x=>x.setAttribute("aria-pressed",x===b)); });

/* ---- linha do tempo ---- */
const tl=$("#tl"), tlx=tl.getContext("2d");
function drawTimeline(){
  const v=st.video, dpr=devicePixelRatio||1, w=tl.clientWidth; if(!w) return;
  const lanes=st.layers.filter(L=>L.on), h=26+lanes.length*10+10; tl.style.height=h+"px";
  if(tl.width!==Math.round(w*dpr)||tl.height!==Math.round(h*dpr)){ tl.width=Math.round(w*dpr); tl.height=Math.round(h*dpr); }
  const x=tlx; x.setTransform(dpr,0,0,dpr,0,0); x.clearRect(0,0,w,h); if(!v) return;
  const N=v.nFrames, X=i=>8+(w-16)*(N>1?i/(N-1):0);
  x.fillStyle="#41444c"; const step=Math.max(1,Math.ceil(N/60/5)*5); for(let i=0;i<N;i+=step){ const tall=i%(step*5)===0; x.fillRect(Math.round(X(i)),tall?4:8,1,tall?10:6); }
  x.font="11px "+getComputedStyle(document.body).getPropertyValue("--mono"); x.fillStyle="#8e919a"; for(let i=0;i<N;i+=step*5) x.fillText(String(i),X(i)+3,13);
  lanes.forEach((L,li)=>{ const y=22+li*10; x.fillStyle="#26282d"; x.fillRect(8,y,w-16,6);
    const cov=st.out?.cov?.[L.id]; if(cov){ const mx=Math.max(1e-6,...cov); const [r,g,b]=hexRgb(L.color);
      for(let i=0;i<N;i++){ const a=cov[i]/mx; if(a<=0) continue; x.fillStyle=`rgba(${r},${g},${b},${0.25+0.75*a})`; x.fillRect(X(i)-Math.max(1,(w-16)/N/2), y, Math.max(1.5,(w-16)/N), 6); } } });
  for(const i of st.suspects||[]){ x.fillStyle="#f2b94b"; x.fillRect(X(i)-1,h-6,2,5); }
  for(const o of st.objs){ const L=layerById(o.layer); if(!L) continue; const cx=X(o.fb), cy=18; x.fillStyle=L.color; x.beginPath(); x.moveTo(cx,cy-5); x.lineTo(cx+5,cy); x.lineTo(cx,cy+5); x.lineTo(cx-5,cy); x.closePath(); x.fill(); x.strokeStyle="#16171a"; x.lineWidth=1.5; x.stroke(); }
  const pf=curFrame(); x.fillStyle="#f4f3ee"; x.fillRect(Math.round(X(pf))-1,0,2,h);
}
let tlDrag=false; const tlSeek=e=>{ const v=st.video; if(!v) return; const r=tl.getBoundingClientRect(); const f=clamp((e.clientX-r.left-8)/(r.width-16),0,1); seekFrame(Math.round(f*(v.nFrames-1))); };
tl.addEventListener("pointerdown",e=>{ tlDrag=true; tl.setPointerCapture(e.pointerId); tlSeek(e); });
tl.addEventListener("pointermove",e=>{ if(tlDrag) tlSeek(e); }); tl.addEventListener("pointerup",()=>{ tlDrag=false; });
new ResizeObserver(()=>drawTimeline()).observe($("#timeline"));

/* ---- marcar: frame aberto para edição ---- */
function makeOv(dd, sc){ const M=dd.mask; if(!M){ dd.ov=null; return; } const o=dd.o, L=layerById(o.layer); const R=M.rect, w=Math.max(1,Math.round(R.w*sc)), h=Math.max(1,Math.round(R.h*sc));
  const c=new OffscreenCanvas(w,h), x=c.getContext("2d"), id=x.createImageData(w,h), col=o.sign<0?[80,150,255]:hexRgb(L?.color||"#ff5a4e"), alpha=o.active?140:55;
  for(let y=0;y<h;y++){ const sy=Math.min(R.h-1,Math.floor((y+0.5)/sc)); for(let xx=0;xx<w;xx++){ const sx=Math.min(R.w-1,Math.floor((xx+0.5)/sc)); const v=M.data[sy*R.w+sx]; const j=(y*w+xx)*4; id.data[j]=col[0]; id.data[j+1]=col[1]; id.data[j+2]=col[2]; id.data[j+3]=v*alpha; } }
  x.putImageData(id,0,0); dd.ov={c,rect:R}; }
async function openEdit(fi){
  const v=st.video, P=readParams(); setStatus("Lendo o frame…");
  const cv=await grabFrame(fi); const disp=new Map(); st.edit={fi, cv, disp};
  const sc=view.width/v.W; let n=0;
  // objetos que nascem aqui + o que o último rastreamento tinha neste frame (para poder corrigir)
  const here=st.objs.filter(o=>o.fb===fi);
  let fromRun=(st.run?.boxes?.[fi]||[]).filter(b=>!here.some(o=>o.id===b.id));
  // ainda sem rastreamento neste frame: acha os objetos pelo texto para os pins terem onde cair
  if(!st.run?.boxes?.[fi]){ const terms=allTerms().filter(t=>t.idx>=0); if(terms.length){ setStatus("Procurando os objetos neste frame…");
    const dets=await detect(cv,v.W,v.H,terms,P.conf); fromRun=dets.filter(d=>!here.some(o=>iou(o.box,d.b)>0.5)).map((d,j)=>({id:"d"+fi+"_"+j, base:null, layer:terms[d.k].layer, box:d.b, sign:terms[d.k].sign, label:terms[d.k].label})); } }
  const list=[...here.map(o=>({o:runtime(o), tpl:o})), ...fromRun.slice(0,8).map(b=>({o:runtime({id:b.id, layer:b.layer, k:-2, sign:b.sign, label:b.label||(st.objs.find(t=>t.id===b.id||t.id===b.base)?.label)||"objeto", active:true, fb:fi, box:b.box, pins:[]}), tpl:st.objs.find(t=>t.id===b.id)||null, run:true}))];
  const shared = list.length>4 ? await samEncode(cv,{x:0,y:0,w:v.W,h:v.H}) : null;
  for(const it of list){ setStatus(`Recortando ${++n}/${list.length}…`); const r=it.o; if(it.tpl && it.tpl.pinOnly){ r.pinOnly=true; } await segmentFresh(cv,v.W,v.H,r,P,shared);
    const dd={o:r, tpl:it.tpl, mask:r.mask, mb:r.mb}; if(it.run && it.tpl) r.active=it.tpl.active; makeOv(dd,sc); disp.set(r.id,dd); }
  setStatus(list.length? `${list.length} objeto(s) no frame ${fi}. Use os pins para corrigir.` : `Frame ${fi} aberto. Marque com Pin + ou Caixa.`);
  drawView();
}
async function reopenEdit(){ if(st.edit){ const f=st.edit.fi; await openEdit(f); } }
function refreshDisp(){ if(!st.edit) return; const sc=view.width/st.video.W; for(const [,dd] of st.edit.disp){ if(dd.tpl) dd.o.active=dd.tpl.active; makeOv(dd,sc); } }
async function analyze(){
  const v=st.video; if(!v) return;
  await loadEngine(); const terms=allTerms(); if(terms.some(t=>t.idx<0)) throw new Error("Há termos que o modelo não conhece (em vermelho). Escolha uma sugestão.");
  vid.pause(); const fi=curFrame(); setSteps("mark");
  const cv=await grabFrame(fi); const P=readParams();
  setStatus("Procurando pelo texto…");
  const dets=await detect(cv,v.W,v.H,terms,P.conf);
  st.objs=st.objs.filter(o=>o.k<0);   // texto é refeito; pins, caixas e correções ficam
  for(const d of dets){ const t=terms[d.k]; st.objs.push({id:"o"+(st.nextId++), layer:t.layer, k:d.k, sign:t.sign, label:t.label, active:true, fb:fi, box:d.b.slice(), pins:[], conf:d.conf}); }
  st.edit=null; await openEdit(fi); renderObjs(); drawTimeline();
  setStatus(`${dets.length} objeto(s) encontrados no frame ${fi}. Corrija com os pins se precisar e clique em Gerar máscaras.`);
}
$("#testBtn").onclick=()=>guarded(analyze);

// o canvas ocupa o monitor com object-fit: contain → calcula a área real da imagem
function contentRect(){ const r=view.getBoundingClientRect(), a=view.width/view.height; let w=r.width, h=r.width/a; if(h>r.height){ h=r.height; w=h*a; } return {left:r.left+(r.width-w)/2, top:r.top+(r.height-h)/2, width:w, height:h}; }
function viewToFrame(e){ const v=st.video, r=contentRect(); return {x:clamp((e.clientX-r.left)/r.width*v.W,0,v.W-1), y:clamp((e.clientY-r.top)/r.height*v.H,0,v.H-1)}; }
function dispAt(p){ let best=null, ba=Infinity; for(const [,dd] of st.edit.disp){ const M=dd.mask; let inside=false;
    if(M){ const x=Math.round(p.x-M.rect.x), y=Math.round(p.y-M.rect.y); inside=x>=0&&y>=0&&x<M.rect.w&&y<M.rect.h&&M.data[y*M.rect.w+x]>=0.5; }
    const b=dd.mb||dd.o.box, inBox=p.x>=b[0]&&p.x<=b[2]&&p.y>=b[1]&&p.y<=b[3];
    if(inside||inBox){ const a=(b[2]-b[0])*(b[3]-b[1])*(inside?0.5:1); if(a<ba){ ba=a; best=dd; } } } return best; }
async function ensureEdit(){ const fi=curFrame(); if(!st.edit || st.edit.fi!==fi){ await loadEngine(); await openEdit(fi); setSteps("mark"); } return st.edit; }
const TOOL_HINT={select:"Clique num objeto para ligar ou desligar.", plus:"Clique no que deve entrar. Fora de qualquer objeto, cria um objeto novo na camada ativa.", minus:"Clique no que deve sair. Vale em qualquer frame: a correção segue para frente e para trás.", box:"Arraste uma caixa em volta de um objeto novo (camada ativa). Com Shift, a caixa vira algo a tirar."};
function setTool(t){ st.tool=t; $$("[data-tool]").forEach(b=>b.setAttribute("aria-pressed",b.dataset.tool===t)); $("#toolHint").textContent=TOOL_HINT[t]; view.style.cursor=t==="select"?"default":"crosshair"; }
$$("[data-tool]").forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
view.addEventListener("pointerdown",e=>{
  if(!st.video || st.running) return; const p=viewToFrame(e);
  if(st.tool==="box"){ drag={x0:p.x,y0:p.y,x1:p.x,y1:p.y,neg:e.shiftKey}; view.setPointerCapture(e.pointerId); return; }
  guarded(async()=>{
    const E=await ensureEdit(), fi=E.fi, v=st.video, sc=view.width/v.W;
    const hit=dispAt(p);
    if(st.tool==="select"){ if(!hit) return; if(!hit.tpl){ setStatus("Esse objeto entrou sozinho no rastreamento. Para tirar, use Pin − sobre ele."); return; } hit.tpl.active=!hit.tpl.active; refreshDisp(); renderObjs(); drawView(); return; }
    const wantIn=!(st.tool==="minus"||e.shiftKey);
    if(hit && hit.tpl && hit.tpl.parent && hit.tpl.fb===fi){ // refina a peça
      const T=hit.tpl, l=(wantIn===(T.sign>0))?1:0, b=T.box, bw=Math.max(1,b[2]-b[0]), bh=Math.max(1,b[3]-b[1]); T.pins.push({u:(p.x-b[0])/bw, v:(p.y-b[1])/bh, l}); st.history.push({o:T,kind:"pin"});
      const r=runtime(T); await segmentFresh(E.cv,v.W,v.H,r,readParams(),null); hit.o=r; hit.mask=r.mask; hit.mb=r.mb; makeOv(hit,sc); drawView(); renderObjs(); setStatus(`Peça refinada.`); return; }
    if(!hit && !wantIn){ setStatus("Pin − precisa cair dentro de um objeto."); return; }
    const parent=hit?hit.o:null, region=parent?(parent.mb||parent.box):[0,0,v.W,v.H];
    const layer=parent?parent.layer:st.activeLayer;
    const T={id:"p"+(st.nextId++), layer, k:-1, sign:wantIn?1:-1, label: parent?(wantIn?`soma em ${parent.label}`:`tira de ${parent.label}`):(layerById(layer)?.name||"manual"), active:true, fb:fi, parent:parent?parent.id:null,
      region, box:region.slice(), pins:[{u:(p.x-region[0])/Math.max(1,region[2]-region[0]), v:(p.y-region[1])/Math.max(1,region[3]-region[1]), l:1}], pinOnly:true};
    setStatus("Recortando…"); await segPiece(E,T);
    st.objs.push(T); st.history.push({o:T,kind:"obj"}); renderObjs(); drawTimeline(); drawView();
    setStatus(`${wantIn?"Pin +":"Pin −"} no frame ${fi}: ${T.label}. A correção vale para frente e para trás.`);
  });
});
async function segPiece(E, T){
  const v=st.video, P=readParams(), sc=view.width/v.W, abs=pinsFor(T), reg=T.region;
  const r=runtime(T); r.pinOnly=true;
  let rect; if(T.parent){ const side=0.6*Math.max(reg[2]-reg[0],reg[3]-reg[1]), c=abs[0]; rect=cropRect([c.x-side/2,c.y-side/2,c.x+side/2,c.y+side/2],v.W,v.H,0); } else rect=cropRect(reg,v.W,v.H,0.08);
  const Enc=await samEncode(E.cv,rect); await segmentObject(E.cv,v.W,v.H,r,P,Enc);
  if(r.mb){ const nb=r.mb.slice(), bw=Math.max(1,nb[2]-nb[0]), bh=Math.max(1,nb[3]-nb[1]); T.pins=abs.map(p=>({u:(p.x-nb[0])/bw, v:(p.y-nb[1])/bh, l:p.l})); T.box=nb; T.pinOnly=false;
    const r2=runtime(T); await segmentFresh(E.cv,v.W,v.H,r2,P,null); E.disp.set(T.id,{o:r2,tpl:T,mask:r2.mask,mb:r2.mb}); }
  else E.disp.set(T.id,{o:r,tpl:T,mask:r.mask,mb:r.mb});
  makeOv(E.disp.get(T.id),sc);
}
view.addEventListener("pointermove",e=>{ if(!drag) return; const p=viewToFrame(e); drag.x1=p.x; drag.y1=p.y; drawView(); });
view.addEventListener("pointerup",()=>{ if(!drag) return; const d=drag; drag=null;
  const b=[Math.min(d.x0,d.x1),Math.min(d.y0,d.y1),Math.max(d.x0,d.x1),Math.max(d.y0,d.y1)]; if(b[2]-b[0]<8||b[3]-b[1]<8){ drawView(); return; }
  guarded(async()=>{ const E=await ensureEdit(), v=st.video; const L=layerById(st.activeLayer);
    const T={id:"b"+(st.nextId++), layer:L.id, k:-1, sign:d.neg?-1:1, label:d.neg?`tira de ${L.name}`:`caixa em ${L.name}`, active:true, fb:E.fi, box:b, pins:[]};
    const r=runtime(T); setStatus("Recortando…"); await segmentFresh(E.cv,v.W,v.H,r,readParams(),null);
    const dd={o:r,tpl:T,mask:r.mask,mb:r.mb}; makeOv(dd,view.width/v.W); E.disp.set(T.id,dd); st.objs.push(T); st.history.push({o:T,kind:"obj"}); renderObjs(); drawTimeline(); drawView(); setStatus(`Caixa adicionada em ${L.name} no frame ${E.fi}.`); });
});
$("#undoPin").onclick=()=>guarded(async()=>{ const h=st.history.pop(); if(!h) return; if(h.kind==="obj"){ st.objs=st.objs.filter(o=>o!==h.o); st.edit?.disp.delete(h.o.id); } else { h.o.pins.pop(); if(st.edit?.disp.has(h.o.id)){ const v=st.video, r=runtime(h.o); await segmentFresh(st.edit.cv,v.W,v.H,r,readParams(),null); const dd=st.edit.disp.get(h.o.id); dd.o=r; dd.mask=r.mask; dd.mb=r.mb; makeOv(dd,view.width/v.W); } }
  renderObjs(); drawTimeline(); drawView(); });
$("#clearPins").onclick=()=>guarded(async()=>{ if(!st.objs.some(o=>o.k<0)) return; if(!confirmInline("Apagar todos os pins, caixas e correções?")) return; for(const o of st.objs) if(o.k<0) st.edit?.disp.delete(o.id); st.objs=st.objs.filter(o=>o.k>=0); st.history=[]; renderObjs(); drawTimeline(); drawView(); setStatus("Pins, caixas e correções apagados."); });

/* ---- ajustes ---- */
for(const id of ["conf","edge","grow","feather","smooth","hold"]){ const el=$("#"+id), out=el.nextElementSibling;
  const fmt=()=>{ out.textContent= id==="conf"?(+el.value).toFixed(2) : id==="grow"?(el.value>0?"+":"")+el.value+" px" : id==="smooth"?(+el.value?"±"+el.value+" fr":"off") : id==="hold"?el.value+" fr" : id==="edge"?(+el.value?el.value+" px":"off") : (+el.value?el.value+" px":"off"); };
  el.addEventListener("input",fmt); fmt(); el.addEventListener("dblclick",()=>{ el.value=el.defaultValue; fmt(); }); }
$("#detector").addEventListener("change",()=>guarded(async()=>{ st.detPicked=true; if(!engineLoading) return; await engineLoading; await loadDetector($("#detector").value, fg); chip(engineLabel(),"on"); setStatus(`Detector ${$("#detector").value==="l"?"preciso":"rápido"} ativo.`); }));
$("#cutter").addEventListener("change",()=>{ st.cutterPicked=true; const want=$("#cutter").value; st.cutterWant=want;
  if(!engineLoading){ note(`${cutterName(want)} será carregado ao analisar o primeiro frame.`); return; }
  if(st.sess[want]){ if(useCutter(want)) guarded(reopenEdit); return; }
  if(want==="mobile") return;
  note(`${cutterName(want)}: preparando…`); upgradeSam(want); });

/* ---- vídeo ---- */
async function useFile(file){
  try{
    setStatus("Lendo o vídeo…"); $("#viewMsg").textContent="Lendo o vídeo…"; $("#viewMsg").hidden=false;
    const v=await openVideo(file); st.video=v; st.objs=[]; st.edit=null; st.run=null; st.out=null; st.suspects=[]; st.zipBlob=null; st.history=[];
    $("#saveBtn").disabled=true; $("#finishBtn").disabled=true; $("#checksGroup").hidden=true;
    if(srcURL) URL.revokeObjectURL(srcURL); srcURL=URL.createObjectURL(file); vid.addEventListener("loadeddata",()=>{ vid.currentTime=1e-3; },{once:true}); vid.src=srcURL;
    fitView(v.W,v.H); $("#fileName").textContent=file.name;
    $("#meta").innerHTML=[["Resolução",`${v.W}×${v.H}`],["Frames",v.nFrames],["FPS",v.fps.toFixed(3)],["Duração",v.dur.toFixed(2)+" s"],["Codec",v.codec.split(".")[0]],["Rotação",v.rot+"°"]]
      .map(([k,x])=>`<div><small>${k}</small><span>${x}</span></div>`).join("");
    $("#viewMsg").hidden=true; renderAll(); setSteps("video");
    setStatus(`${v.nFrames} frames prontos. Vá até um frame onde o objeto aparece inteiro e clique em Analisar este frame.`);
  }catch(e){ setStatus(e.message); $("#viewMsg").textContent=e.message; console.error(e); }
}
$("#pickBtn").onclick=()=>$("#file").click();
$("#file").onchange=e=>{ const f=e.target.files[0]; if(f) useFile(f); };
const scr=$("#screen");
scr.addEventListener("dragover",e=>{ if(e.dataTransfer.types.includes("Files")){ e.preventDefault(); $("#dropHint").hidden=false; } });
scr.addEventListener("dragleave",()=>{ $("#dropHint").hidden=true; });
scr.addEventListener("drop",e=>{ e.preventDefault(); $("#dropHint").hidden=true; const f=e.dataTransfer.files[0]; if(f) useFile(f); });

/* ---- gerar, acabamento, baixar, projeto ---- */
$("#runBtn").onclick=()=>{ if(st.running||busy) return; runAll().catch(e=>{ setStatus(e.message); console.error(e); }); };
$("#stopBtn").onclick=()=>{ st.stop=true; setStatus("Parando…"); };
$("#finishBtn").onclick=()=>{ if(st.running||!st.run) return; assemble().catch(e=>{ setStatus(e.message); console.error(e); }); };
function download(blob, name){ const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=name; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),60000); }
$("#saveBtn").onclick=()=>{ if(st.zipBlob){ download(st.zipBlob, st.zipName); setStatus("ZIP baixado."); } };
$("#projBtn").onclick=()=>{ if(!st.video) return; download(new Blob([JSON.stringify(projectJson(),null,1)],{type:"application/json"}), base(st.video.name)+"_projeto.json"); setStatus("Projeto salvo. Use com engine/deleon_mask.py --projeto."); };

/* ---- atalhos ---- */
document.addEventListener("keydown",e=>{
  if(e.target.closest("input,select,textarea")) return;
  const k=e.key.toLowerCase();
  if(k===" "){ e.preventDefault(); $("#playBtn").click(); }
  else if(k==="arrowright"){ seekFrame(curFrame()+(e.shiftKey?10:1)); }
  else if(k==="arrowleft"){ seekFrame(curFrame()-(e.shiftKey?10:1)); }
  else if((e.ctrlKey||e.metaKey)&&k==="z"){ e.preventDefault(); $("#undoPin").click(); }
  else if(k==="v") setTool("select"); else if(k==="a") setTool("plus"); else if(k==="s") setTool("minus"); else if(k==="b") setTool("box");
});
window.__dlm={st, analyze, runAll, assemble, viewToFrame, contentRect, seekFrame, curFrame};
