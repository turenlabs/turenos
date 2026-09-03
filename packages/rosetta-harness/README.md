# TurenOS Rosetta Harness

Minimal first-party Apple Silicon execution harness. It launches a diskless
ARM64 Linux guest with Virtualization.framework, attaches Apple's Rosetta
directory share and one temporary read-only input directory, runs one static
x86-64 ELF, prints its output and exit marker through virtio console, and
stops.

Runtime dependencies are limited to the signed harness, an ARM64 Linux kernel,
and a BusyBox initramfs. There is no Docker, Colima, Lima, Tart, QEMU, SSH,
guest disk, package manager, or network device.

The execution pack is built separately and must provide:

```text
kernel
initrd
```

Build the host helper:

```sh
swift build --package-path packages/rosetta-harness -c release
codesign --force --sign - --entitlements packages/rosetta-harness/Resources/entitlements.plist packages/rosetta-harness/.build/release/turen-rosetta-harness
```

Build the complete local execution pack from a pinned ARM64 Linux kernel and
matching kernel modules:

```sh
Scripts/build-pack.sh Image busybox virtiofs.ko binfmt_misc.ko dist/rosetta-pack
```

Set these environment variables for TurenOS. The `TUREN_*` names are the
first-class harness contract even though the host runtime still lives under
the compatibility-oriented `packages/forge` path:

```text
TUREN_ROSETTA_HARNESS=.../dist/rosetta-pack/turen-rosetta-harness
TUREN_ROSETTA_KERNEL=.../dist/rosetta-pack/kernel
TUREN_ROSETTA_INITRD=.../dist/rosetta-pack/initrd.gz
```

Run the helper directly:

```sh
turen-rosetta-harness --kernel kernel --initrd initrd --executable static-x86_64-elf
```

This initial harness intentionally accepts no arguments, network, writable
mounts, or dynamically linked executables.
