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
    function pairGeometry(a, b) {
        return {
            x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2,
            distance: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
            angle: Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX)
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

    class TouchController {
        constructor(canvas, options = {}) {
            this.canvas = canvas;
            this.env = options.env || root;
            this.input = options.input || new UnityInput(canvas, this.env);
            this.status = options.status || (() => {});
            this.cursor = options.cursor || (() => {});
            this.onMode = options.onMode || (() => {});
            this.enabled = true;
            this.mode = 'grab';
            this.doubleTap = true;
            this.rotationSpeed = 180;
            this.primaryId = null;
            this.secondaryId = null;
            this.primary = null;
            this.pair = null;
            this.rotationMs = 0;
            this.rotationKey = null;
            this.longTimer = null;
            this.lastTap = null;
            this.listeners = [];
            this.lastTouchTime = -Infinity;
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
        setMode(mode) {
            if (!['grab', 'activate', 'camera', 'context'].includes(mode)) return;
            this.reset();
            this.mode = mode;
            this.status({ grab: 'Drag · twist to rotate · Camera to pan/zoom', activate: 'Tap an object to activate', camera: 'Drag to pan · pinch to zoom', context: 'Tap an object for its menu' }[mode]);
            this.onMode(mode);
        }
        clearLongPress() {
            if (this.longTimer !== null) this.env.clearTimeout(this.longTimer);
            this.longTimer = null;
        }
        findTouch(list, id) { return Array.from(list).find(touch => touch.identifier === id); }
        handleTouch(event) {
            if (!this.enabled) return;
            this.consume(event);
            this.lastTouchTime = this.env.performance.now();
            // targetTouches excludes fingers holding toolbar buttons (Use / rotate).
            const touches = Array.from(event.targetTouches);
            if (event.type === 'touchcancel') { this.reset(); return; }
            if (event.type === 'touchstart' && this.primaryId === null && touches.length) {
                const first = touches[0];
                this.input.focus();
                this.primaryId = first.identifier;
                this.primary = { x: first.clientX, y: first.clientY, time: this.lastTouchTime, moved: false, multi: false, context: false, lastX: first.clientX, lastY: first.clientY };
                this.moveCursor(first);
                this.input.mouse('mousemove', first.clientX, first.clientY);
                if (this.mode === 'grab' || this.mode === 'camera') this.input.mouse('mousedown', first.clientX, first.clientY, this.mode === 'camera' ? 1 : 0);
                if (this.mode === 'grab') {
                    this.longTimer = this.env.setTimeout(() => {
                        this.longTimer = null;
                        if (!this.primary || this.primary.moved || this.primary.multi) return;
                        this.input.releaseMouse();
                        this.contextClick(first);
                        this.primary.context = true;
                    }, 650);
                }
            }
            const primary = this.findTouch(touches, this.primaryId);
            if (!primary) {
                if (this.primary) this.finishPrimary(event);
                return;
            }
            this.moveCursor(primary);
            if (Math.hypot(primary.clientX - this.primary.x, primary.clientY - this.primary.y) > 10) {
                this.primary.moved = true;
                this.clearLongPress();
            }
            const secondary = this.findTouch(touches, this.secondaryId) || touches.find(touch => touch.identifier !== this.primaryId);
            if (secondary) {
                this.clearLongPress();
                this.primary.multi = true;
                const geometry = pairGeometry(primary, secondary);
                if (!this.pair || this.secondaryId !== secondary.identifier) {
                    this.pair = geometry;
                    this.secondaryId = secondary.identifier;
                } else if (event.type === 'touchmove') {
                    this.updatePair(primary, geometry);
                    this.pair = geometry;
                }
            } else {
                this.pair = null;
                this.secondaryId = null;
                this.stopRotation();
                if (event.type === 'touchmove' && !this.primary.context) {
                    if (this.mode === 'camera') {
                        this.input.mouse('mousemove', this.input.position.x + primary.clientX - this.primary.lastX, this.input.position.y + primary.clientY - this.primary.lastY);
                    } else this.input.mouse('mousemove', primary.clientX, primary.clientY);
                }
            }
            this.primary.lastX = primary.clientX;
            this.primary.lastY = primary.clientY;
        }
        moveCursor(touch) { this.cursor(touch.clientX, touch.clientY, true); }
        updatePair(primary, geometry) {
            const old = this.pair;
            // Keep camera zoom separate from object rotation. An imperfect twist
            // must not unexpectedly zoom the scene underneath a held object.
            if (this.mode === 'camera' && old.distance > 10 && geometry.distance > 10) {
                const zoom = -Math.log(geometry.distance / old.distance) * 600;
                if (Math.abs(zoom) > 0.2) {
                    const position = this.mode === 'camera' ? this.input.position : { x: primary.clientX, y: primary.clientY };
                    this.input.wheel(Math.max(-120, Math.min(120, zoom)), position.x, position.y);
                }
            }
            if (this.mode === 'camera') {
                this.input.mouse('mousemove', this.input.position.x + geometry.x - old.x, this.input.position.y + geometry.y - old.y);
            } else if (this.mode === 'grab' && !this.primary.context) {
                this.input.mouse('mousemove', primary.clientX, primary.clientY);
                // A/D are continuous rotation inputs, not an angle setter. Convert
                // finger angle to a bounded duration at the user-calibrated rate.
                const degrees = angleDelta(old.angle, geometry.angle) * 180 / Math.PI;
                this.rotationMs = Math.max(-1000, Math.min(1000, this.rotationMs + degrees / this.rotationSpeed * 1000));
            }
        }
        tick(milliseconds) {
            let next = null;
            if (this.pair && this.mode === 'grab' && Math.abs(this.rotationMs) > 2) {
                next = this.rotationMs > 0 ? 'KeyD' : 'KeyA';
                this.rotationMs -= Math.sign(this.rotationMs) * Math.min(Math.abs(this.rotationMs), milliseconds);
            }
            if (next !== this.rotationKey) {
                if (this.rotationKey) this.input.key(this.rotationKey, false, 'gesture');
                if (next) this.input.key(next, true, 'gesture');
                this.rotationKey = next;
            }
        }
        stopRotation() {
            if (this.rotationKey) this.input.key(this.rotationKey, false, 'gesture');
            this.rotationKey = null;
            this.rotationMs = 0;
        }
        contextClick(touch) {
            this.input.mouse('mousemove', touch.clientX, touch.clientY);
            this.input.mouse('mousedown', touch.clientX, touch.clientY, 2);
            // Same duration guarantee as keyboard pulses; Unity polls once per frame.
            this.contextTimer = this.env.setTimeout(() => {
                this.input.mouse('mouseup', undefined, undefined, 2);
                this.contextTimer = null;
            }, 80);
            this.status('Object menu · tap an entry with Grab');
        }
        finishPrimary(event) {
            this.clearLongPress();
            const ended = this.findTouch(event.changedTouches, this.primaryId);
            const tap = ended && !this.primary.moved && !this.primary.multi && !this.primary.context && this.lastTouchTime - this.primary.time < 500;
            this.input.releaseMouse();
            this.stopRotation();
            if (tap) {
                this.input.mouse('mousemove', ended.clientX, ended.clientY);
                if (this.mode === 'activate') this.input.pulse('KeyF');
                else if (this.mode === 'context') {
                    this.contextClick(ended);
                    this.mode = 'grab';
                    this.onMode('grab');
                } else if (this.mode === 'grab' && this.doubleTap) {
                    if (this.lastTap && this.lastTouchTime - this.lastTap.time < 320 && Math.hypot(ended.clientX - this.lastTap.x, ended.clientY - this.lastTap.y) < 28) {
                        this.input.pulse('KeyF');
                        this.lastTap = null;
                    } else this.lastTap = { x: ended.clientX, y: ended.clientY, time: this.lastTouchTime };
                }
            } else this.lastTap = null;
            this.primaryId = null;
            this.secondaryId = null;
            this.primary = null;
            this.pair = null;
            // If the anchor finger lifts, release everything. Do not silently grab
            // with the other finger; a fresh touch starts a new gesture.
        }
        reset() {
            this.clearLongPress();
            if (this.contextTimer) this.env.clearTimeout(this.contextTimer);
            this.contextTimer = null;
            this.stopRotation();
            this.input.reset();
            this.primaryId = this.secondaryId = null;
            this.primary = this.pair = this.lastTap = null;
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
            },
            onMode: mode => controls.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)))
        });
        const enabled = document.querySelector('#touch-enabled');
        enabled.checked = navigator.maxTouchPoints > 0 || root.matchMedia('(pointer: coarse)').matches;
        function setEnabled() {
            controller.reset();
            controller.enabled = enabled.checked;
            controls.hidden = !enabled.checked;
            desktopToggle.hidden = enabled.checked;
            status.textContent = enabled.checked ? 'Grab · tap ? for controls' : '';
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
        controls.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => controller.setMode(button.dataset.mode)));
        controls.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => controller.input.pulse(ACTION_KEYS[button.dataset.action])));
        // One facing toggle decides which spawn key the Spawn button sends (Q = left, E = right).
        let facing = 'left';
        const facingButtons = controls.querySelectorAll('[data-facing]');
        const setFacing = next => {
            facing = next;
            facingButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.facing === next)));
        };
        facingButtons.forEach(button => button.addEventListener('click', () => setFacing(button.dataset.facing)));
        controls.querySelector('[data-spawn]').addEventListener('click', () => controller.input.pulse(ACTION_KEYS[facing === 'left' ? 'spawnLeft' : 'spawnRight']));
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
        document.querySelector('#double-tap').addEventListener('change', event => { controller.doubleTap = event.target.checked; });
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
