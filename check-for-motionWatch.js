(() => {
  const v=[...document.querySelectorAll('video')][0]; if(!v) return console.warn('no video');
  const c=document.createElement('canvas'),x=c.getContext('2d'); c.width=c.height=1;
  try{ x.drawImage(v,0,0,1,1); x.getImageData(0,0,1,1); console.log('OK: pixels readable'); }
  catch(e){ console.error('BLOCKED: CORS/tainted', e); }
})();
