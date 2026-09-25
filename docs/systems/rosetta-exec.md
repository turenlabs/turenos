# Rosetta execution

`rosetta_exec` is an experimental built-in tool for Apple Silicon macOS. It
runs one little-endian x86-64 Linux ELF through a TurenOS-owned
Virtualization.framework harness and Apple's Rosetta Linux share.

The runtime does not depend on Docker, Colima, Lima, Tart, QEMU, SSH, a guest
disk, a package manager, or a network device. The helper boots a diskless ARM64
Linux kernel with a pinned BusyBox initramfs, exposes only a temporary read-only
input directory and the Rosetta share, registers the x86-64 ELF handler, and
returns a JSON envelope over the virtio console.

Install the execution pack by setting these host-only variables before starting
TurenOS:

```text
TUREN_ROSETTA_HARNESS=/path/to/turen-rosetta-harness
TUREN_ROSETTA_KERNEL=/path/to/arm64/Image
TUREN_ROSETTA_INITRD=/path/to/turen-rosetta-initrd.gz
```

The agent cannot select or change these paths. If the pack is not installed,
the tool returns an unavailable error instead of falling back to Docker or a
host shell.

Build a local pack from a pinned ARM64 kernel and matching modules:

```sh
packages/rosetta-harness/Scripts/build-pack.sh \
  Image busybox virtiofs.ko binfmt_misc.ko dist/rosetta-pack
```

The current validation fixture is an x86-64 static ELF. The direct helper and
TurenOS tool tests prove the full path, including Apple Virtualization.framework,
two virtio console channels, virtiofs, `binfmt_misc`, Rosetta translation,
guest exit status, and host-side cleanup.

The initial harness is deliberately single-process and text-output only. Do
not add writable shares, networking, guest arguments, dynamic package install,
or persistent guest state without a separate security review.

## Source

- [`packages/core/src/tool/rosetta-exec.ts`](../../packages/core/src/tool/rosetta-exec.ts)
- [`packages/rosetta-harness`](../../packages/rosetta-harness)
