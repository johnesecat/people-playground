# People Playground · browser wrapper

A static wrapper around the **existing compiled Unity WebGL port**. No backend, runtime npm dependencies, remote CDN base URL, or build step. The Unity game source is not included and the compiled files in `Build/` are unchanged.

## Run / host

Serve this directory over HTTP, for example:

```sh
python3 -m http.server 3000 --bind 0.0.0.0
```

Open the page, tap **Load game**, wait for **Ready to play**, then tap **Play**. The second user interaction also gives Unity's audio unlock listeners a fresh user gesture.

For GitHub Pages, publish the repository root (branch or your existing Pages workflow). Keep `index.html`, `TemplateData/`, and **all nine** `Build/*.part*` files together with their original names. All wrapper URLs are relative and support project paths such as `/people-playground/`. No special response headers or server-side services are required by this wrapper. The shipped WASM memory is unshared (not a pthread/SharedArrayBuffer build).

### GitHub Pages setup

After these changes are on `main`, open **johnesecat/people-playground → Settings → Pages**:

1. Set **Source** to **Deploy from a branch**.
2. Choose **main** and **/ (root)**, then **Save**.
3. Wait for the Pages deployment in **Actions** to finish. Use the URL shown by Pages (normally `https://johnesecat.github.io/people-playground/`).
4. On Safari, open that URL, tap **Load game**, wait, then tap **Play**. Use landscape and **?** for gesture help. Add to Home Screen for a larger display.

`.nojekyll` keeps this a plain static site. No npm install, server, secrets, or REA installation is needed by players. REA is development tooling only. Pages settings/deployment are not changed by a Git push alone.

## Touch controls

- **Drag:** one finger drags (click, or drag to move the view or an object). Hold still for about 0.65 s to open the object menu.
- **Zoom:** put two fingers down together (either finger first) and pinch.
- **Rotate:** keep the left finger down, then move the right finger up (rotate left, A) or down (rotate right, D).
- **Activate / fire:** while dragging an object, touch with a second finger to hold F until it lifts. A quick second-finger tap sends one F.
- **Spawn:** the facing toggle sets which way the object spawns (Q = left, E = right); Spawn adds the object and Place drops it.
- **Rotate:** keep the first finger on the held object and twist a second around it. This translates angle changes into **A / D** key durations, not a direct Unity angle setter. Adjust the rotation speed under **?** to match the game; hold **↶ / ↷** for fine control.
- **Activate:** tap an object to send **F** without grabbing it. Hold **Use / fire** while dragging or aiming with another finger.
- **Camera:** one-finger middle-mouse pan; two-finger centroid pan and pinch zoom. Grab reserves two fingers for rotation, avoiding accidental zoom during a twist.
- **Inspect:** tap for right-click, then automatically return to Grab to select menu entries. A stationary 650 ms long-press in Grab also opens the menu. Freeze is available through the game's object menu, not a guessed freeze hotkey.
- **Toolbar:** pause, items, Q/E spawning, delete, slow motion, undo recent spawn, tools panel, Escape, latched Shift/Alt, tools 1–9, Copy/Paste, Details, Thermal, center-of-mass snap, tools/powers toggle, zoom and fullscreen where supported.
- **− / +:** collapse / restore the overlay. Mouse and physical keyboard controls remain available. Mouse-only devices can enable the overlay with **Touch controls**.

Bindings are checked against **this build's extracted `default_controls` TextAsset** (55 actions), retained in `tests/fixtures/default-controls.json` with hashes in `build-evidence.json`. C means Copy; Left Ctrl means tools/powers; Alt means snap. Freeze has no default hotkey. Tool positions 1–9 are used rather than assuming a fixed tool order. Restore the game's defaults if you have customized bindings. Touch gesture handling is registered before Unity initializes, suppresses duplicate native touch / compatibility mouse delivery, ignores fingers on toolbar buttons, and releases virtual inputs on cancellation, focus loss, page hiding, rotation, and resizing.

## REA setup and use

Ran the approved `npx rea-agents@latest setup` flow (resolved to **6.5.0**). No supported coding clients were detected, so setup had no client actions. Freebuff/Codebuff is not a first-class REA setup target; `.agents/mcp.json` supplies a project-local manual registration using:

```sh
npx -y rea-agents@6.5.0 --mcp
```

Reload an MCP-capable Freebuff project/session to discover it. This already-running cloud session cannot hot-load MCP tools; REA was used through its CLI here. No other agent's configuration was changed and no native analysis engines were installed.

Verified with:

```sh
npx -y rea-agents@6.5.0 mcp doctor --json
```

Result: healthy production stdio server, version **6.5.0**, **207/207 tools**, **6/6 prompts**, matching catalog identity, successful `binary_session` request. The broad `doctor --target Build/PPG.framework.js` audit is **not globally healthy**: optional native engines and the bundled personal workflow skill are absent. This does not block the CLI JavaScript analysis or tested MCP startup.

Used REA's inert static JavaScript analysis on both shipped scripts:

```sh
npx -y rea-agents@6.5.0 analyze-javascript-application . \
  --source-path Build/PPG.framework.js --max-semantic-nodes 5000 \
  --max-semantic-nodes-per-file 5000 --analysis-timeout-ms 60000 --format json
```

