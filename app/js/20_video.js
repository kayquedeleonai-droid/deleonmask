/* ============ vídeo: demux + decode exatos ============ */
async function openVideo(file){
  const buf=await file.arrayBuffer(); const mp4=MP4Box.createFile();
  const info=await new Promise((res,rej)=>{ mp4.onError=()=>rej(new Error("Esse arquivo não abriu como MP4/MOV.")); mp4.onReady=res; const b=buf.slice(0); b.fileStart=0; mp4.appendBuffer(b); mp4.flush(); });
  const tr=info.videoTracks[0]; if(!tr) throw new Error("O arquivo não tem trilha de vídeo.");
  const samples=await new Promise(res=>{ const all=[]; mp4.onSamples=(id,u,ss)=>{ all.push(...ss); if(all.length>=tr.nb_samples) res(all); }; mp4.setExtractionOptions(tr.id,null,{nbSamples:1e9}); mp4.start(); setTimeout(()=>res(all),4000); });
  const trak=mp4.getTrackById(tr.id); let description;
  for(const e of trak.mdia.minf.stbl.stsd.entries){ const bx=e.avcC||e.hvcC||e.vpcC||e.av1C; if(bx){ const s=new DataStream(undefined,0,DataStream.BIG_ENDIAN); bx.write(s); description=new Uint8Array(s.buffer,8); break; } }
  const cfg={codec:tr.codec.startsWith("vp08")?"vp8":tr.codec, codedWidth:tr.video.width, codedHeight:tr.video.height, description};
  const sup=await VideoDecoder.isConfigSupported(cfg).catch(()=>({supported:false}));
  if(!sup.supported) throw new Error(`Este navegador não decodifica ${tr.codec}. Use Chrome ou Edge, ou exporte em H.264.`);
  const m=tr.matrix||[65536,0,0,0,65536,0,0,0,1073741824];
  let rot=Math.round(Math.atan2(m[1],m[0])*180/Math.PI); rot=((rot%360)+360)%360;
  const cw=tr.video.width, ch=tr.video.height, W=(rot===90||rot===270)?ch:cw, H=(rot===90||rot===270)?cw:ch;
  const ts=samples.map(s=>Math.round(1e6*s.cts/s.timescale)).sort((a,b)=>a-b);
  const dur=(ts[ts.length-1]-ts[0])/1e6 + samples[samples.length-1].duration/samples[0].timescale;
  return {name:file.name, file, samples, cfg, W, H, rot, nFrames:samples.length, fps:samples.length/dur, dur, codec:tr.codec, ts, tsIdx:new Map(ts.map((t,i)=>[t,i]))};
}
async function* decodeAll(v){
  const q=[]; let wake=null, err=null, flushed=false, done=false;
  const ping=()=>{ if(wake){ const w=wake; wake=null; w(); } };
  const dec=new VideoDecoder({output:f=>{ q.push(f); ping(); }, error:e=>{ err=e; ping(); }});
  dec.configure(v.cfg); let si=0, out=0;
  const chunk=s=>new EncodedVideoChunk({type:s.is_sync?"key":"delta", timestamp:Math.round(1e6*s.cts/s.timescale), duration:Math.round(1e6*s.duration/s.timescale), data:s.data});
  try{
    while(out<v.nFrames){
      if(err) throw err;
      while(si<v.nFrames && q.length+dec.decodeQueueSize<8) dec.decode(chunk(v.samples[si++]));
      if(si===v.nFrames && !flushed){ flushed=true; dec.flush().then(()=>{ done=true; ping(); }, e=>{ err=e; ping(); }); }
      if(!q.length){ if(done) break; await new Promise(r=>{ wake=r; setTimeout(ping,200); }); continue; }
      out++; yield q.shift();
    }
  } finally { for(const f of q) f.close(); try{ dec.close(); }catch(e){} }
}
function drawFrame(src, ctx, W, H, rot){
  ctx.save(); ctx.setTransform(1,0,0,1,0,0);
  if(rot===90){ ctx.translate(W,0); ctx.rotate(Math.PI/2); } else if(rot===180){ ctx.translate(W,H); ctx.rotate(Math.PI); } else if(rot===270){ ctx.translate(0,H); ctx.rotate(-Math.PI/2); }
  ctx.drawImage(src,0,0); ctx.restore();
}
function frameIdx(v, ts){ const i=v.tsIdx.get(ts); if(i!==undefined) return i; let b=0,bd=Infinity; v.ts.forEach((t,k)=>{ const d=Math.abs(t-ts); if(d<bd){ bd=d; b=k; } }); return b; }
function makeCanvases(W,H){ const fc=new OffscreenCanvas(W,H); return {fc, fx:fc.getContext("2d",{willReadFrequently:true})}; }
async function grabFrame(fi){
  const v=st.video, cv=makeCanvases(v.W,v.H);
  if(st.run && st.run.frames && st.run.frames[fi]){ const bm=await createImageBitmap(st.run.frames[fi]); cv.fx.drawImage(bm,0,0); bm.close(); return cv; }
  for await (const f of decodeAll(v)){ const i=frameIdx(v,f.timestamp); if(i===fi){ drawFrame(f,cv.fx,v.W,v.H,v.rot); f.close(); return cv; } f.close(); if(i>fi) break; }
  throw new Error("Não consegui ler esse frame.");
}
