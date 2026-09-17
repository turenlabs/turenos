import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"

// Build, verify, and pack a WASM tool target into packages/<target>-wasm.
// Mirrors .github/workflows/build-<target>.yml; those remain authoritative.
//
//   bun run build:wasm <target> [target...]   build specific tools
//   bun run build:wasm --all                  build every tool (very slow)
//   bun run build:wasm --list                 list known targets
//
// Flags: --no-test skips host-side unit tests, --pack-only re-runs only the
// pack + checksum steps against an existing tools/<target>/pkg or dist.

const root = path.resolve(import.meta.dirname, "..")
const pkgDir = (target: string) => path.join(root, "packages", `${target}-wasm`)

type Step = { run: string; cwd?: string; env?: Record<string, string>; test?: boolean; pack?: boolean }
type Recipe = {
  rust?: string
  wasmPack?: string
  emscripten?: string
  upstreams?: { name: string; repo: string; commit: string; submodules?: boolean }[]
  steps: Step[]
}

const WASM_PACK = "0.15.0"
const pkg = (t: string) => `tools/${t}/pkg`
const verify = (t: string, ...args: string[]) => `node tools/${t}/test/verify.mjs ${args.join(" ")}`
const pack = (t: string, src: string, ...args: string[]) =>
  `node tools/${t}/script/pack.mjs ${src} packages/${t}-wasm ${args.join(" ")}`.trim()

// Standard recipe: cargo test, wasm-pack build to tools/<t>/pkg, verify, pack.
const wasmPack = (
  t: string,
  opts: {
    rust: string
    test?: string | null
    buildEnv?: Record<string, string>
    verifyPkg?: string | null
    packArgs?: string[]
    verifyDist?: boolean
    pre?: Step[]
  },
): Recipe => ({
  rust: opts.rust,
  wasmPack: WASM_PACK,
  steps: [
    ...(opts.pre ?? []),
    ...(opts.test === null ? [] : [{ run: opts.test ?? `cargo test --locked --manifest-path tools/${t}/Cargo.toml`, env: { RUSTUP_TOOLCHAIN: opts.rust }, test: true }]),
    { run: `wasm-pack build tools/${t} --target web --release --out-dir pkg`, env: { RUSTUP_TOOLCHAIN: opts.rust, ...opts.buildEnv } },
    ...(opts.verifyPkg === null ? [] : [{ run: verify(t, ...(opts.verifyPkg ? [opts.verifyPkg] : [pkg(t)])) }]),
    { run: pack(t, pkg(t), ...(opts.packArgs ?? [])), pack: true },
    ...(opts.verifyDist ? [{ run: verify(t, `packages/${t}-wasm/dist`) }] : []),
  ],
})

const R194 = "1.94.0"
const R197 = "1.97.1"

