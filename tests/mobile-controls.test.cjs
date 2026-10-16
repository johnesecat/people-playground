'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { UnityInput, TouchController, ACTION_KEYS, keyInfo, angleDelta } = require('../TemplateData/mobile-controls.js');

class Event {
    constructor(type, properties = {}) { Object.assign(this, { type, bubbles: false, isTrusted: false }, properties); }
    preventDefault() { this.defaultPrevented = true; }
    stopImmediatePropagation() { this.stopped = true; }
}
class Target {
    constructor(parent) { this.parent = parent; this.listeners = new Map(); this.events = []; }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(callback);
    }
    removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== callback)); }
    dispatchEvent(event) {
        this.events.push(event);
        for (const callback of this.listeners.get(event.type) || []) { callback(event); if (event.stopped) break; }
        if (event.bubbles && !event.stopped && this.parent) this.parent.dispatchEvent(event);
        return !event.defaultPrevented;
    }
    getBoundingClientRect() { return { left: 12, top: 24, width: 800, height: 500 }; }
    focus() { this.focused = true; }
}
function fixture() {
    const env = new Target();
    env.document = new Target(env);
    env.MouseEvent = env.KeyboardEvent = env.WheelEvent = Event;
    let now = 0, id = 0;
    const timers = new Map();
    env.performance = { now: () => now };
    env.setTimeout = (callback, delay) => { timers.set(++id, { callback, at: now + delay }); return id; };
    env.clearTimeout = id => timers.delete(id);
    env.requestAnimationFrame = () => ++id;
    env.cancelAnimationFrame = () => {};
    const advance = milliseconds => {
        const end = now + milliseconds;
        while (true) {
            const first = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!first) break;
            now = first[1].at; timers.delete(first[0]); first[1].callback();
        }
        now = end;
    };
    const canvas = new Target(env.document);
    const modes = [];
    const controller = new TouchController(canvas, { env, onMode: mode => modes.push(mode) });
    const touch = (type, touches, changedTouches = touches, otherTouches = []) => {
        const event = new Event(type, { touches: [...touches, ...otherTouches], targetTouches: touches, changedTouches, bubbles: true });
        canvas.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        return event;
    };
    return { env, canvas, controller, input: controller.input, touch, advance, modes };
}
const finger = (identifier, clientX, clientY) => ({ identifier, clientX, clientY });
const events = (canvas, type) => canvas.events.filter(event => event.type === type);

test('one finger grabs/drags/releases with correct button masks and no native touch delivery', () => {
    const f = fixture(); let native = 0;
    f.canvas.addEventListener('touchstart', () => native++);
    f.touch('touchstart', [finger(1, 100, 120)]);
    f.touch('touchmove', [finger(1, 150, 180)]);
    f.touch('touchend', [], [finger(1, 150, 180)]);
    assert.equal(native, 0);
    assert.equal(events(f.canvas, 'mousedown')[0].buttons, 1);
    assert.equal(events(f.canvas, 'mouseup')[0].buttons, 0);
    assert.deepEqual(f.input.position, { x: 150, y: 180 });
    assert.equal(f.input.buttons.size, 0);
});

test('Activate taps emit F for a frame-safe duration without grabbing', () => {
    const f = fixture(); f.controller.setMode('activate');
    f.touch('touchstart', [finger(1, 200, 200)]);
    f.advance(30); f.touch('touchend', [], [finger(1, 200, 200)]);
    assert.equal(events(f.canvas, 'mousedown').length, 0);
    assert.equal(events(f.canvas, 'keydown')[0].keyCode, 70);
    assert.equal(f.input.keys.has('KeyF'), true);
    f.advance(79); assert.equal(f.input.keys.has('KeyF'), true);
    f.advance(1); assert.equal(f.input.keys.has('KeyF'), false);
    assert.equal(events(f.env.document, 'keydown').length, 1);
});

