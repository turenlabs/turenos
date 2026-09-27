#!/usr/bin/env bun
/**
 * End-to-end harness for `forge persistent` on a real Linux systemd host, driven over ssh.
 *
 *   bun script/persistent-e2e.ts --host user@linux-host [--bin dist/forge-linux-x64-baseline/bin]
 *   bun script/persistent-e2e.ts --host user@linux-host --restore
 *
 * The host needs passwordless sudo and must be disposable for testing: the harness owns the
 * fixed persistent-server paths (turenos.service, /etc/credstore*, /etc/turenos/attach.json) while it
 * runs. It moves whatever is installed there into /root/turenos-e2e-backup first and puts it back
 * afterwards; if a run dies before that, `--restore` finishes the job. It never touches the
 * previously installed data root.
 */
import path from "node:path"
import { parseArgs } from "node:util"

const args = parseArgs({
  options: {
    host: { type: "string" },
    bin: { type: "string", default: path.resolve(import.meta.dir, "../dist/forge-linux-x64-baseline/bin") },
    only: { type: "string" },
    // Use a forge already installed on the host (root-owned, in root-only directories) instead of uploading.
    "remote-bin": { type: "string" },
    restore: { type: "boolean", default: false },
  },
}).values
if (!args.host) throw new Error("--host user@linux-host is required")
const host = args.host

const E2E = {
  user: "turenos-e2e",
  bin: "/opt/turenos-e2e/bin",
  dataRoot: "/var/lib/turenos-e2e-server",
  work: "/root/turenos-e2e",
  backup: "/root/turenos-e2e-backup",
  lock: "/root/turenos-e2e.lock",
  quick: "/tmp/turenos-e2e-quick",
  unit: "/etc/systemd/system/turenos.service",
  attach: "/etc/turenos/attach.json",
  port: 4097,
  quickPort: 4190,
}
const forge = args["remote-bin"] ?? `${E2E.bin}/forge`
const database = `${E2E.dataRoot}/data/forge/forge.db`
const owned = [
  E2E.unit,
  E2E.attach,
  "/etc/credstore/forge-secret-vault-key-id",
  "/etc/credstore.encrypted/forge-secret-vault-key",
  "/etc/credstore.encrypted/forge-server-password",
]

const shq = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

const ssh = ["-o", "BatchMode=yes", "-o", "ControlPath=/tmp/turenos-e2e-%C"]
// One detached master for the run. Letting the first command become the master would leave its
// output pipes held open by the backgrounded connection, so that command would never finish.
const running = Bun.spawn(["ssh", ...ssh, "-O", "check", host], { stdio: ["ignore", "ignore", "ignore"] })
if ((await running.exited) !== 0) {
  const master = Bun.spawn(["ssh", ...ssh, "-o", "ControlMaster=yes", "-o", "ControlPersist=600", "-fN", host], {
    stdio: ["ignore", "ignore", "inherit"],
  })
  if ((await master.exited) !== 0) throw new Error(`could not connect to ${host}`)
}

type Result = { code: number; stdout: string; stderr: string; output: string }