const recipes: Record<string, Recipe> = {
  "apk-dex": wasmPack("apk-dex", { rust: R197 }),
  "binary-diff": wasmPack("binary-diff", { rust: R197, verifyPkg: null, verifyDist: true }),
  "binwalk-scan": {
    rust: R197,
    steps: [
      { run: "cargo test --manifest-path tools/binwalk-scan/Cargo.toml", env: { RUSTUP_TOOLCHAIN: R197 }, test: true },
      { run: "cargo build --manifest-path tools/binwalk-scan/Cargo.toml --target wasm32-unknown-unknown --release", env: { RUSTUP_TOOLCHAIN: R197 } },
      { run: pack("binwalk-scan", "tools/binwalk-scan/target/wasm32-unknown-unknown/release/turen_binwalk_scan_wasm.wasm"), pack: true },
      { run: verify("binwalk-scan", "packages/binwalk-scan-wasm/dist") },
    ],
  },
  "browser-artifacts": wasmPack("browser-artifacts", { rust: R197, verifyPkg: null, verifyDist: true }),
  "capa-match": {
    ...wasmPack("capa-match", { rust: R197, verifyPkg: null, verifyDist: true }),
    upstreams: [{ name: "goblin", repo: "https://github.com/m4b/goblin.git", commit: "cec6e6eba5bdcec78ec79edc80b3a1f44856039a" }],
    steps: [
      { run: "tools/capa-match/script/import-upstream.sh" },
      ...wasmPack("capa-match", { rust: R197, verifyPkg: null, verifyDist: true }).steps,
    ],
  },
  "code-signing": wasmPack("code-signing", { rust: R197, verifyPkg: null, verifyDist: true }),
  codec: wasmPack("codec", { rust: R197, verifyDist: true }),
  "crypto-markers": wasmPack("crypto-markers", { rust: R197, test: "cargo test --manifest-path tools/crypto-markers/Cargo.toml", verifyDist: true }),
  "debug-symbols": wasmPack("debug-symbols", {
    rust: R194,
    test: null,
    pre: [{ run: "cc -g -O0 -fno-omit-frame-pointer tools/debug-symbols/test/fixture.c -o tools/debug-symbols/test/fixture" }],
    verifyPkg: `${pkg("debug-symbols")} tools/debug-symbols/test/fixture`,
  }),
  "email-authenticate": wasmPack("email-authenticate", {
    rust: R194,
    test: "cargo test --locked --manifest-path tools/email-authenticate/Cargo.toml --lib && cargo check --locked --manifest-path tools/email-authenticate/Cargo.toml --target wasm32-unknown-unknown",
  }),
  "email-security": wasmPack("email-security", { rust: R197, test: null }),
  "firmware-formats": wasmPack("firmware-formats", { rust: R197, verifyDist: true }),
  "fuzzy-hash": wasmPack("fuzzy-hash", { rust: R197, packArgs: ["tools/fuzzy-hash/LICENSE"] }),
  "ghidra-decompiler": {
    emscripten: "6.0.8",
    steps: [
      { run: 'make -f Makefile.wasm -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)"', cwd: "tools/ghidra-decompiler" },
      { run: "npm test", cwd: "tools/ghidra-decompiler", test: true },
      { run: "node script/pack-forge.mjs", cwd: "tools/ghidra-decompiler", pack: true },
    ],
  },
  "git-inspect": wasmPack("git-inspect", { rust: R197, verifyPkg: null, verifyDist: true }),
  goblin: {
    ...wasmPack("goblin", { rust: R194, test: null, packArgs: ["upstream/goblin"] }),
    upstreams: [{ name: "goblin", repo: "https://github.com/m4b/goblin.git", commit: "cec6e6eba5bdcec78ec79edc80b3a1f44856039a" }],
  },
  "image-inspect": wasmPack("image-inspect", { rust: R197, test: "cargo test --manifest-path tools/image-inspect/Cargo.toml" }),
  "installer-inspect": wasmPack("installer-inspect", { rust: R197, test: "env DUMP_FIXTURES=1 cargo test --locked --manifest-path tools/installer-inspect/Cargo.toml", verifyDist: true }),
  "java-inspect": wasmPack("java-inspect", { rust: R197, test: "cargo test --manifest-path tools/java-inspect/Cargo.toml" }),
  "json-query": wasmPack("json-query", { rust: R197 }),
  libpcap: {
    emscripten: "6.0.8",
    upstreams: [{ name: "libpcap", repo: "https://github.com/the-tcpdump-group/libpcap.git", commit: "a999701dca5c873779281938baee6bc185a8d4dc" }],
    steps: [
      { run: "bash tools/libpcap/script/build.sh" },
      { run: verify("libpcap", "tools/libpcap/dist") },
      { run: pack("libpcap", "tools/libpcap/dist", "upstream/libpcap"), pack: true },
    ],
  },
  "macos-artifacts": wasmPack("macos-artifacts", { rust: R197, test: "cargo test --manifest-path tools/macos-artifacts/Cargo.toml", verifyPkg: null, verifyDist: true }),
  minidump: wasmPack("minidump", { rust: R197 }),
  monodis: {
    emscripten: "6.0.8",
    steps: [
      { run: "./script/import-upstream.sh", cwd: "tools/monodis" },
      { run: 'make -f Makefile.wasm -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)"', cwd: "tools/monodis" },
      { run: "npm test", cwd: "tools/monodis", test: true },
      { run: "node script/pack-forge.mjs", cwd: "tools/monodis", pack: true },
    ],
  },
  "pdf-inspect": wasmPack("pdf-inspect", { rust: R197, test: null }),
  "protocol-inspect": wasmPack("protocol-inspect", { rust: R194, test: null, packArgs: ["tools/protocol-inspect/LICENSE"] }),
  "rebuild-timeline": wasmPack("rebuild-timeline", { rust: R194, test: null, packArgs: ["tools/rebuild-timeline/LICENSE"] }),
  "rtf-inspect": wasmPack("rtf-inspect", { rust: R197, verifyPkg: null, verifyDist: true }),
  sourcemap: wasmPack("sourcemap", { rust: R197, verifyDist: true }),
  "sqlite-inspect": wasmPack("sqlite-inspect", { rust: R197, verifyPkg: null, verifyDist: true }),
  squashfs: wasmPack("squashfs", {
    rust: R197,
    pre: [{ run: "sh tools/squashfs/script/import-upstream.sh" }],
    test: "env DUMP_FIXTURES=1 cargo test --locked --manifest-path tools/squashfs/Cargo.toml",
    verifyDist: true,
  }),
  "static-analysis": wasmPack("static-analysis", {
    rust: R197,
    buildEnv: { RUSTFLAGS: "-C link-arg=--max-memory=268435456" },
    packArgs: ["tools/static-analysis/LICENSE"],
  }),
  "static-unpack": {
    rust: R194,
    wasmPack: WASM_PACK,
    emscripten: "6.0.8",
    upstreams: [
      { name: "upx", repo: "https://github.com/upx/upx.git", commit: "034b6d0d81c53998c07ad6f34bfead6f5c5445ce", submodules: true },
      { name: "retdec", repo: "https://github.com/avast/retdec.git", commit: "53e55b4b26e9b843787f0e06d867441e32b1604e" },
    ],
    steps: [
      {
        run: [
          "cmake -S upstream/upx -B tools/static-unpack/native-build -DUPX_CONFIG_CMAKE_DISABLE_TEST=ON -DUPX_CONFIG_CMAKE_DISABLE_INSTALL=ON -DUPX_CONFIG_DISABLE_GITREV=ON",
          "cmake --build tools/static-unpack/native-build --target upx -j2",
          "cc tools/static-unpack/test/fixture.c -o tools/static-unpack/test/fixture",
          "tools/static-unpack/native-build/upx --lzma -o tools/static-unpack/test/fixture.upx tools/static-unpack/test/fixture",
        ].join(" && "),
      },
      {
        run: "wasm-pack build tools/static-unpack/mpress --target web --release --out-dir pkg && node tools/static-unpack/test/verify-mpress.mjs tools/static-unpack/mpress/pkg",
        env: { RUSTUP_TOOLCHAIN: R194 },
      },
      { run: "bash tools/static-unpack/script/build-upx.sh && node tools/static-unpack/test/verify-upx.mjs tools/static-unpack/dist tools/static-unpack/test/fixture.upx tools/static-unpack/test/fixture" },
      { run: "node tools/static-unpack/script/pack.mjs tools/static-unpack/dist tools/static-unpack/mpress/pkg packages/static-unpack-wasm upstream/upx upstream/retdec", pack: true },
      { run: "node tools/static-unpack/test/verify-package.mjs packages/static-unpack-wasm/dist tools/static-unpack/test/fixture.upx tools/static-unpack/test/fixture" },
    ],
  },
  "stng-core": {
    ...wasmPack("stng-core", { rust: R194, test: null, packArgs: ["upstream/stng"] }),
    upstreams: [{ name: "stng", repo: "https://github.com/atomdrift-project/stng.git", commit: "5d3c939edb55c7dcf3d5be70cad0648953b80640" }],
  },
  "unicode-audit": wasmPack("unicode-audit", { rust: R197 }),
  "wasm-inspect": wasmPack("wasm-inspect", { rust: R194, test: null }),
  "wasm-toolkit": wasmPack("wasm-toolkit", { rust: R197 }),
  "wifi-offline": wasmPack("wifi-offline", { rust: R194, test: null, packArgs: ["tools/wifi-offline/LICENSE"] }),
  "windows-artifacts": wasmPack("windows-artifacts", { rust: R194, test: null, packArgs: ["tools/windows-artifacts/LICENSE"] }),
  "yara-x": {
    rust: R194,
    wasmPack: WASM_PACK,
    upstreams: [{ name: "yara-x", repo: "https://github.com/VirusTotal/yara-x.git", commit: "fe40349ea12c5ccb89aae9f304b979c4fb410f66" }],
    steps: [
      { run: `git -C upstream/yara-x apply "${root}/tools/yara-x/patches/bounded-results.patch"` },
      { run: "npm --prefix upstream/yara-x/js-wasm run build:web", env: { RUSTUP_TOOLCHAIN: R194 } },
      { run: verify("yara-x", "upstream/yara-x/js-wasm/pkg") },
      { run: pack("yara-x", "upstream/yara-x/js-wasm/pkg"), pack: true },
    ],
  },
}

