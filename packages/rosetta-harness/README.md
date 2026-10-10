# TurenOS Rosetta Harness

Minimal first-party Apple Silicon execution harness behind the experimental `rosetta_exec` tool. It launches a diskless
ARM64 Linux guest with Virtualization.framework, runs one static x86-64 ELF through Apple's Rosetta share, prints its
output and exit marker through the virtio console, and stops.

Building the helper and execution pack, configuring TurenOS, and the harness's limits are documented in
[Rosetta execution](../../docs/systems/rosetta-exec.md).
