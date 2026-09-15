import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../extension/render-clock.js', import.meta.url), 'utf8');
function fixture() {
  let next = 0, time = 0;
  const native = new Map(), events = new Map(), errors = [];
  const document = { visibilityState: 'hidden', addEventListener: (name, fn) => events.set(name, fn) };
  const window = {
    ResizeObserver: class { constructor(callback) { this.nativeCallback = callback; } observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: target => target.style, devicePixelRatio: 2,
    requestAnimationFrame: fn => { const id = ++next; native.set(id, fn); return id; },
    cancelAnimationFrame: id => native.delete(id), reportError: e => errors.push(e)
  };
  class DOMRectReadOnly { constructor(x,y,width,height) { Object.assign(this, {x,y,width,height}); } }
  vm.runInNewContext(source, { window, document, DOMRectReadOnly, performance: { now: () => time } });
  return { window, document, native, errors, pulse: (at = time + 1000) => { time = at; events.get('dsh-bridge-render-pulse')(); } };
}
test('hidden webpage render updates without a native frame, window activation or duplicate callback', () => {
  const f = fixture(); let output = '';
  f.window.requestAnimationFrame(() => { output = 'reply rendered'; });
  const staleNative = [...f.native.values()][0];
  assert.equal(output, '');
  f.pulse(); assert.equal(output, 'reply rendered'); assert.equal(f.native.size, 0);
  output = 'finished'; staleNative(1010); assert.equal(output, 'finished');
});
test('background virtual list receives real initial size and renders before any native resize delivery', () => {
  const f = fixture(); let rendered = 0; const entries = [];
  const target = { isConnected: true, classList: { contains: name => name === 'ds-virtual-list' },
    clientWidth: 800, clientHeight: 600, offsetWidth: 804, offsetHeight: 604,
    style: { display: 'block', paddingTop: '10px', paddingBottom: '10px', paddingLeft: '20px', paddingRight: '20px' }, getClientRects: () => [1] };
  const observer = new f.window.ResizeObserver(batch => { entries.push(...batch); rendered = batch[0].target.offsetHeight; });
  observer.observe(target); assert.equal(rendered, 0);
  f.pulse(); assert.equal(rendered, 604); assert.equal(entries[0].contentRect.width, 760); assert.equal(entries[0].contentRect.height, 580);
  f.pulse(); assert.equal(entries.length, 1);
  target.clientHeight += 10; f.pulse(); assert.equal(entries.length, 2);
  observer.unobserve(target); target.clientHeight += 10; f.pulse(); assert.equal(entries.length, 2);
  observer.observe(target); observer.disconnect(); f.pulse(); assert.equal(entries.length, 2);
});
test('resize supplement excludes unrelated elements, collapsed lists, foreground and disconnected nodes', () => {
  const f = fixture(); let count = 0;
  const target = { isConnected: true, classList: { contains: () => false }, clientWidth: 800, clientHeight: 600,
    offsetWidth: 800, offsetHeight: 600, style: { display: 'block' }, getClientRects: () => [1] };
  const observer = new f.window.ResizeObserver(() => count++);
  observer.observe(target); f.pulse(); assert.equal(count, 0);
  target.classList.contains = () => true; target.clientHeight = 0; f.pulse(); assert.equal(count, 0);
  target.clientHeight = 600; target.isConnected = false; f.pulse(); assert.equal(count, 0);
  target.isConnected = true; f.document.visibilityState = 'visible'; f.pulse(); assert.equal(count, 0);
  f.document.visibilityState = 'hidden'; f.pulse(); assert.equal(count, 1);
});
test('visible tabs keep native timing; hidden frames do nothing without a request pulse', () => {
  const f = fixture(); let count = 0;
  f.window.requestAnimationFrame(() => count++);
  assert.equal(count, 0);
  f.document.visibilityState = 'visible'; f.pulse(); assert.equal(count, 0);
  [...f.native.values()][0](1010); assert.equal(count, 1);
  f.document.visibilityState = 'hidden'; f.pulse(); assert.equal(count, 1);
});
test('cancellation, reentrant animation loops, errors and pulse rate stay bounded', () => {
  const f = fixture(); const ran = [];
  let cancelled;
  f.window.requestAnimationFrame(() => {
    ran.push('first'); f.window.cancelAnimationFrame(cancelled);
    f.window.requestAnimationFrame(() => ran.push('next'));
  });
  cancelled = f.window.requestAnimationFrame(() => ran.push('cancelled'));
  f.window.requestAnimationFrame(() => { throw new Error('isolated callback error'); });
  f.window.requestAnimationFrame(() => ran.push('after error'));
  f.pulse(1000); assert.deepEqual(ran, ['first', 'after error']); assert.equal(f.errors.length, 1);
  f.pulse(1100); assert.equal(ran.length, 2);
  f.pulse(2000); assert.deepEqual(ran, ['first', 'after error', 'next']);
});