const args = process.argv.slice(2)
const noTest = args.includes("--no-test")
const packOnly = args.includes("--pack-only")
const targets = args.filter((a) => !a.startsWith("--"))
const selected = args.includes("--all") ? Object.keys(recipes) : targets

if (args.includes("--list") || selected.length === 0) {
  console.log(Object.keys(recipes).join("\n"))
  process.exit(selected.length === 0 && !args.includes("--list") ? 1 : 0)
}

const unknown = selected.filter((t) => !recipes[t])
if (unknown.length) {
  console.error(`unknown target(s): ${unknown.join(", ")}`)
  process.exit(1)
}

for (const target of selected) {
  const recipe = recipes[target]!
  console.log(`\n=== ${target} ===`)
  if (!packOnly) {
    for (const upstream of recipe.upstreams ?? []) ensureUpstream(upstream)
    if (recipe.rust) run(`rustup toolchain install ${recipe.rust} --target wasm32-unknown-unknown --profile minimal`)
    if (recipe.wasmPack) ensureWasmPack(recipe.rust!, recipe.wasmPack)
    if (recipe.emscripten && !commandExists("emcc"))
      throw new Error(`${target} requires Emscripten ${recipe.emscripten} on PATH (CI uses mymindstorm/setup-emsdk)`)
  }
  for (const step of recipe.steps) {
    if (packOnly && !step.pack) continue
    if (noTest && step.test) continue
    run(step.run, step.cwd, step.env)
  }
  await verifyChecksums(target)
}

