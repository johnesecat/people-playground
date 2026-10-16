'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ASSETS, partPaths, mergeParts, guardFullscreen } = require('../TemplateData/player.js');

test('split downloads merge in order and account for all bytes', async () => {
    const requested = [], counts = [];
    const parts = [{ path: 'first', size: 3 }, { path: 'second', size: 2 }];
    const blob = await mergeParts(parts, async name => {
        requested.push(name);
        return new Response(name.split('?')[0] === 'first' ? 'abc' : 'de');
    }, bytes => counts.push(bytes));
    assert.deepEqual(requested.map(name => name.split('?')[0]), ['first', 'second']);
    assert.ok(requested.every(name => /\?v=[0-9a-f]+$/.test(name)), 'every part request carries the build version');
    assert.deepEqual(counts, [3, 2]);
    assert.equal(await blob.text(), 'abcde');
});

test('404s fail before HTML error documents become Unity assets', async () => {
    await assert.rejects(mergeParts([{ path: 'missing', size: 2 }], async () => new Response('not found', { status: 404 }), () => {}), /HTTP 404/);
});

test('truncated part downloads are rejected', async () => {
    await assert.rejects(mergeParts([{ path: 'partial', size: 10 }], async () => new Response('short'), () => {}), /incomplete download/);
});