test('double-tap activates; distant taps and drags do not', () => {
    const f = fixture();
    for (const x of [100, 103]) {
        f.touch('touchstart', [finger(1, x, 200)]); f.advance(30);
        f.touch('touchend', [], [finger(1, x, 200)]); f.advance(100);
    }
    assert.equal(events(f.canvas, 'keydown').filter(event => event.code === 'KeyF').length, 1);
    f.touch('touchstart', [finger(1, 400, 200)]);
    f.touch('touchmove', [finger(1, 450, 200)]);
    f.touch('touchend', [], [finger(1, 450, 200)]);
    assert.equal(events(f.canvas, 'keydown').length, 1);
});

test('long press opens a context menu and releases right mouse after a frame-safe pulse', () => {
    const f = fixture(); f.touch('touchstart', [finger(1, 100, 200)]); f.advance(650);
    assert.equal(events(f.canvas, 'mousedown').at(-1).button, 2);
    assert.equal(f.input.buttons.has(0), false);
    f.advance(80); assert.equal(f.input.buttons.size, 0);
    f.touch('touchend', [], [finger(1, 100, 200)]);
    assert.equal(events(f.canvas, 'keydown').length, 0);
});

test('moving or adding a second finger cancels long press', () => {
    const f = fixture(); f.touch('touchstart', [finger(1, 100, 200)]);
    f.touch('touchmove', [finger(1, 120, 200)]); f.advance(700);
    assert.equal(events(f.canvas, 'mousedown').length, 1);
    f.touch('touchstart', [finger(1, 120, 200), finger(2, 200, 200)]); f.advance(700);
    assert.equal(events(f.canvas, 'mousedown').length, 1);
});

test('two-finger twist drives D/A and releases when the second finger lifts', () => {
    const f = fixture();
    f.touch('touchstart', [finger(1, 100, 200)]);
    f.touch('touchstart', [finger(1, 100, 200), finger(2, 200, 200)]);
    f.touch('touchmove', [finger(1, 100, 200), finger(2, 100, 300)]);
    f.controller.tick(16);
    assert.equal(f.input.keys.has('KeyD'), true);
    f.touch('touchend', [finger(1, 100, 200)], [finger(2, 100, 300)]);
    assert.equal(f.input.keys.has('KeyD'), false);
    assert.equal(f.input.buttons.has(0), true);
    f.touch('touchstart', [finger(1, 100, 200), finger(3, 200, 200)]);
    f.touch('touchmove', [finger(1, 100, 200), finger(3, 100, 100)]);
    f.controller.tick(16); assert.equal(f.input.keys.has('KeyA'), true);
    f.touch('touchend', [finger(3, 100, 100)], [finger(1, 100, 200)]);
    assert.equal(f.input.keys.size, 0); assert.equal(f.input.buttons.size, 0);
});

test('angle wrap uses shortest rotation across -180/180 degrees', () => {
    assert.ok(Math.abs(angleDelta(179 * Math.PI / 180, -179 * Math.PI / 180) * 180 / Math.PI - 2) < 0.001);
});

test('pinch zoom does not activate; camera pan uses middle mouse and centroid movement', () => {
    const f = fixture(); f.controller.setMode('camera');
    f.touch('touchstart', [finger(1, 100, 100)]);
    assert.equal(events(f.canvas, 'mousedown')[0].buttons, 4);
    f.touch('touchstart', [finger(1, 100, 100), finger(2, 200, 100)]);
    f.touch('touchmove', [finger(1, 110, 110), finger(2, 230, 110)]);
    assert.ok(events(f.canvas, 'wheel')[0].deltaY < 0);
    assert.deepEqual(f.input.position, { x: 120, y: 110 });
    f.touch('touchend', [], [finger(1, 110, 110), finger(2, 230, 110)]);
    assert.equal(events(f.canvas, 'keydown').length, 0);
    assert.equal(f.input.buttons.size, 0);
});

