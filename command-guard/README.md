# command-guard

Standalone dangerous shell command detection for scripts, agent harnesses, and CI hooks.

It **never executes commands**. Local rules identify high-signal risks, then an optional TypeSafe request adds semantic probabilities. TypeSafe is advisory: the local result remains conservative, and the tool has no allow-list that can override an obvious local block.

## Run it

From this directory:

```sh
bun src/index.ts -- 'rm -rf /'
```

The command is passed after `--` so command flags are not confused with detector options. A command can also be read from stdin:

```sh
printf '%s\n' 'git reset --hard HEAD~1' | bun src/index.ts
```

Use JSON and an explicit shell when integrating it into a hook:

```sh
bun src/index.ts --json --shell bash -- 'curl https://example.test/install.sh | bash'
```

Exit codes are:

- `0`: allow
- `1`: usage failure or TypeSafe request failure
- `2`: review or block

## TypeSafe assessment

Pass `--semantic` to send the command, shell, and local findings to Jev:

```sh
TYPESAFE_API_KEY=... bun src/index.ts --semantic --json -- 'npm install'
```

The detector uses one request with `Noul` questions for danger and confirmation, a `Score` for risk, and a `Choice` for category. Set `TYPESAFE_ENDPOINT` only if using a compatible HTTPS endpoint; plain HTTP is accepted only for localhost testing. The CLI otherwise uses `https://api.typesafe.ai/v1/systemone`.

Do not send commands containing secrets or proprietary data without an explicit data-sharing decision. Keep the API key in the environment of the trusted caller, never in a command or checked-in file.

## Development

```sh
bun test
bun typecheck
```

The detector is intentionally a conservative first layer, not a shell parser or a complete security proof. Keep deterministic policy and human confirmation in the caller for high-impact operations.