async function remote(script: string, options: { root?: boolean; input?: string } = {}): Promise<Result> {
  const command = options.root === false ? `bash -c ${shq(script)}` : `sudo -n bash -c ${shq(script)}`
  if (process.env.E2E_VERBOSE) console.log(`  $ ${script.split("\n")[0]!.slice(0, 160)}`)
  const child = Bun.spawn(["ssh", ...ssh, "-o", "ControlMaster=no", host, command], {
    stdin: options.input === undefined ? "ignore" : new TextEncoder().encode(options.input),
    stdout: "pipe",
    stderr: "pipe",
    // A hung remote command fails its scenario instead of stalling the run.
    timeout: 180_000,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr, output: `${stdout}\n${stderr}` }
}

async function ok(script: string, options?: { root?: boolean; input?: string }) {
  const result = await remote(script, options)
  if (result.code !== 0) throw new Error(`remote command failed (${result.code}): ${script}\n${result.output.trim()}`)
  return result.stdout.trim()
}

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function refused(result: Result, text: string) {
  expect(result.code !== 0, `expected a refusal containing "${text}", but the command succeeded:\n${result.output}`)
  expect(result.output.includes(text), `expected output to contain "${text}":\n${result.output.trim()}`)
}

// ---------------------------------------------------------------------------------------------
// Host state

async function upload() {
  const local = `/tmp/turenos-e2e-${process.pid}.tgz`
  // tar writes the archive itself; streaming 120 MB through Bun.write stalled indefinitely.
  const tar = Bun.spawn(["tar", "czf", local, "-C", args.bin!, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  })
  if ((await tar.exited) !== 0) throw new Error(`could not archive ${args.bin}`)
  const scp = Bun.spawn(["scp", "-q", "-o", "ControlPath=/tmp/turenos-e2e-%C", local, `${host}:/tmp/turenos-e2e.tgz`])
  const copied = await scp.exited
  await Bun.file(local).delete()
  if (copied !== 0) throw new Error("scp failed")
  await ok(
    `rm -rf ${E2E.bin}.new && mkdir -p ${E2E.bin}.new && tar xzf /tmp/turenos-e2e.tgz -C ${E2E.bin}.new && rm /tmp/turenos-e2e.tgz ` +
      `&& chown -R root:root ${E2E.bin}.new && chmod -R go-w ${E2E.bin}.new && rm -rf ${E2E.bin} && mv ${E2E.bin}.new ${E2E.bin} ` +
      `&& chmod 755 /opt/turenos-e2e && test -x ${forge}`,
  )
}

// The backup is a copy, and it stays untouched until a restore has completed: the live files are
// only removed once every copy exists (by the first reset), and a restore that dies partway can be
// re-run against the same backup. `complete` marks a backup whose copies all finished.
async function backup() {
  await ok(
    [
      "set -e",
      `if [ -e ${E2E.backup} ]; then echo "${E2E.backup} exists from an earlier run that did not restore; run with --restore first" >&2; exit 1; fi`,
      `mkdir -m 700 ${E2E.backup}`,
      `systemctl is-active --quiet turenos.service && touch ${E2E.backup}/was-active || true`,
      `systemctl is-enabled --quiet turenos.service && touch ${E2E.backup}/was-enabled || true`,
      ...owned.map(
        (file) =>
          `if [ -e ${file} ]; then mkdir -p ${E2E.backup}${path.dirname(file)} && cp -a ${file} ${E2E.backup}${file}; fi`,
      ),
      `touch ${E2E.backup}/complete`,
      `id -u ${E2E.user} >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ${E2E.user}`,
    ].join("\n"),
  )
}

async function reset() {
  await ok(
    [
      `systemctl disable --now turenos.service 2>/dev/null || true`,
      `systemctl reset-failed turenos.service 2>/dev/null || true`,
      ...owned.map((file) => `rm -f ${file}`),
      `if [ -f /etc/turenos ]; then rm -f /etc/turenos; fi`,
      // So each install creates it, and its mode is what install set rather than what an earlier run left.
      `rmdir /etc/turenos 2>/dev/null || true`,
      `systemctl daemon-reload`,
      `rm -rf ${E2E.dataRoot} ${E2E.work} /tmp/turenos-e2e-target`,
      `mkdir -m 700 ${E2E.work}`,
    ].join("\n"),
  )
  await remote(`if [ -f ${E2E.quick}/pid ]; then kill $(cat ${E2E.quick}/pid) 2>/dev/null; fi; rm -rf ${E2E.quick}`, {
    root: false,
  })
}

async function restore() {
  // Checked before reset, which deletes the service files: without a backup there is nothing to put back.
  if ((await remote(`test -d ${E2E.backup}`)).code !== 0)
    throw new Error(`${E2E.backup} is missing; refusing to reset the host's service files`)
  // A backup that never completed means the live files were never removed; only the partial copies go.
  if ((await remote(`test -e ${E2E.backup}/complete`)).code !== 0) {
    await ok(`rm -rf ${E2E.backup} ${E2E.work}`)
    return
  }
  await reset()
  // Copies, so a restore that fails (including the service start) can run again from the same backup,
  // which is deleted only once everything is back.
  await ok(
    [
      "set -e",
      `test -e ${E2E.backup}/complete`,
      ...owned.map(
        (file) =>
          `if [ -e ${E2E.backup}${file} ]; then mkdir -p ${path.dirname(file)} && cp -a ${E2E.backup}${file} ${file}; fi`,
      ),
      `systemctl daemon-reload`,
      `if [ -e ${E2E.backup}/was-enabled ]; then systemctl enable turenos.service; fi`,
      `if [ -e ${E2E.backup}/was-active ]; then systemctl start turenos.service; fi`,
      `rm -rf ${E2E.backup} ${E2E.work}`,
    ].join("\n"),
  )
}

// One run per host. Two runs, or a run and a --restore, delete each other's backup and restored files.
// The lock outlives a run that dies, so the next run is refused until --restore finishes that run's cleanup.
const lockHolder = `${(await Bun.$`hostname`.text()).trim()} ${process.pid}`

async function lock(options: { takeOver?: boolean } = {}) {
  const held = await remote(`cat ${E2E.lock} 2>/dev/null`)
  const holder = held.stdout.trim()
  if (holder && !options.takeOver) throw new Error(`${host} is locked by another harness run (${holder})`)
  if (holder && options.takeOver) {
    const [machine, pid] = holder.split(" ")
    if (machine === lockHolder.split(" ")[0] && pid && isAlive(Number(pid)))
      throw new Error(`harness run ${holder} is still running; let it finish or stop it first`)
    await ok(`rm -f ${E2E.lock}`)
  }
  await ok(`set -o noclobber; printf '%s\\n' ${shq(lockHolder)} > ${E2E.lock}`)
}

async function unlock() {
  await ok(`if [ "$(cat ${E2E.lock} 2>/dev/null)" = ${shq(lockHolder)} ]; then rm -f ${E2E.lock}; fi`)
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers over the installed service

const install = (extra: string, input?: string) =>
  remote(
    // The strictest root umask, so nothing install creates depends on a permissive default.
    `umask 077; ${forge} persistent install --user ${E2E.user} --data-root ${E2E.dataRoot} --forge-bin ${forge} ${extra} 2>&1`,
    { input },
  )

async function attachRecord() {
  return JSON.parse(await ok(`cat ${E2E.attach}`)) as {
    serverID: string
    url: string
    username: string
    password: string
  }
}

async function request(route: string, init: { method?: string; body?: unknown; auth?: boolean } = {}) {
  const record = await attachRecord()
  const auth = init.auth === false ? "" : `-u ${shq(`${record.username}:${record.password}`)}`
  const body =
    init.body === undefined ? "" : `-H 'content-type: application/json' --data ${shq(JSON.stringify(init.body))}`
  const out = await ok(
    `curl -s --max-time 5 -o /tmp/turenos-e2e-body -w '%{http_code}' -X ${init.method ?? "GET"} ${auth} ${body} ${record.url}${route}; echo; cat /tmp/turenos-e2e-body`,
  )
  const [status, ...rest] = out.split("\n")
  return { status: Number(status), body: rest.join("\n") }
}

async function descriptor() {
  const response = await request("/global/server")
  expect(response.status === 200, `/global/server returned ${response.status}: ${response.body}`)
  return JSON.parse(response.body) as { serverID: string; keyID: string; mode: string; keySource: string }
}

async function waitHealthy() {
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await remote(`systemctl is-active --quiet turenos.service`)).code === 0) {
      const response = await request("/global/server").catch(() => undefined)
      if (response?.status === 200) return
    }
    await Bun.sleep(1000)
  }
  throw new Error(`service did not become healthy:\n${await ok("journalctl -u turenos -n 20 --no-pager -o cat")}`)
}