test('Grab two-finger gestures rotate without accidental camera zoom', () => {
    const f = fixture();
    f.touch('touchstart', [finger(1, 100, 100)]);
    f.touch('touchstart', [finger(1, 100, 100), finger(2, 200, 100)]);
    f.touch('touchmove', [finger(1, 100, 100), finger(2, 250, 200)]);
    f.controller.tick(16);
    assert.equal(events(f.canvas, 'wheel').length, 0);
    assert.equal(f.input.keys.has('KeyD'), true);
});

test('camera remains continuous when returning from two fingers to one', () => {
    const f = fixture(); f.controller.setMode('camera');
    f.touch('touchstart', [finger(1, 100, 100)]);
    f.touch('touchstart', [finger(1, 100, 100), finger(2, 200, 100)]);
    f.touch('touchmove', [finger(1, 110, 110), finger(2, 230, 110)]);
    assert.deepEqual(f.input.position, { x: 120, y: 110 });
    f.touch('touchend', [finger(1, 110, 110)], [finger(2, 230, 110)]);
    f.touch('touchmove', [finger(1, 115, 120)]);
    assert.deepEqual(f.input.position, { x: 125, y: 120 });
});

test('every toolbar action matches the recovered Unity default_controls asset', () => {
    const fixture = fs.readFileSync('tests/fixtures/default-controls.json');
    const defaults = JSON.parse(fixture);
    const evidence = JSON.parse(fs.readFileSync('tests/fixtures/build-evidence.json', 'utf8')).controls;
    const hash = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash(fixture), evidence.fixture_sha256);
    assert.equal(hash(Buffer.from(fixture.toString().replace(/\n/g, '\r\n'))), evidence.asset_sha256);
    const unitySpecial = { Space: 32, Tab: 9, Escape: 27, Backspace: 8, ShiftLeft: 304, ControlLeft: 306, AltLeft: 308 };
    for (const [action, code] of Object.entries(ACTION_KEYS)) {
        assert.ok(defaults[action], action);
        const unityKey = unitySpecial[code] || keyInfo(code)[0].charCodeAt(0);
        assert.equal(defaults[action].Key, unityKey, action);
    }
    const html = fs.readFileSync('index.html', 'utf8');
    for (const [, action] of html.matchAll(/data-(?:action|hold)="([^"]+)"/g)) assert.ok(ACTION_KEYS[action], action);
    for (const [, action] of html.matchAll(/value="(tool[1-9])"/g)) assert.ok(ACTION_KEYS[action], action);
    assert.equal(ACTION_KEYS.copy, 'KeyC');
    assert.equal(ACTION_KEYS.toolPowerToggle, 'ControlLeft');
    assert.equal(defaults.freezeSelection.Key, 0, 'freeze has no default hotkey; use object context menu');
});

test('Alt snapping is propagated to keyboard and mouse modifier fields and reset', () => {
    const f = fixture();
    f.input.key('AltLeft', true, 'latch');
    f.touch('touchstart', [finger(1, 100, 100)]);
    assert.equal(events(f.canvas, 'keydown')[0].altKey, true);
    assert.equal(events(f.canvas, 'mousedown')[0].altKey, true);
    f.controller.reset();
    assert.equal(events(f.canvas, 'keyup').at(-1).altKey, false);
});

test('toolbar finger is excluded from canvas gestures', () => {
    const f = fixture(); f.input.key('KeyF', true, 'toolbar');
    f.touch('touchstart', [finger(1, 100, 200)], undefined, [finger(9, 500, 500)]);
    f.touch('touchmove', [finger(1, 150, 250)], undefined, [finger(9, 600, 400)]);
    assert.equal(f.controller.pair, null);
    assert.equal(f.input.keys.has('KeyF'), true);
    assert.deepEqual(f.input.position, { x: 150, y: 250 });
});

test('Inspect mode right-clicks then returns to Grab for menu selection', () => {
    const f = fixture(); f.controller.setMode('context');
    f.touch('touchstart', [finger(1, 100, 200)]); f.advance(20);
    f.touch('touchend', [], [finger(1, 100, 200)]);
    assert.equal(events(f.canvas, 'mousedown')[0].button, 2);
    assert.equal(f.controller.mode, 'grab');
    assert.equal(f.modes.at(-1), 'grab');
});