Repeat with `Build/PPG.loader.js` for the loader. REA recovered `registerMouseEventCallback`, `registerKeyEventCallback`, `registerTouchEventCallback`, and `createUnityInstance`; both selected files parsed with zero parse failures. Analysis was intentionally bounded and partial, not a decompilation of the Unity game. Its documented WASM inspection size limit is below this ~51 MB module, so no REA WASM decompilation is claimed. The input layer uses observed browser events, not invented `SendMessage` targets.

Reference: [REA](https://rea.tools/) · [REA installation](https://github.com/morluto/rea/blob/main/docs/installation.md).

### What is inside the `.part` files

These are **raw byte splits, not individually encrypted files**. Reassembly yields:

- `PPG.data`: **112,889,548 bytes**, a `UnityWebData1.0` archive containing 10 entries, including a UnityFS bundle, resources, configuration, and IL2CPP metadata.
- `PPG.wasm`: **50,871,183 bytes**, a compiled WebAssembly module.
- `Il2CppData/Metadata/global-metadata.dat`: **9,375,196 bytes**, unencrypted IL2CPP metadata version **29**, magic `0xFAB11BAF`.

REA 6.5.0 was actually run on the joined data, WASM and extracted metadata. It rejected the data and metadata with `unsupported_target / file_format_rejected`, and directed WASM to its separate WABT route. That route returned `capability_unavailable` because caller-supplied WABT was not installed; its documented **8 MiB per-file limit** is also below the full module. No protection was bypassed and no limit was disabled. REA's supported static analyzer was then used to inventory the recovered controls JSON. **It did not decompile the game's IL2CPP/WASM or produce original C# source.**

A supplementary Unity-aware extraction with **UnityPy 1.25.4** recovered the `default_controls` TextAsset (path ID 179) from `data.unity3d`. This is serialized configuration, not source code. Custom MonoBehaviour fields did not fully parse without their missing typetrees, so exact gameplay implementation and rotation speed remain unproven.

Reproduce archive and controls extraction locally (not on the hosted site):

```sh
python3 -m venv .analysis/venv
.analysis/venv/bin/pip install UnityPy==1.25.4
.analysis/venv/bin/python tools/inspect-build.py --controls
npx -y rea-agents@6.5.0 inspect-artifact .analysis/PPG.data --format json
npx -y rea-agents@6.5.0 inspect-artifact .analysis/extracted/Il2CppData/Metadata/global-metadata.dat --format json
npx -y rea-agents@6.5.0 inspect-wasm-artifact .analysis/PPG.wasm --glue_paths Build/PPG.framework.js --format json
```

The last three commands reproduce the reported unsupported-format/tooling errors, not successful decompilation. All generated archives, extracted resources, dependencies and logs stay under ignored `.analysis/`; they are not committed. Only the small controls fixture, provenance hashes and reproducible extractor are included. The default extraction without `--controls` uses Python's standard library only.

See [REA WASM limits](https://github.com/morluto/rea/blob/main/docs/wasm-artifacts.md), [REA managed-code scope](https://github.com/morluto/rea/blob/main/docs/managed-code-analysis.md), and [UnityPy](https://github.com/K0lb3/UnityPy).

## Automated checks

Node.js 22+ (tested with 24.21.0), using only Node's built-in test runner:

```sh
node --test tests/*.test.cjs
node --check TemplateData/mobile-controls.js
node --check TemplateData/player.js
git diff --check
```

Tests cover exact bindings against the recovered asset, gesture event sequences, interruption cleanup, keyboard ownership, toolbar/canvas finger isolation, shortest-angle rotation, context menus, ordered downloads, errors, Pages-relative resources, actual WASM compilation and archive bounds. One test executes the original generated Unity input callback functions in isolation and asserts the translated keycode, button mask and canvas-relative coordinates. Shell lifecycle tests use a simulated DOM/Unity instance; these are **not browser or full-game end-to-end tests**. There is no TypeScript project or build/typecheck command in this repository.

## Real iOS Safari acceptance — still required

The cloud environment has no browser automation or attached iOS device. These checks are **pending**, not passes:

1. On a recent iPhone and iPad, load the actual game, choose a map, spawn an object, drag and release it. Check menus and text inputs, audio after Play, and physics performance.
2. Twist both ways while holding an object, lift either finger first, and try Camera pan + pinch. Calibrate rotation speed. Verify no duplicate movement or stuck grabs.
3. Use Spawn and Place, drag an object with one finger, and hold Use / fire while aiming. Inspect an object and select Freeze. Try each toolbar shortcut and each tool in game.
4. Rotate portrait/landscape, hide/show Safari's bars, background and return, interrupt a gesture, and test Add to Home Screen. Verify safe-area placement and touch targets at your device size.
5. Repeat on the published GitHub Pages URL with network/console inspection. Confirm all nine parts load locally and no runtime dependency fails.

**Compatibility limit:** the nine split assets total ~164 MB; the WASM declares a **512 MiB initial heap** and a **2 GiB maximum**. The wrapper avoids an extra giant joined ArrayBuffer and uses Unity's default pixel ratio, but cannot reduce the game's compiled memory requirements or physics cost. WebGL 2 and substantial free device memory are necessary. Safari can terminate a large tab without a recoverable JavaScript error. Therefore universal iOS compatibility, 100% feature parity, and sustained performance are not guaranteed by these wrapper changes; a smaller/mobile-targeted Unity rebuild would require the original project.