const recoveryFile = `${E2E.work}/recovery.key`

async function freshInstall() {
  const result = await install(`--apply --recovery-file ${recoveryFile}`)
  expect(result.code === 0, `fresh install failed:\n${result.output}`)
  expect(result.stdout.includes("is running with key"), `install did not report a running server:\n${result.stdout}`)
}

async function mode(file: string) {
  return ok(`stat -c '%a %U:%G' ${file}`)
}

// ---------------------------------------------------------------------------------------------
// Scenarios

const scenarios: Array<[string, () => Promise<void>]> = [
  [
    "fresh install protects its key and password",
    async () => {
      const preflight = await remote(
        `${forge} persistent preflight --user ${E2E.user} --data-root ${E2E.dataRoot} --forge-bin ${forge} 2>&1`,
      )
      expect(preflight.code === 0, `preflight failed on a clean host:\n${preflight.output}`)

      refused(await install("--apply"), "needs --recovery-file")
      expect((await remote(`test -e ${E2E.unit}`)).code !== 0, "a refused install wrote the unit")

      await freshInstall()
      const [keyID, key] = (await ok(`cat ${recoveryFile}`)).split("\n")
      const record = await attachRecord()
      const server = await descriptor()
      expect(server.mode === "persistent", `mode is ${server.mode}`)
      expect(server.serverID === record.serverID, `descriptor ${server.serverID} != attach ${record.serverID}`)
      expect(server.keyID === keyID, `descriptor key ${server.keyID} != recovery ${keyID}`)
      expect(server.keySource === "systemd-credentials", `keySource is ${server.keySource}`)

      expect((await mode(recoveryFile)) === "400 root:root", `recovery file is ${await mode(recoveryFile)}`)
      expect((await mode(E2E.attach)) === "640 root:turenos-operators", `attach record is ${await mode(E2E.attach)}`)
      expect((await mode("/etc/turenos")) === "755 root:root", `/etc/turenos is ${await mode("/etc/turenos")}`)
      for (const name of ["forge-secret-vault-key", "forge-server-password"])
        expect((await mode(`/etc/credstore.encrypted/${name}`)).startsWith("600 root"), `${name} is not 0600 root`)
      expect((await mode(E2E.dataRoot)).endsWith(`${E2E.user}:${E2E.user}`), "data root is not owned by the service")

      expect((await request("/global/server", { auth: false })).status === 401, "descriptor answered without auth")

      // Neither secret may appear where other local users or logs can see it.
      const pid = await ok(`systemctl show -p MainPID --value turenos.service`)
      const exposed = await ok(
        `cat ${E2E.unit}; systemctl show turenos.service; tr '\\0' '\\n' < /proc/${pid}/environ; ` +
          `tr '\\0' ' ' < /proc/${pid}/cmdline; journalctl -u turenos --no-pager -o cat`,
      )
      for (const [label, secret] of [
        ["vault key", key!],
        ["HTTP password", record.password],
      ])
        expect(!exposed.includes(secret), `the ${label} appears in the unit, environment, argv, or journal`)
    },
  ],
  [
    "secrets survive a restart and a re-run keeps the same server, key, and password",
    async () => {
      await freshInstall()
      const before = await descriptor()
      const password = (await attachRecord()).password
      const stored = await request("/auth/e2e-provider", { method: "PUT", body: { type: "api", key: "sk-e2e-secret" } })
      expect(stored.status === 200, `storing a provider key failed: ${stored.status} ${stored.body}`)

      await ok(`systemctl restart turenos.service`)
      await waitHealthy()
      const rerun = await remote(`${forge} persistent install --apply 2>&1`)
      expect(rerun.code === 0, `re-run failed:\n${rerun.output}`)
      const after = await descriptor()
      expect(after.serverID === before.serverID && after.keyID === before.keyID, "re-run changed the server or key")
      expect((await attachRecord()).password === password, "re-run changed the HTTP password")

      const key = await ok(`cat ${recoveryFile}`)
      const report = JSON.parse(
        (await ok(`${forge} persistent verify-key --db ${database}`, { input: `${key}\n` })).split("\n")[0]!,
      ) as { stores: Array<{ store: string; sealed: number; opened: boolean }>; verification: string }
      expect(report.verification === "valid", `sentinel verification is ${report.verification}`)
      expect(
        report.stores.some((store) => store.store === "storage" && store.sealed > 0 && store.opened),
        `the stored provider key is not sealed and readable: ${JSON.stringify(report.stores)}`,
      )
    },
  ],
  [
    "a second server cannot open the persistent database",
    async () => {
      await freshInstall()
      const key = (await ok(`cat ${recoveryFile}`)).split("\n")
      const result = await remote(
        `cd /tmp && timeout 20 sudo -n -u ${E2E.user} env -i PATH=/usr/bin:/bin HOME=/tmp FORGE_DB=${database} ` +
          `XDG_DATA_HOME=/tmp/turenos-e2e-second sh -c ` +
          shq(
            `IFS= read -r FORGE_SECRET_VAULT_KEY_ID; IFS= read -r FORGE_SECRET_VAULT_KEY; ` +
              `export FORGE_SECRET_VAULT_KEY_ID FORGE_SECRET_VAULT_KEY; ` +
              `exec ${forge} serve --hostname 127.0.0.1 --port 4191`,
          ) +
          ` 2>&1; code=$?; rm -rf /tmp/turenos-e2e-second; exit $code`,
        { input: `${key[0]}\n${key[1]}\n` },
      )
      expect(
        result.code !== 0 && result.code !== 124,
        `a second server started or hung (${result.code}):\n${result.output}`,
      )
      expect(/already owned|owned by/i.test(result.output), `unexpected refusal:\n${result.output}`)
      await waitHealthy()
    },
  ],
  [
    "an existing recovery file is never replaced",
    async () => {
      await ok(`printf 'old-key-id\\nold-key\\n' > ${recoveryFile} && chmod 400 ${recoveryFile}`)
      refused(await install(`--apply --recovery-file ${recoveryFile}`), "already exists")
      expect((await ok(`cat ${recoveryFile}`)) === "old-key-id\nold-key", "the old recovery copy was changed")
      expect((await remote(`test -e ${E2E.unit}`)).code !== 0, "a refused install wrote the unit")
    },
  ],
  [
    "verify-key accepts the right key and refuses another",
    async () => {
      await freshInstall()
      const key = await ok(`cat ${recoveryFile}`)
      expect(
        (await remote(`${forge} persistent verify-key --db ${database}`, { input: `${key}\n` })).code === 0,
        "right key refused",
      )
      const other = `${key.split("\n")[0]}\n${Buffer.alloc(32, 5).toString("base64")}\n`
      refused(await remote(`${forge} persistent verify-key --db ${database} 2>&1`, { input: other }), "cannot open")
    },
  ],
  [
    "a rollback journal planted by the service account is refused and the service keeps running",
    async () => {
      await freshInstall()
      await ok(`install -m 600 /dev/null /tmp/turenos-e2e-target`)
      await ok(`sudo -u ${E2E.user} ln -s /tmp/turenos-e2e-target ${database}-journal`)
      refused(await remote(`${forge} persistent install --apply 2>&1`), "forge.db-journal is not a regular file")
      expect((await mode("/tmp/turenos-e2e-target")) === "600 root:root", "the link target changed ownership")
      await waitHealthy()
      await ok(`rm -f ${database}-journal`)
    },
  ],
  [
    "a setup that died while it held the data root is finished by the next run",
    async () => {
      await freshInstall()
      const before = await descriptor()
      // What an interrupted claim leaves behind: the service stopped, the root and its managed
      // directories root-owned 0700, so the service account cannot even traverse them.
      await ok(
        `systemctl stop turenos.service && chown root:root ${E2E.dataRoot} ${E2E.dataRoot}/data ${E2E.dataRoot}/data/forge && chmod 700 ${E2E.dataRoot} ${E2E.dataRoot}/data`,
      )
      const preflight = await remote(`${forge} persistent preflight 2>&1`)
      expect(preflight.code === 0, `preflight refused the interrupted data root:\n${preflight.output}`)
      expect(preflight.stdout.includes("interrupted setup"), `preflight did not explain the root-owned data root`)
      const rerun = await remote(`${forge} persistent install --apply 2>&1`)
      expect(rerun.code === 0, `re-run over the interrupted data root failed:\n${rerun.output}`)
      expect((await mode(E2E.dataRoot)).endsWith(`${E2E.user}:${E2E.user}`), "the data root was not handed back")
      expect((await mode(database)).startsWith(`600 ${E2E.user}:`), `the database is ${await mode(database)}`)
      expect((await descriptor()).serverID === before.serverID, "the re-run changed the server")
    },
  ],
  [
    "a failure after the service is stopped starts it again",
    async () => {
      await freshInstall()
      // A file where the attach directory belongs makes the attach write fail after the data work.
      await ok(`mv /etc/turenos ${E2E.work}/turenos-dir && touch /etc/turenos`)
      try {
        const result = await remote(`${forge} persistent install --apply 2>&1`)
        expect(result.code !== 0, `install succeeded with /etc/turenos as a file:\n${result.output}`)
        expect(
          (await remote(`systemctl is-active --quiet turenos.service`)).code === 0,
          "the service was left stopped after a failed re-run",
        )
      } finally {
        await ok(`rm -f /etc/turenos && mv ${E2E.work}/turenos-dir /etc/turenos`)
      }
      await waitHealthy()
    },
  ],
  [
    "a quick-connect database imports with its original key",
    async () => {
      const keyID = "e2e-quick-key"
      const key = Buffer.alloc(32, 3).toString("base64")
      const password = "quick-password"
      const q = E2E.quick
      await ok(
        // Only the server is backgrounded, detached from every ssh pipe so the command can return.
        `mkdir -p ${q} && cd ${q} || exit 1\n` +
          `setsid env -i PATH=/usr/bin:/bin HOME=${q} XDG_DATA_HOME=${q}/data XDG_CONFIG_HOME=${q}/config ` +
          `XDG_STATE_HOME=${q}/state XDG_CACHE_HOME=${q}/cache FORGE_DB=${q}/forge.db ` +
          `FORGE_SECRET_VAULT_KEY_ID=${keyID} FORGE_SECRET_VAULT_KEY=${key} FORGE_SERVER_PASSWORD=${password} ` +
          `${forge} serve --hostname 127.0.0.1 --port ${E2E.quickPort} < /dev/null > ${q}/serve.log 2>&1 &\n` +
          `echo $! > ${q}/pid`,
        { root: false },
      )
      const auth = `-u forge:${password}`
      await ok(
        `for i in $(seq 60); do curl -sf --max-time 5 ${auth} http://127.0.0.1:${E2E.quickPort}/global/server >/dev/null && exit 0; sleep 1; done; cat ${q}/serve.log; exit 1`,
        { root: false },
      )
      await ok(
        `curl -sf --max-time 5 ${auth} -X PUT -H 'content-type: application/json' --data '{"type":"api","key":"sk-quick"}' ` +
          `http://127.0.0.1:${E2E.quickPort}/auth/e2e-provider`,
        { root: false },
      )
      await ok(
        `kill $(cat ${q}/pid); for i in $(seq 20); do kill -0 $(cat ${q}/pid) 2>/dev/null || exit 0; sleep 0.5; done; exit 1`,
        {
          root: false,
        },
      )

      const input = `${keyID}\n${key}\n`
      const verified = await remote(`${forge} persistent verify-key --db ${q}/forge.db`, { root: false, input })
      expect(verified.code === 0, `verify-key refused the source:\n${verified.output}`)
      refused(await install(`--apply --key-stdin --import-db ${q}/forge.db`, input), "another account can write")

      await ok(`mkdir -m 700 ${E2E.work}/import && cp ${q}/forge.db* ${E2E.work}/import/`)
      const wrong = `${keyID}\n${Buffer.alloc(32, 4).toString("base64")}\n`
      refused(await install(`--apply --key-stdin --import-db ${E2E.work}/import/forge.db`, wrong), "cannot open")
      expect((await remote(`test -e ${E2E.unit}`)).code !== 0, "a refused import wrote the unit")

      const sum = await ok(`sha256sum ${E2E.work}/import/forge.db`)
      const result = await install(`--apply --key-stdin --import-db ${E2E.work}/import/forge.db`, input)
      expect(result.code === 0, `import failed:\n${result.output}`)
      expect((await descriptor()).keyID === keyID, "the imported server does not use the original key")
      expect((await ok(`sha256sum ${E2E.work}/import/forge.db`)) === sum, "the import source was modified")
      const report = JSON.parse(
        (await ok(`${forge} persistent verify-key --db ${database}`, { input })).split("\n")[0]!,
      ) as {
        owner?: { mode: string }
        stores: Array<{ store: string; opened: boolean }>
      }
      expect(report.owner?.mode === "persistent", `imported owner is ${JSON.stringify(report.owner)}`)
      expect(
        report.stores.every((store) => store.opened),
        `imported secrets do not open: ${JSON.stringify(report.stores)}`,
      )
    },
  ],
]

