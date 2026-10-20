(() => {
  'use strict';
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const bursts = new Set();
  let layer = null;
  function remove(burst) {
    if (!bursts.delete(burst)) return;
    for (const animation of burst.animations) animation.cancel();
    burst.element.remove();
    if (!bursts.size && layer) { layer.remove(); layer = null; }
  }
  function clear() { for (const burst of [...bursts]) remove(burst); }
  document.addEventListener('click', event => {
    // Real pointer clicks only: keyboard and forwarded .click() activations
    // must not create a second burst or paint an invented cursor position.
    if (!event.isTrusted || event.detail === 0 || motion.matches || document.hidden || !Element.prototype.animate) return;
    if (document.querySelector('#view-takeoffs:not([hidden])') || event.target.closest?.("#takeoff-viewport,.takeoff-drawing-layout,.takeoff-viewer-controls,.takeoff-toolbar")) return;
    const x = event.clientX, y = event.clientY;
    // Let the action finish first, including opening/closing a native dialog.
    queueMicrotask(() => {
      if (motion.matches || document.hidden) return;
      if (document.querySelector('#view-takeoffs:not([hidden])')) { clear(); return; }
      if (layer && !layer.isConnected) clear();
      while (bursts.size >= 8) remove(bursts.values().next().value);
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'click-smoke-layer';
        layer.setAttribute('aria-hidden', 'true');
        layer.inert = true;
        const popover = typeof layer.showPopover === 'function';
        if (popover) layer.setAttribute('popover', 'manual');
        // Modern overlays belong to the document, so removing a temporary
        // dialog cannot detach an active burst before the next click.
        (popover ? document.body : document.querySelector('dialog[open]') || document.body).append(layer);
      }
      // Re-enter the top layer if this click just opened a newer modal.
      if (typeof layer.showPopover === 'function') {
        if (layer.matches(':popover-open')) layer.hidePopover();
        layer.showPopover();
      }
      const burst = { element: document.createElement('span'), animations: [] };
      layer.append(burst.element); bursts.add(burst);
      for (const [dx, dy] of [[0,-30],[0,30],[-30,0],[30,0]]) {
        const puff = document.createElement('span');
        puff.className = 'click-smoke-puff';
        burst.element.append(puff);
        const transform = (distance, scale) => `translate(${x - 6 + dx * distance}px,${y - 6 + dy * distance}px) scale(${scale})`;
        burst.animations.push(puff.animate([
          { transform: transform(0,.4), opacity: 0 },
          { transform: transform(.25,.8), opacity: .75, offset: .2 },
          { transform: transform(.65,1.3), opacity: .35, offset: .6 },
          { transform: transform(1,1.8), opacity: 0 }
        ], { duration: 560, easing: 'ease-out' }));
      }
      Promise.all(burst.animations.map(animation => animation.finished.catch(() => {}))).then(() => remove(burst));
    });
  }, { capture: true, passive: true });
  motion.addEventListener('change', clear);
  window.addEventListener('blur', clear);
  window.addEventListener('pagehide', clear);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
})();
