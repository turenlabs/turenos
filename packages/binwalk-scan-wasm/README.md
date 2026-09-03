# Binwalk Scan

This package performs bounded, scan-only firmware and embedded-format
identification inspired by the Binwalk v3 signature catalog. The scanner is an
original Turen implementation and does not compile or expose the upstream
Binwalk application.

The package exposes `binwalk_scan(bytes, options_json) -> JSON` through a handwritten ESM loader over a dependency-free raw WebAssembly ABI. Input is capped
at 32 MiB, options at 1 KiB, findings default to 256 and are capped at 4,096, candidate
validations are capped at 1,000,000, and JSON output is capped at 4 MiB.

The target has no filesystem, network, subprocess, extraction, decompression,
recursion, or analyzed-code execution capability. Stream findings report an
unknown size rather than decompressing input to discover one.

The reviewed signature set covers SquashFS, JFFS2, UBI, CramFS, U-Boot uImage,
flattened device trees, Android boot images, Broadcom TRX, ROMFS, CPIO newc,
gzip, XZ, Zstandard, bzip2, and LZ4 frames.
