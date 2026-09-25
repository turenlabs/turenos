# Providers

Model providers and external agent CLIs that TurenOS drives. Each page covers setup, how tools route through TurenOS
policy, and limits. Provider resolution internals belong to the "Model and provider layer" row of the
[systems catalog](../systems/README.md), and the normative contract is
[`specs/v2/provider-model.md`](../../specs/v2/provider-model.md).

- [Claude Code](./claude-code/README.md): driving a local Claude Code subscription session.
  - [Tool routing](./claude-code/tool-routing.md): routing `claude -p` tools through TurenOS policy and settlement
    boundaries.
- [Muse Code](./muse-code.md): using the signed-in local Muse CLI with host-routed tools.
- [Local models](./local-models.md): running Bonsai 2 with its supported local runtime and connecting the loopback API.
