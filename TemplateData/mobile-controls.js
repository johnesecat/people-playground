/* Browser-side input only: Unity's generated framework is deliberately untouched. */
(function (root) {
    'use strict';

    const KEY_INFO = {
        Space: [' ', 32], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8],
        ShiftLeft: ['Shift', 16], ControlLeft: ['Control', 17], AltLeft: ['Alt', 18],
        ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40]
    };
    // Verified against the shipped default_controls TextAsset, not a generic
    // controls chart. See tests/fixtures/default-controls.json and build-evidence.json.
    const ACTION_KEYS = Object.freeze({
        time: 'Space', toybox: 'Tab', spawnLeft: 'KeyQ', spawnRight: 'KeyE',
        activateDirect: 'KeyF', left: 'KeyA', right: 'KeyD', delete: 'Backspace',
        slowmo: 'KeyG', undo: 'KeyZ', pause: 'Escape', toolPowerToggle: 'ControlLeft',
        fast: 'ShiftLeft', snap: 'AltLeft', copy: 'KeyC', paste: 'KeyV',
        snapToCenter: 'KeyM', toggleLimbStatus: 'KeyS', toggleThermalVision: 'KeyT',
        ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => ['tool' + (index + 1), 'Digit' + (index + 1)]))
    });
    function keyInfo(code) {
        if (KEY_INFO[code]) return KEY_INFO[code];
        if (/^Key[A-Z]$/.test(code)) return [code.slice(3).toLowerCase(), code.charCodeAt(3)];
        if (/^Digit[0-9]$/.test(code)) return [code.slice(5), code.charCodeAt(5)];
        throw new Error('Unsupported input code: ' + code);
    }
    function angleDelta(previous, next) {
        return Math.atan2(Math.sin(next - previous), Math.cos(next - previous));
    }
    // Takes tracked finger records ({ x, y }), the same shape the controller stores.
    function pairGeometry(a, b) {
        return {
            x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
            distance: Math.hypot(b.x - a.x, b.y - a.y),
            angle: Math.atan2(b.y - a.y, b.x - a.x)
        };
    }

    class UnityInput {
        constructor(canvas, env = root) {
            this.canvas = canvas;
            this.env = env;
            this.keys = new Map();
            this.pulses = new Map();
            this.buttons = new Set();
            this.position = { x: 0, y: 0 };
            this.center();
        }
        center() {
            const rect = this.canvas.getBoundingClientRect();
            this.position = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
        focus() { this.canvas.focus({ preventScroll: true }); }
        modifiers() {
            return { shiftKey: this.keys.has('ShiftLeft'), ctrlKey: this.keys.has('ControlLeft'), altKey: this.keys.has('AltLeft'), metaKey: false };
        }
        key(code, down, owner = 'default') {
            const owners = this.keys.get(code) || new Set();
            const before = owners.size > 0;
            if (down) owners.add(owner);
            else owners.delete(owner);
            if (owners.size) this.keys.set(code, owners);
            else this.keys.delete(code);
            if (before === (owners.size > 0)) return;
            const [key, number] = keyInfo(code);
            const event = new this.env.KeyboardEvent(down ? 'keydown' : 'keyup', {
                key, code, keyCode: number, which: number, charCode: 0,
                bubbles: true, cancelable: true, ...this.modifiers()
            });
            // WebKit versions differ on legacy constructor fields; Unity reads these.
            for (const field of ['keyCode', 'which']) {
                if (event[field] !== number) Object.defineProperty(event, field, { get: () => number });
            }
            this.canvas.dispatchEvent(event);
        }
        pulse(code) {
            this.focus();
            const old = this.pulses.get(code);
            if (old) this.env.clearTimeout(old);
            this.key(code, true, 'pulse');
            this.pulses.set(code, this.env.setTimeout(() => {
                this.key(code, false, 'pulse');
                this.pulses.delete(code);
            }, 80)); // Survive at least one Unity frame, even at low mobile frame rates.
        }
        mouse(type, x = this.position.x, y = this.position.y, button = 0) {
            const previous = this.position;
            this.position = { x, y };
            if (type === 'mousedown') this.buttons.add(button);
            if (type === 'mouseup') this.buttons.delete(button);
            const buttons = [...this.buttons].reduce((mask, value) => mask | [1, 4, 2][value], 0);
            this.canvas.dispatchEvent(new this.env.MouseEvent(type, {
                bubbles: true, cancelable: true, view: this.env, clientX: x, clientY: y,
                screenX: x, screenY: y, button, buttons,
                movementX: x - previous.x, movementY: y - previous.y, ...this.modifiers()
            }));
        }
        releaseMouse() { for (const button of [...this.buttons]) this.mouse('mouseup', undefined, undefined, button); }
        wheel(delta, x = this.position.x, y = this.position.y) {
            this.mouse('mousemove', x, y);
            this.canvas.dispatchEvent(new this.env.WheelEvent('wheel', {
                bubbles: true, cancelable: true, clientX: x, clientY: y,
                deltaY: delta, deltaMode: 0, ...this.modifiers()
            }));
        }
        reset() {
            this.releaseMouse();
            for (const timer of this.pulses.values()) this.env.clearTimeout(timer);
            this.pulses.clear();
            for (const [code, owners] of [...this.keys]) {
                for (const owner of [...owners]) this.key(code, false, owner);
            }
        }
    }

    /*
     * Gesture model (finger roles are assigned on touchstart, from the live canvas size):
     *  - One finger: drag = left-button drag (the game decides what the finger grabs). A
     *    stationary tap is a click; a stationary long press opens the right-click menu.
     *  - Two fingers down together (within 150 ms): pinch = mouse wheel zoom.
     *  - Left finger held still, then right finger moves up/down: rotate (up = A, down = D).
     *  - Left finger dragging an object, then another finger touches: hold F (activate / fire)
     *    until that finger lifts.
     * The second finger's role is 'left' if it lands left of the first finger, else 'right',
     * so identity is correct even when both fingers are in the same half of the screen.
     */
    class TouchController {
        constructor(canvas, options = {}) {
            this.canvas = canvas;
            this.env = options.env || root;
            this.input = options.input || new UnityInput(canvas, this.env);
            this.status = options.status || (() => {});
            this.cursor = options.cursor || (() => {});
            this.enabled = true;
            this.rotationSpeed = 180;
            this.fingers = new Map();
            this.primaryId = null;
            this.mode = 'idle';
            this.zoomDistance = 0;
            this.pendingSince = 0;
            this.rotationMs = 0;
            this.rotationKey = null;
            this.fireHeld = false;
            this.longTimer = null;
            this.contextTimer = null;
            this.placeTimer = null;
            this.lastTouch = { ...this.input.position };
            this.lastTouchTime = -Infinity;
            this.listeners = [];
            for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
                this.listen(canvas, type, event => this.handleTouch(event), { capture: true, passive: false });
            }
            // Unity also registers native touch listeners. Stop those and compatibility
            // mouse events so a single finger never produces two independent inputs.
            for (const type of ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick']) {
                this.listen(canvas, type, event => {
                    if (this.enabled && event.isTrusted && this.env.performance.now() - this.lastTouchTime < 800) this.consume(event);
                }, true);
            }
            this.listen(canvas, 'contextmenu', event => event.preventDefault());
            for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
                this.listen(canvas, type, event => { if (this.enabled) this.consume(event); }, { passive: false });
            }
            this.listen(this.env, 'blur', () => this.reset());
            this.listen(this.env, 'pagehide', () => this.reset());
            this.listen(this.env, 'resize', () => this.reset());
            this.listen(this.env, 'orientationchange', () => this.reset());
            this.listen(this.env.document, 'visibilitychange', () => { if (this.env.document.hidden) this.reset(); });
            this.lastFrame = null;
            const frame = time => {
                if (this.lastFrame !== null) this.tick(Math.min(time - this.lastFrame, 100));
                this.lastFrame = time;
                this.frameId = this.env.requestAnimationFrame(frame);
            };
            this.frameId = this.env.requestAnimationFrame(frame);
        }
        listen(target, type, handler, options) {
            target.addEventListener(type, handler, options);
            this.listeners.push(() => target.removeEventListener(type, handler, options));
        }
        consume(event) { event.preventDefault(); event.stopImmediatePropagation(); }
        clearLongPress() {
            if (this.longTimer !== null) this.env.clearTimeout(this.longTimer);
            this.longTimer = null;
        }
        // The canvas split is measured from the live canvas, so it follows the screen size.
        midpoint() {
            const rect = this.canvas.getBoundingClientRect();
            return rect.left + rect.width / 2;
        }
        addFinger(touch, now) {
            const others = [...this.fingers.values()];
            // Only two fingers take part in gestures; a third is ignored until one lifts.
            if (others.length >= 2) return;
            const role = others.length === 0
                ? (touch.clientX < this.midpoint() ? 'left' : 'right')
                : (touch.clientX < others[0].x ? 'left' : 'right');
            const finger = {
                id: touch.identifier, role, x: touch.clientX, y: touch.clientY, dy: 0,
                startX: touch.clientX, startY: touch.clientY, time: now, moved: false
            };
            this.fingers.set(finger.id, finger);
            this.lastTouch = { x: finger.x, y: finger.y };
            this.cursor(finger.x, finger.y, true);
            if (others.length === 0) {
                this.primaryId = finger.id;
                this.mode = 'drag';
                this.input.focus();
                this.input.mouse('mousemove', finger.x, finger.y);
                this.input.mouse('mousedown', finger.x, finger.y, 0);
                this.clearLongPress();
                this.longTimer = this.env.setTimeout(() => {
                    this.longTimer = null;
                    if (this.mode !== 'drag' || this.fingers.size !== 1 || finger.moved) return;
                    this.input.releaseMouse();
                    this.contextClick(finger.x, finger.y);
                }, 650);
                this.status('Drag to move · pinch to zoom · twist to rotate');
            } else if (others.length === 1) {
                this.clearLongPress();
                const other = others[0];
                if (now - other.time < 150) this.startZoom();
                else if (this.mode === 'drag' && other.moved) this.startFire();
                else if (this.mode === 'drag') this.startPending(now);
            }
        }
        startZoom() {
            this.mode = 'zoom';
            this.input.releaseMouse();
            const [a, b] = [...this.fingers.values()];
            this.zoomDistance = pairGeometry(a, b).distance;
            this.status('Pinch to zoom');
        }
        startFire() {
            this.mode = 'fire';
            this.fireHeld = true;
            this.input.key('KeyF', true, 'gesture-fire');
            this.status('Activating while you hold the object');
        }
        // Second finger down on a still object: moving it rotates, holding it still activates.
        startPending(now) {
            this.mode = 'pending';
            this.pendingSince = now;
            this.status('Move the right finger up or down to rotate, or hold it still to activate');
        }
        startRotate() {
            this.mode = 'rotate';
            this.status('Move the right finger up or down to rotate');
        }
        // The rotating finger is the one further right, so the left finger stays the anchor.
        rotator() {
            return [...this.fingers.values()].reduce((best, finger) => (!best || finger.x > best.x ? finger : best), null);
        }
        updateFinger(finger, touch) {
            finger.dy = touch.clientY - finger.y;
            finger.x = touch.clientX;
            finger.y = touch.clientY;
            if (!finger.moved && Math.hypot(finger.x - finger.startX, finger.y - finger.startY) > 10) {
                finger.moved = true;
                this.clearLongPress();
            }
            if (finger.id === this.primaryId) {
                this.lastTouch = { x: finger.x, y: finger.y };
                this.cursor(finger.x, finger.y, true);
            }
        }
        applyMove() {
            const primary = this.fingers.get(this.primaryId);
            const secondary = [...this.fingers.values()].find(finger => finger.id !== this.primaryId);
            if (this.mode === 'pending') {
                if (secondary && secondary.moved) this.startRotate();
                else if (primary && primary.moved) this.startFire();
            }
            if (this.mode !== 'zoom' && primary) {
                this.input.mouse('mousemove', primary.x, primary.y);
            }
            const list = [...this.fingers.values()];
            if (this.mode === 'zoom' && list.length === 2) {
                const geometry = pairGeometry(list[0], list[1]);
                if (this.zoomDistance > 10 && geometry.distance > 10) {
                    const delta = Math.max(-300, Math.min(300, -Math.log(geometry.distance / this.zoomDistance) * 600));
                    if (Math.abs(delta) > 0.2) this.input.wheel(delta, geometry.x, geometry.y);
                }
                this.zoomDistance = geometry.distance;
            }
            if (this.mode === 'rotate') {
                const rotator = this.rotator();
                if (rotator && rotator.dy) {
                    // Vertical movement is converted at 1 px = 1 degree, then the rotation speed sets the pace.
                    this.rotationMs = Math.max(-1000, Math.min(1000, this.rotationMs + rotator.dy / this.rotationSpeed * 1000));
                }
            }
            for (const finger of list) finger.dy = 0;
        }
        handleTouch(event) {
            if (!this.enabled) return;
            this.consume(event);
            const now = this.env.performance.now();
            this.lastTouchTime = now;
            if (event.type === 'touchcancel') { this.reset(); return; }
            // targetTouches excludes fingers holding toolbar buttons (Use / rotate).
            const live = new Map(Array.from(event.targetTouches).map(touch => [touch.identifier, touch]));
            const changed = new Map(Array.from(event.changedTouches).map(touch => [touch.identifier, touch]));
            if (event.type === 'touchstart') {
                for (const touch of event.changedTouches) {
                    if (live.has(touch.identifier) && !this.fingers.has(touch.identifier)) this.addFinger(touch, now);
                }
            }
            for (const finger of this.fingers.values()) {
                const touch = live.get(finger.id);
                if (touch) this.updateFinger(finger, touch);
            }
            if (event.type === 'touchmove') this.applyMove();
            for (const id of [...this.fingers.keys()]) {
                if (live.has(id)) continue;
                const touch = changed.get(id);
                if (touch) this.updateFinger(this.fingers.get(id), touch);
                this.removeFinger(id);
            }
        }
        removeFinger(id) {
            const wasPrimary = id === this.primaryId;
            // A quick second-finger tap (no movement, no hold) sends one activate pulse.
            const tapped = this.mode === 'pending' && !wasPrimary;
            this.fingers.delete(id);
            this.stopRotation();
            this.stopFire();
            if (tapped) this.input.pulse('KeyF');
            this.zoomDistance = 0;
            if (this.fingers.size === 0) {
                this.clearLongPress();
                this.input.releaseMouse();
                this.mode = 'idle';
                this.primaryId = null;
                this.cursor(0, 0, false);
                this.status('Drag · pinch to zoom · tap ? for controls');
                return;
            }
            // Only one finger is left. If it is still holding the object, keep the drag going;
            // otherwise it takes over the drag from its current position.
            if (!wasPrimary && this.input.buttons.has(0)) {
                this.mode = 'drag';
                return;
            }
            const next = [...this.fingers.values()][0];
            this.input.releaseMouse();
            this.clearLongPress();
            this.primaryId = next.id;
            this.mode = 'drag';
            next.moved = true; // A takeover must not also start a long-press menu.
            this.input.mouse('mousemove', next.x, next.y);
            this.input.mouse('mousedown', next.x, next.y, 0);
        }
        contextClick(x, y) {
            this.input.mouse('mousemove', x, y);
            this.input.mouse('mousedown', x, y, 2);
            if (this.contextTimer !== null) this.env.clearTimeout(this.contextTimer);
            this.contextTimer = this.env.setTimeout(() => {
                this.contextTimer = null;
                this.input.mouse('mouseup', undefined, undefined, 2);
            }, 80);
            this.status('Object menu open · tap an entry');
        }
        // Place: click the last touched spot, which places a held object there.
        place() {
            const { x, y } = this.lastTouch;
            this.input.focus();
            this.input.mouse('mousemove', x, y);
            this.input.mouse('mousedown', x, y, 0);
            if (this.placeTimer !== null) this.env.clearTimeout(this.placeTimer);
            this.placeTimer = this.env.setTimeout(() => {
                this.placeTimer = null;
                this.input.mouse('mouseup', undefined, undefined, 0);
            }, 80);
        }
        stopRotation() {
            this.rotationMs = 0;
            if (this.rotationKey) this.input.key(this.rotationKey, false, 'gesture');
            this.rotationKey = null;
        }
        stopFire() {
            if (this.fireHeld) this.input.key('KeyF', false, 'gesture-fire');
            this.fireHeld = false;
        }
        tick(milliseconds) {
            if (this.mode === 'pending' && this.env.performance.now() - this.pendingSince >= 200) this.startFire();
            let next = null;
            if (this.mode === 'rotate' && Math.abs(this.rotationMs) > 2) {
                next = this.rotationMs > 0 ? ACTION_KEYS.right : ACTION_KEYS.left;
                const step = Math.min(Math.abs(this.rotationMs), milliseconds);
                this.rotationMs -= Math.sign(this.rotationMs) * step;
            }
            if (next !== this.rotationKey) {
                if (this.rotationKey) this.input.key(this.rotationKey, false, 'gesture');
                if (next) this.input.key(next, true, 'gesture');
                this.rotationKey = next;
            }
        }
        reset() {
            this.clearLongPress();
            if (this.contextTimer !== null) this.env.clearTimeout(this.contextTimer);
            if (this.placeTimer !== null) this.env.clearTimeout(this.placeTimer);
            this.contextTimer = null;
            this.placeTimer = null;
            this.stopRotation();
            this.stopFire();
            this.input.reset();
            this.fingers.clear();
            this.primaryId = null;
            this.mode = 'idle';
            this.zoomDistance = 0;
            this.cursor(0, 0, false);
            if (this.onReset) this.onReset();
        }
        destroy() {
            this.reset();
            this.env.cancelAnimationFrame(this.frameId);
            for (const remove of this.listeners) remove();
        }
    }

    function mount(canvas) {
        const document = root.document;
        const controls = document.querySelector('#mobile-controls');
        const cursor = document.querySelector('#touch-cursor');
        const status = document.querySelector('#gesture-status');
        const help = document.querySelector('#help-panel');
        const controller = new TouchController(canvas, {
            status: text => { status.textContent = text; },
            cursor: (x, y, visible) => {
                const rect = canvas.getBoundingClientRect();
                cursor.hidden = !visible;
                cursor.style.left = (x - rect.left) + 'px'; cursor.style.top = (y - rect.top) + 'px';
            }
        });
        const enabled = document.querySelector('#touch-enabled');
        enabled.checked = navigator.maxTouchPoints > 0 || root.matchMedia('(pointer: coarse)').matches;
        function setEnabled() {
            controller.reset();
            controller.enabled = enabled.checked;
            controls.hidden = !enabled.checked;
            desktopToggle.hidden = enabled.checked;
            status.textContent = enabled.checked ? 'Drag · pinch to zoom · tap ? for controls' : '';
        }
        // A mouse user can opt into controls too; no user-agent sniffing needed.
        const desktopToggle = document.createElement('button');
        desktopToggle.id = 'desktop-touch-toggle';
        desktopToggle.textContent = 'Touch controls';
        desktopToggle.type = 'button';
        document.querySelector('#unity-container').append(desktopToggle);
        desktopToggle.addEventListener('click', () => { enabled.checked = true; setEnabled(); });
        enabled.addEventListener('change', setEnabled);
        setEnabled();
        controls.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => controller.input.pulse(ACTION_KEYS[button.dataset.action])));
        // One facing toggle decides which spawn key the Spawn button sends (Q = left, E = right).
        let facing = 'left';
        const facingButtons = controls.querySelectorAll('[data-facing]');
        const facingLabel = document.querySelector('#facing-label');
        const setFacing = next => {
            facing = next;
            facingButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.facing === next)));
            facingLabel.textContent = 'Facing ' + (next === 'left' ? '←' : '→');
        };
        facingButtons.forEach(button => button.addEventListener('click', () => setFacing(button.dataset.facing)));
        setFacing(facing);
        controls.querySelector('[data-spawn]').addEventListener('click', () => controller.input.pulse(ACTION_KEYS[facing === 'left' ? 'spawnLeft' : 'spawnRight']));
        controls.querySelector('[data-place]').addEventListener('click', () => controller.place());
        const held = new Map();
        controls.querySelectorAll('[data-hold]').forEach(button => {
            if (button.dataset.latch) {
                button.addEventListener('click', () => {
                    const down = button.getAttribute('aria-pressed') !== 'true';
                    controller.input.focus();
                    controller.input.key(ACTION_KEYS[button.dataset.hold], down, 'latch');
                    button.setAttribute('aria-pressed', String(down));
                });
                return;
            }
            const release = event => {
                const owner = held.get(event.pointerId);
                if (!owner || owner.button !== button) return;
                controller.input.key(ACTION_KEYS[button.dataset.hold], false, owner.id);
                held.delete(event.pointerId);
                button.classList.remove('is-held');
            };
            button.addEventListener('pointerdown', event => {
                event.preventDefault();
                controller.input.focus();
                const owner = 'button-' + event.pointerId;
                held.set(event.pointerId, { id: owner, button });
                button.setPointerCapture(event.pointerId);
                button.classList.add('is-held');
                controller.input.key(ACTION_KEYS[button.dataset.hold], true, owner);
            });
            for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, release);
        });
        controller.onReset = () => {
            held.clear();
            controls.querySelectorAll('.is-held').forEach(button => button.classList.remove('is-held'));
            controls.querySelectorAll('[data-latch]').forEach(button => button.setAttribute('aria-pressed', 'false'));
        };
        controls.querySelectorAll('[data-zoom]').forEach(button => button.addEventListener('click', () => controller.input.wheel(Number(button.dataset.zoom) * 100)));
        document.querySelector('#tool-select').addEventListener('change', event => {
            if (event.target.value) controller.input.pulse(ACTION_KEYS[event.target.value]);
            event.target.value = '';
        });
        document.querySelector('#more-controls').addEventListener('click', event => {
            const extra = document.querySelector('#extra-controls');
            extra.hidden = !extra.hidden;
            event.currentTarget.setAttribute('aria-expanded', String(!extra.hidden));
        });
        document.querySelector('#toggle-controls').addEventListener('click', event => {
            controller.reset();
            const collapsed = controls.classList.toggle('collapsed');
            event.currentTarget.textContent = collapsed ? '+' : '−';
            event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
            event.currentTarget.setAttribute('aria-label', collapsed ? 'Expand touch controls' : 'Collapse touch controls');
        });
        document.querySelector('#controls-help').addEventListener('click', () => {
            controller.reset();
            help.hidden = false;
            document.querySelector('#close-help').focus();
        });
        document.querySelector('#close-help').addEventListener('click', () => { help.hidden = true; controller.input.focus(); });
        help.addEventListener('keydown', event => {
            event.stopPropagation(); // Do not pause/delete objects while editing controls.
            if (event.key === 'Escape') { help.hidden = true; controller.input.focus(); }
            if (event.key === 'Tab') {
                const focusable = [...help.querySelectorAll('button, input, select')].filter(element => !element.disabled);
                const index = focusable.indexOf(document.activeElement);
                if ((event.shiftKey && index === 0) || (!event.shiftKey && index === focusable.length - 1)) {
                    event.preventDefault();
                    focusable[event.shiftKey ? focusable.length - 1 : 0].focus();
                }
            }
        });
        document.querySelector('#rotation-speed').addEventListener('input', event => {
            controller.rotationSpeed = Number(event.target.value);
            document.querySelector('#rotation-value').textContent = event.target.value + '°/s';
        });
        document.querySelector('#fullscreen-button').addEventListener('click', async () => {
            const container = document.querySelector('#unity-container');
            try {
                if (document.fullscreenElement) await document.exitFullscreen();
                else if (container.requestFullscreen) await container.requestFullscreen();
                else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen();
                else status.textContent = 'Safari: Share → Add to Home Screen for a larger display';
            } catch (error) { status.textContent = 'Fullscreen unavailable: ' + error.message; }
        });
        return controller;
    }

    const api = { UnityInput, TouchController, ACTION_KEYS, angleDelta, pairGeometry, keyInfo, mount };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.MobileControls = api;
})(typeof window !== 'undefined' ? window : globalThis);
