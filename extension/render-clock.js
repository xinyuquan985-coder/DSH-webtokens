// MAIN-world scheduling shim. It has no extension APIs, credentials or reply access.
// Only an active bridge request sends pulses; ordinary browsing keeps native timing.
(() => {
  const request = window.requestAnimationFrame.bind(window);
  const cancel = window.cancelAnimationFrame.bind(window);
  const pending = new Map();
  const resizeObservers = new Set();
  const NativeResizeObserver = window.ResizeObserver;
  // DeepSeek's virtual list explicitly skips its initial synchronous measurement.
  // Native ResizeObserver delivery may wait for a visible rendering opportunity.
  // Supplement only that list's observer, using actual DOM dimensions, not a
  // guessed viewport or an invented visibility/intersection state.
  if (NativeResizeObserver) window.ResizeObserver = class extends NativeResizeObserver {
    constructor(callback) {
      super(callback);
      this.bridgeCallback = callback;
      this.bridgeTargets = new Map();
    }
    observe(target, options) {
      super.observe(target, options);
      if (!this.bridgeTargets.has(target)) this.bridgeTargets.set(target, null);
      resizeObservers.add(this);
    }
    unobserve(target) {
      super.unobserve(target);
      this.bridgeTargets.delete(target);
      if (!this.bridgeTargets.size) resizeObservers.delete(this);
    }
    disconnect() {
      super.disconnect(); this.bridgeTargets.clear(); resizeObservers.delete(this);
    }
    bridgePulse() {
      const entries = [];
      for (const [target, previous] of this.bridgeTargets) {
        if (!target.isConnected || !target.classList?.contains('ds-virtual-list')) continue;
        const style = window.getComputedStyle(target);
        if (style.display === 'none' || !target.getClientRects().length) continue;
        const number = value => Number.parseFloat(value) || 0;
        const left = number(style.paddingLeft), right = number(style.paddingRight);
        const top = number(style.paddingTop), bottom = number(style.paddingBottom);
        const width = Math.max(0, target.clientWidth - left - right);
        const height = Math.max(0, target.clientHeight - top - bottom);
        if (!width || !height) continue;
        const key = [width, height, target.offsetWidth, target.offsetHeight].join(':');
        if (key === previous) continue;
        this.bridgeTargets.set(target, key);
        const vertical = /^(vertical|sideways)/.test(style.writingMode);
        const size = (w, h) => ({ inlineSize: vertical ? h : w, blockSize: vertical ? w : h });
        entries.push({ target, contentRect: new DOMRectReadOnly(left, top, width, height),
          contentBoxSize: [size(width, height)],
          borderBoxSize: [size(target.offsetWidth, target.offsetHeight)],
          devicePixelContentBoxSize: [size(Math.round(width * window.devicePixelRatio), Math.round(height * window.devicePixelRatio))] });
      }
      if (entries.length) this.bridgeCallback.call(this, entries, this);
    }
  };
  let lastPulse = -Infinity;
  window.requestAnimationFrame = function (callback) {
    if (typeof callback !== 'function') return request(callback);
    const id = request(time => {
      if (!pending.delete(id)) return;
      callback.call(window, time);
    });
    pending.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    pending.delete(id);
    cancel(id);
  };
  document.addEventListener('dsh-bridge-render-pulse', () => {
    const now = performance.now();
    if (document.visibilityState !== 'hidden' || now - lastPulse < 250) return;
    lastPulse = now;
    for (const observer of [...resizeObservers]) {
      try { observer.bridgePulse(); } catch (error) { window.reportError(error); }
    }
    // Snapshot one frame only: callbacks scheduled by a callback wait for the next pulse.
    // Re-check cancellation so one callback may cancel a later callback in this frame.
    for (const [id, callback] of [...pending]) {
      if (!pending.delete(id)) continue;
      cancel(id);
      try { callback.call(window, now); }
      catch (error) { window.reportError(error); }
    }
  });
})();
