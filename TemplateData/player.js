(function (root) {
    'use strict';
    const ASSETS = {
        wasm: [16957061, 16957061, 16957061],
        data: [18471174, 18471174, 18471174, 18471174, 18471174, 18471171]
    };
    function partPaths(kind) { return ASSETS[kind].map((size, index) => ({ path: 'Build/PPG.' + kind + '.part' + (index + 1), size })); }
    async function mergeParts(parts, fetcher, onProgress, signal) {
        const blobs = [];
        for (const part of parts) {
            const response = await fetcher(part.path, { signal });
            if (!response.ok) throw new Error(part.path + ': HTTP ' + response.status);
            // Each part is bounded (~19 MB). Blobs avoid a second giant joined
            // ArrayBuffer in addition to the WASM heap (initial 128 MiB, grows on demand).
            const blob = await response.blob();
            if (blob.size !== part.size) throw new Error(part.path + ': incomplete download (' + blob.size + ' of ' + part.size + ' bytes)');
            blobs.push(blob);
            onProgress(blob.size);
        }
        return new Blob(blobs, { type: 'application/octet-stream' });
    }
    function guardFullscreen(env) {
        // Unity answers some synthetic mouse events with requestFullscreen. Browsers
        // require a real user gesture, so skip the request instead of throwing.
        const proto = env.Element && env.Element.prototype;
        if (!proto || typeof proto.requestFullscreen !== 'function') return;
        const native = proto.requestFullscreen;
        proto.requestFullscreen = function (...args) {
            const activation = env.navigator.userActivation;
            if (activation && !activation.isActive) return Promise.resolve();
            return native.apply(this, args).catch(() => {});
        };
    }
    function loadScript(document, path) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = path;
            script.onload = resolve;
            script.onerror = () => { script.remove(); reject(new Error('Could not load ' + path)); };
            document.body.appendChild(script);
        });
    }
    async function boot() {
        const document = root.document;
        const canvas = document.querySelector('#unity-canvas');
        const loading = document.querySelector('#loading-panel');
        const label = document.querySelector('#loading-text');
        const detail = document.querySelector('#loading-detail');
        const progress = document.querySelector('#load-progress');
        const start = document.querySelector('#start-button');
        const retry = document.querySelector('#retry-button');
        const banner = document.querySelector('#unity-warning');
        // Register capture-phase touch handlers before Unity registers its own
        // listeners, otherwise native and translated input could both reach it.
        const controller = root.MobileControls.mount(canvas);
        let phase = 'idle';
        const objectUrls = [];
        const abort = new AbortController();
        let errorShown = false;
        function fail(error) {
            console.error('Player:', error);
            errorShown = true;
            phase = 'failed';
            if (controller) { controller.reset(); controller.enabled = false; }
            document.querySelector('#mobile-controls').hidden = true;
            loading.hidden = false;
            start.hidden = true;
            retry.hidden = false;
            label.textContent = 'The game could not start.';
            detail.textContent = String(error.message || error) + ' Check your connection and free memory, close other tabs, then reload. Some iOS devices cannot run this Unity build.';
        }
        function resize() {
            const container = document.querySelector('#unity-container');
            const viewport = root.visualViewport;
            container.style.height = (viewport ? viewport.height : root.innerHeight) + 'px';
            // Unity synchronizes its backing buffer using matchWebGLToCanvasSize.
            // Do not reset canvas.width every resize: that discards GL state.
            if (controller) controller.reset();
        }
        root.addEventListener('resize', resize);
        root.addEventListener('orientationchange', resize);
        if (root.visualViewport) root.visualViewport.addEventListener('resize', resize);
        resize();
        canvas.addEventListener('webglcontextlost', () => fail(new Error('Safari released the WebGL graphics context. Reload to restore the game.')));
        retry.addEventListener('click', () => root.location.reload());
        start.addEventListener('click', async () => {
            if (phase === 'ready') {
                loading.hidden = true;
                canvas.focus({ preventScroll: true });
                phase = 'playing';
                return;
            }
            if (phase !== 'idle') return;
            phase = 'loading';
            start.disabled = true;
            start.textContent = 'Loading…';
            try {
                if (typeof root.WebAssembly !== 'object') throw new Error('WebAssembly is not available in this browser.');
                const probe = document.createElement('canvas');
                const context = probe.getContext('webgl2');
                if (!context) throw new Error('WebGL 2 is unavailable. Try an updated Safari with WebGL enabled.');
                const lose = context.getExtension('WEBGL_lose_context');
                if (lose) lose.loseContext();
                const total = [...ASSETS.wasm, ...ASSETS.data].reduce((sum, size) => sum + size, 0);
                let downloaded = 0;
                const onProgress = bytes => {
                    downloaded += bytes;
                    progress.value = downloaded / total * 0.55;
                    label.textContent = 'Downloading game…';
                    detail.textContent = (downloaded / 1000000).toFixed(1) + ' / ' + (total / 1000000).toFixed(1) + ' MB · keep this tab open';
                };
                label.textContent = 'Downloading game…';
                // Serial groups keep only one HTTP part download active on mobile.
                const wasmBlob = await mergeParts(partPaths('wasm'), root.fetch.bind(root), onProgress, abort.signal);
                const wasmUrl = URL.createObjectURL(wasmBlob);
                objectUrls.push(wasmUrl);
                const dataBlob = await mergeParts(partPaths('data'), root.fetch.bind(root), onProgress, abort.signal);
                const dataUrl = URL.createObjectURL(dataBlob);
                objectUrls.push(dataUrl);
                label.textContent = 'Starting Unity…';
                detail.textContent = 'Compiling the game. First launch can take a while on phones.';
                guardFullscreen(root);
                await loadScript(document, 'Build/PPG.loader.js');
                if (typeof root.createUnityInstance !== 'function') throw new Error('The Unity loader did not provide createUnityInstance.');
                await root.createUnityInstance(canvas, {
                    dataUrl, codeUrl: wasmUrl, frameworkUrl: 'Build/PPG.framework.js',
                    streamingAssetsUrl: 'StreamingAssets', companyName: 'Studio Minus',
                    productName: 'People Playground', productVersion: '0',
                    matchWebGLToCanvasSize: true,
                    showBanner(message, type) {
                        if (type === 'error') fail(new Error(message));
                        else { banner.textContent = message; banner.hidden = false; }
                    }
                }, amount => { progress.value = 0.55 + amount * 0.45; });
                if (errorShown) return;
                progress.value = 1;
                phase = 'ready';
                label.textContent = 'Ready to play';
                detail.textContent = 'Tap Play to enter. Touch controls include an in-game help button (?).';
                start.disabled = false;
                start.textContent = 'Play';
            } catch (error) {
                abort.abort();
                fail(error);
            } finally {
                objectUrls.splice(0).forEach(url => URL.revokeObjectURL(url));
            }
        });
        // Release held virtual input on interruptions. Unity's own visibility
        // handling controls suspension; do not toggle game pause on return.
        root.addEventListener('pagehide', event => {
            if (controller) controller.reset();
            if (!event.persisted && phase === 'loading') abort.abort();
        });
    }
    const api = { ASSETS, partPaths, mergeParts, guardFullscreen, loadScript };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else { root.BrowserPlayer = api; boot(); }
})(typeof window !== 'undefined' ? window : globalThis);