scenarios.push([
  "a persistent backup restores under its own server ID with its data and config",
  async () => {
    await freshInstall()
    const before = await descriptor()
    const key = await ok(`cat ${recoveryFile}`)
    const stored = await request("/auth/e2e-provider", { method: "PUT", body: { type: "api", key: "sk-e2e-secret" } })
    expect(stored.status === 200, `storing a provider key failed: ${stored.status} ${stored.body}`)
    // State beside the database that only a data and config import carries over.
    const data = `${E2E.dataRoot}/data/forge`
    const config = `${E2E.dataRoot}/config/forge`
    await ok(
      `systemctl stop turenos.service && install -d -o ${E2E.user} -g ${E2E.user} -m 700 ${data}/plans ${config} && ` +
        `install -o ${E2E.user} -g ${E2E.user} -m 600 /dev/null ${data}/plans/e2e.md && ` +
        `printf '{}\\n' > ${config}/forge.json && chown ${E2E.user}:${E2E.user} ${config}/forge.json && ` +
        `ln -s /nonexistent ${data}/e2e-link && chown -h ${E2E.user}:${E2E.user} ${data}/e2e-link`,
    )
    const backup = `${E2E.work}/restore`
    // Copies owned by root, as documented: a staged directory the service account owns would be
    // refused as one another account can write.
    await ok(
      `mkdir -m 700 ${backup} && cp -a --no-preserve=ownership ${data} ${backup}/data && cp -a --no-preserve=ownership ${config} ${backup}/config`,
    )
    // The host loses its service and data root, as after a rebuild; the backup is all that is left.
    await ok(
      [
        `systemctl disable --now turenos.service`,
        ...owned.map((file) => `rm -f ${file}`),
        `systemctl daemon-reload`,
        `rm -rf ${E2E.dataRoot}`,
      ].join(" && "),
    )
    const input = `${key}\n`
    const refusal = await install(`--apply --key-stdin --import-db ${backup}/data/forge.db`, input)
    refused(refusal, `--server-id ${before.serverID}`)
    // The claim leaves an empty, user-owned layout behind; what matters is that no database blocks the retry.
    expect((await remote(`test -e ${database}`)).code !== 0, "a refused restore left a database behind")
    const result = await install(
      `--apply --key-stdin --server-id ${before.serverID} --import-db ${backup}/data/forge.db ` +
        `--import-data ${backup}/data --import-config ${backup}/config`,
      input,
    )
    expect(result.code === 0, `restore failed:\n${result.output}`)
    const after = await descriptor()
    expect(after.serverID === before.serverID && after.keyID === before.keyID, "restore changed the server or key")
    const report = JSON.parse(
      (await ok(`${forge} persistent verify-key --db ${database}`, { input })).split("\n")[0]!,
    ) as { stores: Array<{ store: string; sealed: number; opened: boolean }> }
    expect(
      report.stores.some((store) => store.store === "storage" && store.sealed > 0 && store.opened),
      `the restored provider key is not readable: ${JSON.stringify(report.stores)}`,
    )
    expect((await mode(`${data}/plans/e2e.md`)) === `600 ${E2E.user}:${E2E.user}`, "the plan was not restored")
    expect((await mode(`${config}/forge.json`)).endsWith(`${E2E.user}:${E2E.user}`), "the config was not restored")
    expect((await ok(`readlink ${data}/e2e-link`)) === "/nonexistent", "the link was not copied as a link")
    expect((await ok(`stat -c %U ${data}/e2e-link`)) === E2E.user, "the link is not owned by the service")
  },
])