test('network failures and cancellation reach the caller', async () => {
    await assert.rejects(mergeParts([{ path: 'offline', size: 1 }], async () => { throw new Error('offline'); }, () => {}), /offline/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(mergeParts([{ path: 'cancel', size: 1 }], async (name, options) => { options.signal.throwIfAborted(); }, () => {}, abort.signal), /abort/i);
});

test('synthetic fullscreen requests without user activation do not throw', async () => {
    class Element { requestFullscreen() { throw new TypeError('Cannot request fullscreen without transient activation.'); } }
    const env = { Element, navigator: { userActivation: { isActive: false } } };
    guardFullscreen(env);
    await new Element().requestFullscreen();
    env.navigator.userActivation.isActive = true;
    assert.throws(() => new Element().requestFullscreen(), /transient activation/);
});

test('all deployed resources resolve locally under a GitHub Pages project path', () => {
    const html = fs.readFileSync('index.html', 'utf8');
    assert.doesNotMatch(html, /<base\b|https?:\/\/|cdn\./);
    for (const [, resource] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        assert.equal(new URL(resource, 'https://example.github.io/people-playground/').pathname.startsWith('/people-playground/'), true);
        assert.equal(fs.existsSync(resource), true, resource);
    }
    for (const kind of ['wasm', 'data']) {
        partPaths(kind).forEach(part => assert.equal(fs.statSync(part.path).size, part.size, part.path));
    }
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate DOM IDs');
    for (const file of ['TemplateData/player.js', 'TemplateData/mobile-controls.js']) {
        const source = fs.readFileSync(file, 'utf8');
        for (const [, id] of source.matchAll(/querySelector\('#([\w-]+)'\)/g)) assert.ok(ids.includes(id), id);
        assert.doesNotMatch(source, /https?:\/\/|fetch\(['"]\//);
    }
});

test('the actual shipped WASM compiles and uses unshared memory (no COOP/COEP needed)', async () => {
    const bytes = Buffer.concat(partPaths('wasm').map(part => fs.readFileSync(part.path)));
    assert.equal(bytes.subarray(0, 4).toString(), '\0asm');
    const module = await WebAssembly.compile(bytes);
    assert.ok(WebAssembly.Module.exports(module).length > 0);
    let position = 8;
    function leb() {
        let result = 0, shift = 0, byte;
        do { byte = bytes[position++]; result |= (byte & 127) << shift; shift += 7; } while (byte & 128);
        return result;
    }
    let memories = 0;
    while (position < bytes.length) {
        const id = bytes[position++]; const size = leb(); const end = position + size;
        if (id === 5) {
            const count = leb(); memories += count;
            for (let i = 0; i < count; i++) {
                const flags = leb(); const initial = leb();
                assert.equal(flags & 2, 0, 'not SharedArrayBuffer-backed');
                assert.equal(initial * 65536, 134217728, '128 MiB initial memory (patched from 512 MiB; grows on demand)');
                if (flags & 1) leb();
            }
        }
        position = end;
    }
    assert.equal(memories, 1);
});

test('Unity data archive entries fit the joined split files', () => {
    const bytes = fs.readFileSync(partPaths('data')[0].path);
    assert.equal(bytes.subarray(0, 16).toString(), 'UnityWebData1.0\0');
    const headerEnd = bytes.readUInt32LE(16);
    const total = ASSETS.data.reduce((sum, size) => sum + size, 0);
    let position = 20;
    const entries = [];
    while (position < headerEnd) {
        const offset = bytes.readUInt32LE(position), size = bytes.readUInt32LE(position + 4), length = bytes.readUInt32LE(position + 8);
        const name = bytes.subarray(position + 12, position + 12 + length).toString();
        assert.ok(offset >= headerEnd && offset + size <= total, name);
        entries.push(name); position += 12 + length;
    }
    assert.equal(position, headerEnd);
    assert.ok(entries.includes('Il2CppData/Metadata/global-metadata.dat'));
});

function shellFixture(options = {}) {
    class Element {
        constructor() { this.hidden = false; this.disabled = false; this.style = {}; this.listeners = {}; }
        addEventListener(type, callback) { this.listeners[type] = callback; }
        focus() { this.focused = true; }
        getContext() { return options.webgl === false ? null : { getExtension: () => null }; }
        remove() {}
    }
    const ids = [...fs.readFileSync('index.html', 'utf8').matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    const elements = Object.fromEntries(ids.map(id => ['#' + id, new Element()]));
    let mounts = 0, initialization = 0;
    const revoked = [];
    const window = {
        document: {
            querySelector: selector => { assert.ok(elements[selector], selector); return elements[selector]; },
            createElement: () => new Element(),
            body: { appendChild: script => script.onload() }
        },
        console: { error: () => {} },
        navigator: { maxTouchPoints: 5 }, innerHeight: 400,
        WebAssembly, addEventListener() {}, fetch: async url => {
            if (options.downloadError) return { ok: false, status: 404 };
            const part = [...partPaths('wasm'), ...partPaths('data')].find(part => part.path === url.split('?')[0]);
            assert.match(url, /\?v=[0-9a-f]+$/, 'part URLs carry a build version');
            return { ok: true, blob: async () => ({ size: part.size }) };
        },
        MobileControls: { mount: () => { mounts++; return { reset() {} }; } },
        createUnityInstance: async (canvas, config, progress) => {
            initialization++;
            assert.equal(mounts, 1, 'touch interception is mounted before Unity initialization');
            assert.equal(config.frameworkUrl, 'Build/PPG.framework.js');
            assert.equal(config.devicePixelRatio, undefined, 'Unity default pixel ratio');
            progress(1);
            if (options.unityError) throw new Error('Unity allocation failed');
            if (options.bannerError) config.showBanner('runtime failed', 'error');
            return {};
        },
        location: { reload() {} }
    };
    let nextUrl = 0;
    const sandbox = {
        window, AbortController, Blob, URL: { createObjectURL: () => 'blob:' + ++nextUrl, revokeObjectURL: url => revoked.push(url) }
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync('TemplateData/player.js', 'utf8'), sandbox);
    return { elements, revoked, get mounts() { return mounts; }, get initialization() { return initialization; } };
}

test('the public Load → Ready → Play flow mounts interception before Unity and only once', async () => {
    const f = shellFixture();
    await f.elements['#start-button'].listeners.click();
    assert.equal(f.initialization, 1); assert.equal(f.mounts, 1);
    assert.equal(f.elements['#loading-text'].textContent, 'Ready to play');
    assert.equal(f.elements['#start-button'].textContent, 'Play');
    assert.equal(f.revoked.length, 2);
    await f.elements['#start-button'].listeners.click();
    assert.equal(f.mounts, 1); assert.equal(f.elements['#loading-panel'].hidden, true);
    await f.elements['#start-button'].listeners.click();
    assert.equal(f.mounts, 1);
});

for (const reason of ['downloadError', 'unityError', 'bannerError']) {
    test(reason + ' shows a recoverable failure and never exposes Play', async () => {
        const f = shellFixture({ [reason]: true });
        await f.elements['#start-button'].listeners.click();
        assert.equal(f.elements['#loading-text'].textContent, 'The game could not start.');
        assert.equal(f.elements['#retry-button'].hidden, false);
        assert.equal(f.elements['#start-button'].hidden, true);
        assert.equal(f.mounts, 1);
    });
}

test('missing WebGL 2 reports unsupported hardware before any downloads', async () => {
    const f = shellFixture({ webgl: false });
    await f.elements['#start-button'].listeners.click();
    assert.match(f.elements['#loading-detail'].textContent, /WebGL 2 is unavailable/);
    assert.equal(f.initialization, 0);
});
