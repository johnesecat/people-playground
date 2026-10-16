# Source recovery from the Unity WebGL build (cloud, no desktop)

Goal: recover readable code from `PPG.wasm` (50.9 MB) and `PPG.data` (112.9 MB) using only a Linux shell.

## Reconstruct the artifacts

```sh
cat Build/PPG.data.part{1..6} > .analysis/PPG.data
cat Build/PPG.wasm.part{1..3} > .analysis/PPG.wasm
```

## What was tested and the results

| Route | Command | Result |
|---|---|---|
| REA WASM inspection | `REA_WABT_BIN_DIRECTORY=<wabt>/bin npx rea-agents@6.5.0 inspect-wasm-artifact .analysis/PPG.wasm --format json` | **Rejected**: "exceeds 8388608 bytes". REA caps WASM at 8 MiB. |
| WABT validation | `wasm-validate .analysis/PPG.wasm` | Passes (exit 0). |
| WASM → WAT | `wasm2wat .analysis/PPG.wasm -o .analysis/PPG.wat` | Works in ~11 s; output is ~580 MB of WAT. Low-level, not source. |
| WASM → C-like | `wasm-decompile` | **Not in WABT 1.0.42's Linux binaries.** `wasm2c` exists but emits machine-level C, not the original C#. |
| Cpp2IL 2022.0.7 (Linux) | `./cpp2il --game-path <dir> --exe-name PPG.wasm --wasm-framework-file PPG.framework.js` | **Failed**: requires `GameAssembly.dll` or a `.exe`-style layout; the 2022 release has no documented WASM + metadata v29 path. |
| REA on `.data` / IL2CPP metadata | `rea inspect-…` | Unsupported format (earlier run). |

## What actually works

- **Unity-aware parsing with UnityPy** (`.analysis/venv`, `tools/inspect-build.py`) recovers serialized data: the `default_controls` input bindings, scenes, and MonoBehaviour fields. This is the trustworthy source of game configuration.
- **Full C# method bodies are not recoverable** from this build by any tool tested. IL2CPP does not ship IL; the WASM contains compiled native code. Tools such as Il2CppDumper or Cpp2IL can recover type/method names and signatures, but not the original method bodies.

## Next steps for full source (not yet verified here)

1. Try Il2CppDumper (a newer release than the one tested) on `global-metadata.dat` plus the WASM. It needs .NET 8, which was not installed in this sandbox. Its Linux command line is not verified.
2. Open the resulting dummy DLLs in ILSpy or dnSpy to read signatures.
3. Anything recovered this way is decompiled code, not the author's original source.
