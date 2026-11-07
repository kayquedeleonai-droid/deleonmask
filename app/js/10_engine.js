/* ============ motor: downloads, sessões e modelos ============ */
let ortQ=Promise.resolve();   // uma inferência por vez (WebGPU/WASM do navegador não aceita duas juntas)
function runOrt(sess, feeds){ const p=ortQ.then(()=>sess.run(feeds)); ortQ=p.then(()=>{},()=>{}); return p; }
function chip(t, cls){ const c=$("#engineChip"); c.textContent=t; c.className="pill "+(cls||""); }
function note(t, cls){ const n=$("#cutterNote"); n.textContent=t; n.className="note "+(cls||""); }
const withTimeout=(p, ms, what)=>Promise.race([p, sleep(ms).then(()=>{ throw new Error(`${what}: passou de ${Math.round(ms/1000)} s`); })]);

const CACHE="deleon-mask-v5";
caches.keys().then(ks=>ks.filter(k=>k.startsWith("deleon-mask-")&&k!==CACHE).forEach(k=>caches.delete(k))).catch(()=>{});
async function fetchBytes(n, onProgress, fresh){
  if(!fresh){ try{ const c=await caches.open(CACHE); const hit=await c.match(n); if(hit){ const b=new Uint8Array(await hit.arrayBuffer()); onProgress(b.length); return b; } }catch(e){} }
  const r=await withTimeout(fetch(n, fresh?{cache:"reload"}:{}), 30000, `Conexão com ${n}`);
  if(!r.ok) throw new Error(`Não consegui baixar ${n} (erro ${r.status})`);
  const total=+r.headers.get("content-length")||0, rd=r.body.getReader(), chunks=[]; let got=0;
  for(;;){ const {done,value}=await withTimeout(rd.read(), 60000, `Download de ${n} parado`); if(done) break; chunks.push(value); got+=value.length; onProgress(value.length); }
  const out=new Uint8Array(got); let o=0; for(const c of chunks){ out.set(c,o); o+=c.length; }
  if(total && got!==total) throw new Error(`Download incompleto de ${n}`);
  caches.open(CACHE).then(c=>c.put(n,new Response(out.slice()))).catch(()=>{});
  return out;
}
async function fetchModel(name, label, report){
  const e=st.models[name]; if(!e) throw new Error(`Modelo ${name} não está no site.`);
  for(let attempt=0; attempt<2; attempt++){
    let got=0; const bufs=[];
    for(const n of e.parts) bufs.push(await fetchBytes(n, k=>{ got+=k; report && report(label, Math.min(1,got/e.size)); }, attempt>0));
    const len=bufs.reduce((a,b)=>a+b.length,0);
    if(len!==e.size){ console.warn(name,"tamanho errado",len,e.size); try{ const c=await caches.open(CACHE); for(const n of e.parts) await c.delete(n); }catch(_){} continue; }
    const out=new Uint8Array(len); let o=0; for(const b of bufs){ out.set(b,o); o+=b.length; } return out;
  }
  throw new Error(`O ${label} chegou corrompido duas vezes. Recarregue a página (Ctrl+Shift+R).`);
}
async function makeSession(bytes, what, eps){
  eps = eps || (("gpu" in navigator && navigator.gpu)? ["webgpu","wasm"] : ["wasm"]); let last;
  for(const ep of eps){ try{ const s=await withTimeout(ort.InferenceSession.create(bytes,{executionProviders:[ep], graphOptimizationLevel:"all"}), 90000, `Iniciar ${what} (${ep})`); return [s,ep]; }catch(e){ last=e; console.warn(what, ep, e); } }
  throw new Error(`Não consegui iniciar ${what}: `+(last&&last.message));
}
async function gpuHasF16(){ try{ const a=await navigator.gpu?.requestAdapter(); return !!a && a.features.has("shader-f16"); }catch(e){ return false; } }

async function loadManifest(){
  if(st.models) return;
  st.models = await (await fetch("models.json",{cache:"no-store"})).json();
  const vb = await fetchModel("vocab","vocabulário");
  st.vocab = JSON.parse(new TextDecoder().decode(vb)); st.vocabIdx = new Map(st.vocab.map((v,i)=>[v,i]));
}
const fg=(label,f)=>{ setBar(f); setStatus(`Baixando ${label}… ${Math.round(f*100)}%`); chip(`Baixando ${label} ${Math.round(f*100)}%`,"busy"); };

/* ---- etapa 1: detector + MobileSAM (o app fica pronto); etapa 2: SAM 2.1 em segundo plano ---- */
let engineLoading=null;
function loadEngine(){ return engineLoading ||= (async()=>{
  await loadManifest();
  ort.env.wasm.wasmPaths = new URL("vendor/", location.href).href;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency||4) : 1;
  st.gpu = !!(navigator.gpu && await navigator.gpu.requestAdapter().catch(()=>null));
  if(!st.detPicked) $("#detector").value = st.gpu ? "l" : "s";
  await loadDetector($("#detector").value, fg);
  st.engine = st.det[st.detKind].ep;
  await loadMobile();
  const picked = st.cutterPicked ? $("#cutter").value : null; if(picked) st.cutterWant=picked;
  if(picked && picked!=="mobile") upgradeSam(picked).catch(e=>console.warn(e));
  useCutter("mobile");
  setBar(0); setStatus("Motor pronto.");
  if(!picked) autoUpgrade().catch(e=>console.warn(e));
})().catch(e=>{ engineLoading=null; chip("Motor com erro"); throw e; }); }

