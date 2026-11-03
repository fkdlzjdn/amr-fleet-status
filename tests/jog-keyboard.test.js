'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const handlers = new Map(), windowHandlers = new Map(), sent = [];
  const target = { closest: () => null };
  const document = { hidden: false, activeElement: target,
    addEventListener(name, fn) { handlers.set(name, fn); },
    getElementById: () => ({ querySelector: () => ({ focus() {} }) }) };
  const context = vm.createContext({ document, state: { selected: 'R_006', drawerMode: 'jog' },
    window: { addEventListener(name, fn) { windowHandlers.set(name, fn); } },
    renderDetail() {}, $: document.getElementById, setTimeout: () => 1, clearTimeout() {}, Date, sent });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/jog.js'), 'utf8'), context);
  vm.runInContext("Object.assign(jogState,{token:'mock',session:{authorized:true},value:{status:'ready'},receivedAt:Date.now()}); jogRequest = async (action,body) => { sent.push({action,...body}); return {}; };", context);
  const event = (name, code, extra = {}) => {
    const e = { code, key: code?.replace('Key', '').toLowerCase(), target, preventDefault() { this.prevented = true; }, ...extra };
    handlers.get(name)?.(e); return e;
  };
  return { context, document, sent, event, windowHandlers, get held() { return vm.runInContext('jogState.held', context); } };
}

test('W A D X hold the correct direction and matching keyup requests gradual stop', () => {
  for (const [code, direction] of [['KeyW', 'forward'], ['KeyA', 'left'], ['KeyD', 'right'], ['KeyX', 'backward']]) {
    const f = fixture();
    f.event('keydown', code); assert.equal(f.held, direction); assert.equal(f.sent[0].direction, direction);
    f.event('keyup', code); assert.equal(f.held, null);
    assert.equal(f.sent.at(-1).direction, 'stop'); assert.equal(f.sent.at(-1).immediate, false);
  }
});
test('unrelated releases and key repeat cannot change the active direction or restart after S', () => {
  const f = fixture(); f.event('keydown', 'KeyW');
  f.event('keydown', 'KeyD'); f.event('keyup', 'KeyD'); f.event('keyup', 'Space');
  assert.equal(f.held, 'forward'); assert.equal(f.sent.length, 1);
  f.event('keydown', 'KeyS'); assert.equal(f.held, null); assert.equal(f.sent.at(-1).immediate, true);
  const count = f.sent.length;
  f.event('keydown', 'KeyW', { repeat: true }); f.event('keyup', 'KeyW');
  assert.equal(f.sent.length, count); assert.equal(f.held, null);
});
test('editing, modifiers, composition and other panels never send shortcut commands', () => {
  const f = fixture();
  for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true },
    { target: { closest: () => ({}) } }]) f.event('keydown', 'KeyW', extra);
  f.document.activeElement = { closest: () => ({}) }; f.event('keydown', 'KeyX');
  f.document.activeElement = { closest: () => null };
  vm.runInContext("state.drawerMode='detail'", f.context); f.event('keydown', 'KeyA');
  assert.equal(f.sent.length, 0);
});
test('blur and focus changes stop keyboard motion immediately; fresh press is required afterward', () => {
  const f = fixture(); f.event('keydown', 'KeyW'); f.windowHandlers.get('blur')();
  assert.equal(f.held, null); assert.equal(f.sent.at(-1).immediate, true);
  f.event('keydown', 'KeyA'); f.event('focusin');
  assert.equal(f.held, null); assert.equal(f.sent.at(-1).immediate, true);
  const count = f.sent.length; f.event('keydown', 'KeyA', { repeat: true });
  assert.equal(f.sent.length, count);
});
test('physical key codes work for other keyboard layouts, with case-insensitive letter fallback', () => {
  const f = fixture(); f.event('keydown', 'KeyW', { key: 'ㅈ' }); assert.equal(f.held, 'forward');
  f.event('keyup', 'KeyW', { key: 'ㅈ' });
  f.event('keydown', '', { key: 'X' }); assert.equal(f.held, 'backward');
  f.event('keyup', '', { key: 'X' }); assert.equal(f.held, null);
});
