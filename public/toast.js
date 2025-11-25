// Lightweight non-blocking toast used across pages
function showToast(message, opts){
  try{
    opts = opts || {};
    const wrap = document.createElement('div');
    wrap.className = 'cn-toast';
    wrap.textContent = message || '';
    wrap.style.position = 'fixed';
    wrap.style.left = '50%';
    wrap.style.transform = 'translateX(-50%)';
    wrap.style.top = opts.top || '18px';
    wrap.style.background = opts.background || 'rgba(0,0,0,0.8)';
    wrap.style.color = opts.color || '#fff';
    wrap.style.padding = '8px 12px';
    wrap.style.borderRadius = '6px';
    wrap.style.zIndex = 99999;
    wrap.style.fontSize = '14px';
    wrap.style.boxShadow = '0 6px 18px rgba(0,0,0,0.25)';
    document.body.appendChild(wrap);
    setTimeout(()=>{ try{ wrap.style.transition = 'opacity 300ms ease'; wrap.style.opacity = '0'; setTimeout(()=>{ try{ wrap.remove(); }catch(_){ } }, 320); }catch(_){ } }, opts.duration || 3500);
  }catch(_){ }
}
