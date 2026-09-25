# Operations

Procedures for running and shipping TurenOS: where the backend runs and how releases are cut. Contributor workflows
(building, testing, linting) live in [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

- [SSH remote servers](./ssh-remote/README.md): driving the system `ssh` client to install, supervise, and tunnel a remote
  TurenOS backend from Desktop.
- [WSL backends](./wsl.md): installing `forge` into a WSL distro and running the Desktop's backend there on Windows.
- [Releases](./releases/README.md): the operator checklist for cutting a release (version bump, dispatch,
  verification, and recovery).
  - [Automated releases](./releases/automation.md): one-dispatch private builds, verified public publication, Homebrew
    updates, credentials, and recovery without rebuilding.
  - [Release signing](./releases/signing.md): native platform signatures, certificate handoff, and detached release
    verification.