async function loadDetector(kind, report){
  if(st.det[kind]){ st.detKind=kind; return; }
  const peName = kind==="l" ? "vocab_pe_l" : "vocab_pe", mName = kind==="l" ? "yoloe_l" : "yoloe_s";
  const pe = new Uint16Array((await fetchModel(peName,"vocabulário do detector",report)).buffer);
  const bytes = await fetchModel(mName, kind==="l"?"detector preciso":"detector rápido", report);
  chip("Iniciando o detector…","busy"); setStatus("Iniciando o detector…");
  const [sess,ep] = await makeSession(bytes, "o detector");
  st.det[kind] = {sess, ep, pe, tpe:new Map()}; st.detKind = kind;
}
async function loadMobile(){
  if(st.sess.mobile) return;
  const e=await fetchModel("sam_enc","recortador",fg), d=await fetchModel("sam_dec","recortador",fg);
  chip("Iniciando o recortador…","busy"); setStatus("Iniciando o recortador…");
  const [enc]=await makeSession(e,"o recortador"), [dec]=await makeSession(d,"o recortador");
  st.sess.mobile={enc,dec};
}
const SAM_SETS={ sam2:{enc16:"sam2_enc16",enc32:"sam2_enc32",dec:"sam2_dec",name:"SAM 2.1 tiny"},
                 sam2s:{enc16:"sam2s_enc16",enc32:"sam2s_enc32",dec:"sam2s_dec",name:"SAM 2.1 small"},
                 sam2b:{enc16:"sam2b_enc16",enc32:"sam2b_enc32",dec:"sam2b_dec",name:"SAM 2.1 base"} };
const cutterName = k => SAM_SETS[k]?.name || "MobileSAM";
function engineLabel(){ return `${st.engine==="webgpu"?"Placa de vídeo":"Processador"} · ${cutterName(st.cutter)} · YOLOE-${(st.detKind||"s").toUpperCase()}`; }
function useCutter(kind){ const S=st.sess[kind]; if(!S) return false; st.enc=S.enc; st.dec=S.dec; st.cutter=kind;
  const pending = st.cutterWant && st.cutterWant!==kind && samLoading[st.cutterWant]; if(!pending) $("#cutter").value=kind;
  chip(engineLabel(),"on"); note(`Ativo: ${cutterName(kind)}${S.ms?` · ${S.ms} ms por recorte`:""}`,"ok"); return true; }
async function autoUpgrade(){ if(st.engine!=="webgpu") return; for(const k of ["sam2b","sam2s","sam2"]){ if(st.cutterPicked) return; st.autoKind=k; if(await upgradeSam(k)) return; } }
const samLoading={};
function upgradeSam(kind){ return samLoading[kind] ||= (async()=>{
  const set=SAM_SETS[kind], nm=set.name;
  const bg=(label,f)=>{ chip(`${cutterName(st.cutter)} pronto · ${nm} ${Math.round(f*100)}%`,"busy"); note(`${nm}: baixando ${Math.round(f*100)}%. Enquanto isso usa o ${cutterName(st.cutter)}.`); };
  try{
    const gpu=st.engine==="webgpu", f16=gpu && await gpuHasF16(), encName=f16?set.enc16:set.enc32;
    const e=await fetchModel(encName,nm,bg), d=await fetchModel(set.dec,nm,bg);
    note(`${nm}: iniciando…`); chip(`Iniciando ${nm}…`,"busy");
    const eps=gpu?["webgpu"]:["wasm"]; const [enc]=await makeSession(e,nm,eps), [dec]=await makeSession(d,nm,eps);
    note(`${nm}: testando a velocidade…`);
    const t0=performance.now();
    await withTimeout(runOrt(enc,{image:new ort.Tensor("float32",new Float32Array(3*SAMS*SAMS),[1,3,SAMS,SAMS])}), gpu?90000:120000, `Teste do ${nm}`);
    const ms=Math.round(performance.now()-t0); st.sess[kind]={enc,dec,ms};
    while(st.running||busy) await sleep(500);
    if((!st.cutterPicked && st.autoKind===kind) || st.cutterWant===kind){ useCutter(kind); if(st.edit) await reopenEdit(); setStatus(`${nm} ativo.`); }
    else note(`${nm} pronto (${ms} ms). Escolha no menu para usar.`);
    return true;
  }catch(e){
    console.warn(nm,e); delete samLoading[kind];
    if(st.cutter!==kind){ $("#cutter").value=st.cutter||"mobile"; chip(engineLabel(),"on"); }
    note(`${nm} não rodou aqui: ${e.message}. Ativo: ${cutterName(st.cutter)}.`,"err");
    return false;
  }
})(); }
async function loadRvm(){
  if(st.rvm) return st.rvm;
  const b=await fetchModel("rvm","matting de pessoas",fg);
  const [sess,ep]=await makeSession(b,"o matting de pessoas"); st.rvm={sess,ep}; return st.rvm;
}