// ---------------------------------------------------------------------------------------------

if (args.restore) {
  if ((await remote(`test -d ${E2E.backup}`)).code !== 0)
    throw new Error(`${E2E.backup} is missing; nothing to restore`)
  await lock({ takeOver: true })
  await restore()
  await unlock()
  console.log("restored")
  process.exit(0)
}

await lock()
await Promise.resolve()
  .then(async () => {
    if (!args["remote-bin"]) {
      console.log(`uploading ${args.bin} to ${host}:${E2E.bin}`)
      await upload()
    }
    await backup()
  })
  .catch(async (error) => {
    // Nothing was moved yet, so there is nothing for --restore to finish.
    if ((await remote(`test -e ${E2E.backup}`)).code !== 0) await unlock()
    throw error
  })
const results: Array<{ name: string; error?: string; ms: number }> = []
try {
  for (const [name, run] of scenarios) {
    if (args.only && !name.includes(args.only)) continue
    await reset()
    const started = Date.now()
    const error = await run().then(
      () => undefined,
      (error: Error) => error.message,
    )
    results.push({ name, error, ms: Date.now() - started })
    console.log(
      `${error ? "FAIL" : "pass"}  ${name} (${Date.now() - started}ms)${error ? `\n      ${error.replaceAll("\n", "\n      ")}` : ""}`,
    )
  }
} finally {
  await restore()
}
await unlock()
const failed = results.filter((result) => result.error)
console.log(`\n${results.length - failed.length} pass, ${failed.length} fail`)
process.exit(failed.length ? 1 : 0)