function run(cmd: string, cwd?: string, env?: Record<string, string>) {
  console.log(`$ ${cmd}`)
  const result = Bun.spawnSync(["sh", "-c", cmd], {
    cwd: cwd ? path.join(root, cwd) : root,
    env: { ...process.env, ...env },
    stdio: ["inherit", "inherit", "inherit"],
  })
  if (result.exitCode !== 0) throw new Error(`command failed (${result.exitCode}): ${cmd}`)
}

function commandExists(cmd: string) {
  return Bun.spawnSync(["sh", "-c", `command -v ${cmd}`]).exitCode === 0
}

function ensureWasmPack(rust: string, version: string) {
  const out = Bun.spawnSync(["wasm-pack", "--version"]).stdout.toString()
  if (out.includes(version)) return
  run(`cargo +${rust} install --locked wasm-pack --version ${version}`)
}

function ensureUpstream({ name, repo, commit, submodules }: NonNullable<Recipe["upstreams"]>[number]) {
  const dir = path.join(root, "upstream", name)
  if (existsSync(path.join(dir, ".git"))) return
  run(`git init -q ${dir} && git -C ${dir} remote add origin ${repo} && git -C ${dir} fetch -q --depth 1 origin ${commit} && git -C ${dir} checkout -q ${commit}`)
  if (submodules) run(`git -C ${dir} submodule update --init --recursive --depth 1`)
}

async function verifyChecksums(target: string) {
  const dir = pkgDir(target)
  const manifests = (await readdir(dir)).filter((f) => f.startsWith("SHA256SUMS"))
  for (const manifest of manifests) run(`shasum -a 256 -c ${manifest}`, path.relative(root, dir))
  if (!manifests.length) console.log(`no SHA256SUMS manifest in packages/${target}-wasm`)
}