test('gesture release cannot release a key still held by a toolbar button', () => {
    const f = fixture();
    f.input.key('KeyD', true, 'toolbar'); f.input.key('KeyD', true, 'gesture');
    f.input.key('KeyD', false, 'gesture');
    assert.equal(f.input.keys.has('KeyD'), true);
    assert.equal(events(f.canvas, 'keyup').length, 0);
    f.input.key('KeyD', false, 'toolbar');
    assert.equal(events(f.canvas, 'keyup').length, 1);
});

for (const interruption of ['blur', 'pagehide', 'resize', 'orientationchange', 'touchcancel', 'visibilitychange']) {
    test(interruption + ' releases all mouse, keyboard, timers and modifiers', () => {
        const f = fixture();
        f.input.key('ShiftLeft', true, 'latch'); f.input.pulse('KeyF');
        f.touch('touchstart', [finger(1, 100, 200)]);
        if (interruption === 'touchcancel') f.touch('touchcancel', []);
        else if (interruption === 'visibilitychange') { f.env.document.hidden = true; f.env.document.dispatchEvent(new Event(interruption)); }
        else f.env.dispatchEvent(new Event(interruption));
        f.advance(1000);
        assert.equal(f.input.keys.size, 0); assert.equal(f.input.buttons.size, 0);
        assert.equal(f.controller.primaryId, null);
        assert.equal(events(f.canvas, 'mousedown').filter(event => event.button === 2).length, 0);
    });
}

test('translated DOM events reach the actual generated Unity keyboard/mouse callbacks', () => {
    const f = fixture();
    const source = fs.readFileSync('Build/PPG.framework.js', 'utf8');
    function generatedFunction(name) {
        const start = source.indexOf('function ' + name + '(');
        assert.ok(start >= 0);
        return source.slice(start, source.indexOf('function ', start + 9));
    }
    const buffer = new ArrayBuffer(8192);
    let allocation = 0;
    const calls = [];
    const sandbox = {
        HEAP32: new Int32Array(buffer), HEAP16: new Int16Array(buffer), HEAPF64: new Float64Array(buffer),
        JSEvents: { registerOrRemoveHandler: handler => handler.target.addEventListener(handler.eventTypeString, handler.handlerFunc) },
        _malloc: size => { const address = allocation; allocation += size; return address; },
        findEventTarget: target => target, getBoundingClientRect: target => target.getBoundingClientRect(),
        stringToUTF8: (value, address, max) => { new Uint8Array(buffer, address, max).set(Buffer.from(value + '\0').subarray(0, max)); },
        dynCall_iiii: (callback, type, address) => { callback(type, address); return 1; }
    };
    vm.createContext(sandbox);
    vm.runInContext(generatedFunction('registerKeyEventCallback') + generatedFunction('fillMouseEventData') + generatedFunction('registerMouseEventCallback'), sandbox);
    const record = (type, address) => calls.push({ type, bytes: new Uint8Array(buffer).slice(address, address + 176) });
    sandbox.registerKeyEventCallback(f.env.document, 0, false, record, 2, 'keydown');
    sandbox.registerMouseEventCallback(f.canvas, 0, false, record, 5, 'mousedown');
    f.input.pulse('KeyF'); f.touch('touchstart', [finger(1, 212, 224)]);
    const key = new DataView(calls.find(call => call.type === 2).bytes.buffer);
    const mouse = new DataView(calls.find(call => call.type === 5).bytes.buffer);
    assert.equal(key.getInt32(36, true), 70); // e.keyCode
    assert.equal(mouse.getInt32(52, true), 200); // CSS x relative to canvas
    assert.equal(mouse.getInt32(56, true), 200);
    assert.equal(mouse.getInt16(42, true), 1); // e.buttons
});
