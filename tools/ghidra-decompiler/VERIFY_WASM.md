# Verifying Ghidra Decompiler WASM

This guide explains how the WebAssembly implementation was verified and how you can perform the same verification with a real GCC-compiled binary.

## How it was verified during development

Since the development environment does not have a full browser or the `emcc` compiler, verification was split into three parts:

### 1. Backend Logic (Native)
The core decompiler logic (`WasmArchitecture` and `WasmSleigh`) was verified using a native standalone build. This ensures that the custom memory-based loading and decompilation process works correctly on real ELF binaries.

### 2. Bridge API (Native)
A dedicated test runner (`test_wasm_bridge.cc`) was used to verify the exact C API exported to WebAssembly. This confirmed that `decompile_pcode` and `detect_architecture` behave correctly when given real binary data and specification strings.

**To run the full native verification:**
```bash
bash verify_native.sh
```
This script automates the compilation of a test program and verifies both the standalone engine and the bridge API.

### 3. Frontend UI (Mocked WASM)
The JavaScript bridge and UI logic were verified using **Playwright**.
1. A mock WASM module was created to simulate the decompiler's exports.
2. Playwright automated a browser to:
   - Load `example_wasm.html`.
   - Verify that `processors.json` (containing 181 architectures) is fetched correctly.
   - Verify that selecting an architecture (e.g., x86) correctly populates the compiler options.
   - Capture a screenshot of the functional UI.

---

## How YOU can verify the full WASM implementation

To verify the real WASM module with a GCC binary, follow these steps:

### Step 1: Build the WASM Module
Ensure you have the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) installed and activated.
```bash
make -f Makefile.wasm
```
This produces `ghidra_decompiler.js` and `ghidra_decompiler.wasm`.

### Step 2: Compile a Test Binary
Compile a simple C program. We use `-O2` to make it interesting but not too complex.
```bash
echo '#include <stdio.h>
int main() {
    printf("Hello from WASM verification!\n");
    return 0;
}' > test.c
gcc -O2 test.c -o test.elf
```

### Step 3: Start a Web Server
WASM modules cannot be loaded via `file://` URLs.
```bash
python3 -m http.server 8000
```

### Step 4: Run the Decompiler in your Browser
1. Open `http://localhost:8000/wasm_examples/example_wasm.html`.
2. The page should say **"Module ready"**.
3. **Load Binary**: Click "Choose File" under "3. Load Binary" and select `test.elf`.
4. **Auto-Detection**: The UI should automatically detect **"Intel/AMD 64-bit x86"** and fetch its specs.
5. **Set Function**: In the "Function name/addr" field, enter `main`.
6. Click **"Run Decompiler"**.

### Step 5: Verify Result
The "Output" section should show the decompiled C code:
```c
void main(void) {
    puts("Hello from WASM verification!");
    return;
}
```
