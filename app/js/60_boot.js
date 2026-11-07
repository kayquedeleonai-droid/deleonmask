/* ============ início ============ */
(async()=>{
  applyPreset("livre"); renderAll(); setTool("select"); setSteps("video");
  if(!("VideoDecoder" in window)){ setStatus("Este navegador não tem WebCodecs. Use Chrome, Edge ou Safari 17+."); $("#viewMsg").textContent="Navegador sem WebCodecs"; return; }
  loadManifest().then(()=>renderLayers()).catch(e=>console.warn(e));
  try{ const r=await fetch("exemplo.mp4"); const b=await r.blob(); await useFile(new File([b],"exemplo.mp4",{type:"video/mp4"})); $("#fileName").textContent="exemplo.mp4 (exemplo)"; }
  catch(e){ $("#viewMsg").textContent="Abra um vídeo para começar."; }
})();
