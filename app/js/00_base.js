"use strict";
/* ============ base: estado, utilitários, vocabulário ============ */
const PT_EN = /*PT_EN*/{};
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const S = 640, NSLOT = 8, NA = 8400;       // YOLOE
const SAMS = 1024, NP = 8;                 // SAM
const SAM_MEAN = [123.675,116.28,103.53], SAM_STD = [58.395,57.12,57.375];
const LAYER_COLORS = ["#ff5a4e","#3ec7f5","#f5c542","#a98bff","#4ed69a","#ff8ac9"];

const st = {
  models:null, vocab:null, vocabIdx:null,
  det:{}, detKind:null, enc:null, dec:null, cutter:null, sess:{}, rvm:null, engine:null,
  video:null,
  layers:[], activeLayer:null, preset:"livre",
  objs:[],            // modelos de objeto: {id, layer, k(termo global|-1), sign, label, active, fb, box, pins[{u,v,l}], parent, region, pinOnly, conf}
  edit:null,          // frame aberto para marcar: {fi, cv, disp: Map(id → {mask, mb})}
  run:null,           // último rastreamento: {N, fwd/bwd por camada, boxes[i], frames}
  out:null,           // última montagem: {thumbs[layer][i], cov[layer][i], zip}
  view:"over", tool:"select", sel:"all",
  running:false, stop:false, nextId:1, history:[],
};

const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().trim();
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const clamp = (v,a,b) => v<a?a:v>b?b:v;
function setStatus(t){ $("#status").textContent = t; }
function setBar(f){ $("#bar").style.width = (clamp(f,0,1)*100).toFixed(1)+"%"; }
function fmtTime(s){ if(!isFinite(s)) return "–"; s=Math.round(s); const m=Math.floor(s/60), r=s%60; return m? `${m} min ${r}s` : `${r}s`; }
function base(name){ return (name||"video").replace(/\.[^.]+$/,"").replace(/[^\w\-]+/g,"_"); }
function slug(s){ return norm(s).replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"") || "camada"; }
function iou(a,b){ const x1=Math.max(a[0],b[0]),y1=Math.max(a[1],b[1]),x2=Math.min(a[2],b[2]),y2=Math.min(a[3],b[3]); const i=Math.max(0,x2-x1)*Math.max(0,y2-y1); const u=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-i; return u>0?i/u:0; }
const layerById = id => st.layers.find(l=>l.id===id);

/* ---- prompt → termos do vocabulário ---- */
const PT_N = {}; for (const [k,v] of Object.entries(PT_EN)) PT_N[norm(k)] = v;
function lev(a,b){ const m=a.length,n=b.length; if(Math.abs(m-n)>3) return 9; const d=Array.from({length:n+1},(_,j)=>j);
  for(let i=1;i<=m;i++){ let p=d[0]; d[0]=i; for(let j=1;j<=n;j++){ const t=d[j]; d[j]=Math.min(d[j]+1,d[j-1]+1,p+(a[i-1]===b[j-1]?0:1)); p=t; } } return d[n]; }
function resolveTerm(raw){
  const sign = raw.trim().startsWith("-") ? -1 : 1;
  const label = raw.replace(/^[\s+\-]+/,"").trim(), n = norm(label);
  let en = PT_N[n] ?? n;
  if(!st.vocabIdx) return {label, sign, en, idx:-1, sugg:[]};
  let idx = st.vocabIdx.get(en);
  if(idx===undefined && PT_N[n]===undefined){ const w=n.split(/\s+/).map(x=>PT_N[x]??x).join(" "); if(st.vocabIdx.has(w)){ en=w; idx=st.vocabIdx.get(w); } }
  if(idx===undefined && en.endsWith("s") && st.vocabIdx.has(en.slice(0,-1))){ en=en.slice(0,-1); idx=st.vocabIdx.get(en); }
  let sugg=[];
  if(idx===undefined){ const cand=[]; for(const v of st.vocab){ const sc=v.startsWith(en)?0.5:v.includes(en)?1:lev(en,v); if(sc<=2) cand.push([sc,v.length,v]); }
    cand.sort((a,b)=>a[0]-b[0]||a[1]-b[1]); sugg=cand.slice(0,5).map(c=>c[2]); }
  return {label, sign, en, idx: idx===undefined?-1:idx, sugg};
}
function layerTerms(L){ return L.prompt.split(/[,;]/).map(s=>s.trim()).filter(Boolean).map(resolveTerm); }
/* todos os termos de todas as camadas ligadas, com índice global (k) */
function allTerms(){
  const out=[]; for(const L of st.layers){ if(!L.on) continue; for(const t of layerTerms(L)) out.push({...t, layer:L.id}); }
  return out;
}
