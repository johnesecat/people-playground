'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
    const controller = new TouchController(canvas, { env });
    const touch = (type, touches, changedTouches = touches, otherTouches = []) => {
        const event = new Event(type, { touches: [...touches, ...otherTouches], targetTouches: touches, changedTouches, bubbles: true });
        canvas.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        return event;
    };
    return { env, canvas, controller, input: controller.input, touch, advance };
}
const finger = (identifier, clientX, clientY) => ({ identifier, clientX, clientY });
const events = (canvas, type) => canvas.events.filter(event => event.type === type);

test('one finger drags with left button masks and no native touch delivery', () => {
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

test('a quick one-finger tap is a click and sends no keys', () => {
    const f = fixture();
    f.touch('touchstart', [finger(1, 200, 200)]);
    f.advance(30); f.touch('touchend', [], [finger(1, 200, 200)]);
    assert.equal(events(f.canvas, 'mousedown')[0].button, 0);
    assert.equal(events(f.canvas, 'mouseup').length, 1);
    assert.equal(events(f.canvas, 'keydown').length, 0);
});

test('a still long press opens the object menu; moving cancels it', () => {
    const f = fixture(); f.touch('touchstart', [finger(1, 100, 200)]); f.advance(650);
    assert.equal(events(f.canvas, 'mousedown').at(-1).button, 2);
    assert.equal(f.input.buttons.has(0), false);
    f.advance(80); assert.equal(f.input.buttons.size, 0);
    f.touch('touchend', [], [finger(1, 100, 200)]);

    const g = fixture();
    g.touch('touchstart', [finger(1, 100, 200)]);
    g.touch('touchmove', [finger(1, 120, 200)]); g.advance(700);
    assert.equal(events(g.canvas, 'mousedown').length, 1);
});

test('two fingers down together zoom (pinch apart zooms in) and the first finger does not drag', () => {
    const f = fixture();
    f.touch('touchstart', [finger(1, 100, 100)]);
    f.touch('touchstart', [finger(1, 100, 100), finger(2, 300, 100)], [finger(2, 300, 100)]);
    f.touch('touchmove', [finger(1, 0, 100), finger(2, 400, 100)]);
    assert.ok(events(f.canvas, 'wheel')[0].deltaY < 0);
    assert.equal(events(f.canvas, 'mousedown').length, 1);
    assert.equal(f.input.buttons.size, 0);
});

test('two fingers down together zoom regardless of which lands first on the screen', () => {
    const f = fixture();
    f.touch('touchstart', [finger(1, 300, 100)]);
    f.touch('touchstart', [finger(1, 300, 100), finger(2, 100, 100)], [finger(2, 100, 100)]);
    assert.equal(f.controller.mode, 'zoom');
});

test('left finger holds still, right finger moves down to rotate right (D) and up to rotate left (A)', () => {
    const f = fixture();
    f.touch('touchstart', [finger(1, 100, 200)]);
    f.advance(300);
    f.touch('touchstart', [finger(1, 100, 200), finger(2, 300, 200)], [finger(2, 300, 200)]);
    assert.equal(f.controller.fingers.get(2).role, 'right');
    f.touch('touchmove', [finger(1, 100, 200), finger(2, 300, 260)]);
    f.controller.tick(16);
    assert.equal(f.input.keys.has('KeyD'), true);
    f.touch('touchmove', [finger(1, 100, 200), finger(2, 300, 100)]);
    f.controller.tick(16);
    assert.equal(f.input.keys.has('KeyA'), true);
    assert.equal(f.input.keys.has('KeyD'), false);
    f.touch('touchend', [finger(1, 100, 200)], [finger(2, 300, 100)]);
    assert.equal(f.input.keys.size, 0);
    assert.equal(f.input.buttons.has(0), true);
});

test('moving the left finger while the right one is still is a drag, so a second touch activates (no rotation)', () => {
    const f = fixture();
    f.touch('touchstart', [finger(1, 100, 200)]);
    f.touch('touchmove', [finger(1, 100, 260)]);
    f.advance(300);
    f.touch('touchstart', [finger(1, 100, 260), finger(2, 300, 260)], [finger(2, 300, 260)]);
    f.touch('touchmove', [finger(1, 100, 260), finger(2, 300, 260)]);
    f.controller.tick(16);
    assert.equal(f.input.keys.has('KeyD') || f.input.keys.has('KeyA'), false);
    assert.equal(f.input.keys.has('KeyF'), true);
});

test('second finger landing beside the first is identified by its position, even in the same half', () => {
    const f = fixture();
    f.touch('touchstart', [finger(1, 500, 200)]);
    f.advance(300);
    f.touch('touchstart', [finger(1, 500, 200), finger(2, 450, 200)], [finger(2, 450, 200)]);
    assert.equal(f.controller.fingers.get(1).role, 'right');
    assert.equal(f.controller.fingers.get(2).role, 'left');
});

test('dragging an object and touching with another finger holds F until that finger lifts', () => {
    const f = fixture();
    f.touch('touchstart', [finger(1, 100, 200)]);
    f.touch('touchmove', [finger(1, 150, 200)]);
    f.advance(300);
    f.touch('touchstart', [finger(1, 150, 200), finger(2, 300, 200)], [finger(2, 300, 200)]);
    assert.equal(f.input.keys.has('KeyF'), true);
    f.touch('touchend', [finger(1, 150, 200)], [finger(2, 300, 200)]);
    assert.equal(f.input.keys.has('KeyF'), false);
    assert.equal(f.input.buttons.has(0), true);
});

test('holding a still object and then a second finger still activates after a moment', () => {
    const f = fixture();
    f.touch('touchstart', [finger(1, 100, 200)]);
    f.advance(300);
    f.touch('touchstart', [finger(1, 100, 200), finger(2, 300, 200)], [finger(2, 300, 200)]);
    f.advance(200); f.controller.tick(16);
    assert.equal(f.input.keys.has('KeyF'), true);
    f.touch('touchend', [finger(1, 100, 200)], [finger(2, 300, 200)]);
    assert.equal(f.input.keys.has('KeyF'), false);
});

test('a quick second-finger tap on a still object sends one activate pulse', () => {
    const f = fixture();
    f.touch('touchstart', [finger(1, 100, 200)]);
    f.advance(300);
    f.touch('touchstart', [finger(1, 100, 200), finger(2, 300, 200)], [finger(2, 300, 200)]);
    f.advance(20);
    f.touch('touchend', [finger(1, 100, 200)], [finger(2, 300, 200)]);
    assert.equal(f.input.keys.has('KeyF'), true);
    f.advance(80);
    assert.equal(f.input.keys.has('KeyF'), false);
});

test('when the first finger lifts during a zoom, the remaining finger takes over the drag', () => {
    const f = fixture();
    f.touch('touchstart', [finger(1, 100, 200)]);
    f.touch('touchstart', [finger(1, 100, 200), finger(2, 300, 200)], [finger(2, 300, 200)]);
    f.touch('touchend', [finger(2, 300, 200)], [finger(1, 100, 200)]);
    assert.equal(f.controller.primaryId, 2);
    assert.equal(events(f.canvas, 'mousedown').at(-1).clientX, 300);
    assert.equal(f.input.buttons.has(0), true);
});

test('a third finger is ignored by gestures', () => {
    const f = fixture();
    f.touch('touchstart', [finger(1, 100, 200)]);
    f.touch('touchstart', [finger(1, 100, 200), finger(2, 300, 200)], [finger(2, 300, 200)]);
    f.touch('touchstart', [finger(1, 100, 200), finger(2, 300, 200), finger(3, 500, 200)], [finger(3, 500, 200)]);
    assert.equal(f.controller.fingers.size, 2);
});

test('angle wrap uses shortest rotation across -180/180 degrees', () => {
    assert.ok(Math.abs(angleDelta(179 * Math.PI / 180, -179 * Math.PI / 180) * 180 / Math.PI - 2) < 0.001);
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
    assert.equal(f.controller.fingers.size, 1);
    assert.equal(f.input.keys.has('KeyF'), true);
    assert.deepEqual(f.input.position, { x: 150, y: 250 });
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

