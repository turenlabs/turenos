# Rosetta execution

`rosetta_exec` is an experimental built-in tool for Apple Silicon macOS. It
runs one little-endian x86-64 Linux ELF through a TurenOS-owned
Virtualization.framework harness and Apple's Rosetta Linux share.
It is registered as a deferred tool, so a model sees its schema only after
selecting it with `tool_search` and `tool_load`.

The runtime does not depend on Docker, Colima, Lima, Tart, QEMU, SSH, a guest
disk, a package manager, or a network device. The helper boots a diskless ARM64
Linux kernel with a BusyBox initramfs, exposes only a temporary read-only input
directory and the Rosetta share, and registers the x86-64 ELF handler. The guest
reports the program's output and exit status over a second virtio console
(`/dev/hvc1`), and the helper prints a JSON envelope on stdout.

If Rosetta is not yet installed on the host, the helper calls
`VZLinuxRosettaDirectoryShare.installRosetta()`, which installs Apple's Rosetta
on the Mac as a side effect of the first run.

## Setup

Build the host helper:

```sh
swift build --package-path packages/rosetta-harness -c release
codesign --force --sign - --entitlements packages/rosetta-harness/Resources/entitlements.plist packages/rosetta-harness/.build/release/turen-rosetta-harness
```

The execution pack is built separately. Build a local pack from an ARM64 kernel, a BusyBox binary, and matching
modules that you supply:

```sh
packages/rosetta-harness/Scripts/build-pack.sh \
  Image busybox virtiofs.ko binfmt_misc.ko dist/rosetta-pack
```

The script builds and ad-hoc signs the helper too, and writes `kernel`, `initrd.gz`, `turen-rosetta-harness`, and a
`SHA256SUMS` file covering all three into the output directory. The scripts copy whichever inputs they are given;
nothing pins or verifies the kernel or BusyBox versions, and `SHA256SUMS` records only the resulting pack.

Install the execution pack by setting these host-only variables before starting
TurenOS:

```text
TUREN_ROSETTA_HARNESS=/path/to/dist/rosetta-pack/turen-rosetta-harness
TUREN_ROSETTA_KERNEL=/path/to/dist/rosetta-pack/kernel
TUREN_ROSETTA_INITRD=/path/to/dist/rosetta-pack/initrd.gz
```

These `TUREN_*` names are the harness contract. Unlike most TurenOS environment variables they don't use the `FORGE_`
prefix; the tool that reads them is `packages/core/src/tool/rosetta-exec.ts`.

The agent cannot select or change these paths. If any of the three variables
is unset, the tool returns an unavailable error instead of falling back to
Docker or a host shell. If they point at a missing or broken pack, the run
fails with `Unable to run <path> through TurenOS's Rosetta harness`.

To exercise the helper outside TurenOS:

```sh
turen-rosetta-harness --kernel kernel --initrd initrd.gz --executable static-x86_64-elf
```

## Verification

The validation fixture is an x86-64 static ELF. The live tool test in
`packages/core/test/tool-rosetta-exec.test.ts` runs only when
`TUREN_ROSETTA_TEST_ELF` names such a file; without it the test logs a warning
and passes. With it, the test exercises Apple Virtualization.framework, two
virtio console channels, virtiofs, `binfmt_misc`, Rosetta translation, guest
exit status, and host-side cleanup.

## Limits

- The harness is single-process and text-output only. It passes no guest
  arguments and has no network or writable mounts. Adding writable shares,
  networking, guest arguments, dynamic package install, or persistent guest
  state needs a separate security review.
- Dynamically linked executables are not rejected up front, but they fail
  because the guest has no dynamic loader or libraries.
- The tool timeout defaults to 30 seconds and is capped at 120 seconds; the
  helper process gets 5 more seconds before it is killed. Output is capped at
  1 MiB.
- The VM has 1 CPU and 512 MiB of memory. The helper's `--memory` option
  accepts 256 to 1024 MiB; the tool does not pass it.

## Source

- [`packages/core/src/tool/rosetta-exec.ts`](../../packages/core/src/tool/rosetta-exec.ts)
- [`packages/rosetta-harness`](../../packages/rosetta-harness)
- Tests: [`packages/core/test/tool-rosetta-exec.test.ts`](../../packages/core/test/tool-rosetta-exec.test.ts)
