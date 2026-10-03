# Development

Develop and run checks from this independent repository root; the old monorepo's root-test guard does not apply here.

## Setup and checks

Use Bun **1.4.2**, pinned by [package.json](../../package.json). Do not treat a successful run on a different Bun version as pinned-runtime verification.

```sh
bun install --frozen-lockfile
bun run test
bun typecheck
bun run format:check
```

`test` invokes Bun's tests with the configured timeout; `typecheck` invokes `tsgo --noEmit`; `format:check` checks formatting without editing files. A focused run can use `bun test test/server.test.ts`.

If the globally installed Bun differs, prefix these commands with `npm exec --yes --package=bun@1.4.2 --`, for example `npm exec --yes --package=bun@1.4.2 -- bun run test`. This does not replace the global Bun executable.

The client dependency is `@turenlabs/client: file:./vendor/client`. It must resolve inside this checkout without workspace dependencies or a sibling TurenOS checkout. Preserve the narrow [vendor patch](../reference/provenance.md#vendored-client) when updating it; do not substitute an unrelated published SDK or regenerate an endpoint contract by guesswork.

[Linux CI](../../.github/workflows/check.yml) is configured on `ubuntu-latest` to install with a frozen lockfile, typecheck, run tests, and check formatting using the pinned Bun version. A workflow definition is not evidence of a successful run, native binary release, or cross-platform support matrix.

## Verification boundaries

[Tests](../../test/) exercise the real client against synthetic HTTP fixtures and OpenTUI test renderers. They cover transport validation, retry behavior, keyboard/modal interaction, session browsing and mutations, provider flows, models, markdown, and activity display. They are not tests against a production server.

The original TurenOS server-integration tests remain upstream; they were not converted into standalone integration tests by copying the TUI package. A standalone fixture pass does not establish compatibility with every server version. Record verification commands, Bun version, platform, and results only after running them.

For input or layout changes, verify both renderer fixtures and a real PTY. Preserve exact shortcut modifiers, captured request recipients, retry identifiers, transport limits, secret handling, and focus when dialogs close or asynchronous responses arrive. Use only synthetic data; do not restart a live server to test the client.

For goal/variant changes, include focused runs of `bun test test/goal-controls.test.ts test/model-variants.test.ts` along with launch/model integration checks. Verify read-only goal opening/refresh, explicit confirmation and typed clear, execution warnings, revision conflicts, stable Set IDs, GET-only uncertain mutation retries, and staged undo on Set. For variants, check server-advertised names, Model default, current-only unadvertised variants, captured model identity, GET verification after a switch, local-only draft selection, and reset on model change. Exercise controls at 60x24 as well as larger sizes. These are verification requirements, not a report that these checks or PTY cases have run.

OpenTUI keyboard fixtures should use `mockInput.pressEnter()`, `pressArrow(direction, modifiers)`, and `pressKey("ESCAPE")`; confirm key delivery before diagnosing controller failures. Require actual test results or formatter completion output: a Bun invocation that only prints usage or package scripts is not a verified pass, even with exit status zero.

## Optional visual audit

[script/visual-audit.py](../../script/visual-audit.py) is an optional Python harness, not a runtime dependency of the Bun client. It needs installed Bun, tmux, Python 3 with Pillow, and DejaVu Sans Mono fonts (regular, bold, oblique, and bold-oblique). It does not install those tools.

The runner uses this checkout's standalone source paths. Run from this repository root, with an output directory outside the checkout:

```sh
python3 script/visual-audit.py /tmp/opencode/tui-audit
```

The runner uses synthetic HTTP data, isolated home/cache/config directories, and a dedicated tmux socket, not an installed server or normal tmux session. It records terminal captures and reconstructs PNGs from terminal cells with Pillow; those PNGs are not screenshots of a GUI terminal and are not an independent visual review. Inspect them separately.

Keep generated evidence outside the repository. Report only the cases actually executed, with their result; do not turn a partial Linux run into a full-matrix claim. The Linux CI workflow does not run this optional harness.

## Initial verification

The independent checkout was verified on Linux with Bun **1.4.2** on **2026-09-10**:

| Check                                                        | Result                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                              | Passed with local vendored client and package-managed native dependencies.             |
| `bun run test`                                               | 408 passed, 0 failed, across 11 test files.                                            |
| `bun typecheck`                                              | Passed.                                                                                |
| `bun run format:check`                                       | Passed.                                                                                |
| `python3 script/visual-audit.py <external-output-directory>` | 511 checks passed, 0 failed; 187 PNG captures across five sizes, from 60x24 to 160x48. |

The visual harness used its isolated synthetic server and recorded unchanged source during the run. The results do not claim testing against a production server, Windows/macOS, assistive technology, or a standalone compiled binary. Generated images, logs, and evidence were kept outside Git. GitHub CI results are available on the repository's Actions page rather than inferred from local checks.

These dated initial results do not qualify subsequent goal/variant controls or other later changes; record their actual verification separately.

## Verification on 2026-09-17

Following the conversation scroll stabilization, markdown numbered list normalization, terminal cursor isolation, and keyboard shortcuts audit, the independent checkout was verified on Linux:

| Check                  | Result                                                             |
| ---------------------- | ------------------------------------------------------------------ |
| `bun run test`         | **776 passed, 0 failed**, 4,917 expectations across 31 test files. |
| `bun typecheck`        | Passed (`tsgo --noEmit`, 0 diagnostics).                           |
| `bun run format:check` | Passed (`prettier --check .`).                                     |
| `bun run build`        | Passed (bundled 36 modules to `dist/cli.js`, 0.34 MB).             |

Key verified improvements:

- **Scroll stabilization**: Eliminated message flashing and layout jumps on session load via `syncLayout()` and immediate cached live turn rendering in `loadPosition()`.
- **Numbered list rendering**: Fixed multi-line split issues on ordered lists (`1.` and `1)`) using `normalizeMarkdown()`, while leaving fenced code blocks untouched.
- **Hardware cursor management**: Concealed terminal hardware cursor by default across all views and dialogs; isolated history pagination reading positions from live streams (`test/terminal-cursor.test.ts`).
- **Keyboard shortcuts audit**: Verified complete shortcut matrix across all categories in `menus.help()` and dialog overlays with strict modifier adherence.

## Verification on 2026-09-15

Following the audit fixes and presentation improvements, the independent checkout was verified on Linux:

| Check                                                         | Result                                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `bun run test`                                                | **767 passed, 0 failed**, 4,872 expectations across 30 test files.     |
| `bun typecheck`                                               | Passed (`tsgo --noEmit`, 0 diagnostics).                               |
| `bun run format:check`                                        | Passed (`prettier --check .`).                                         |
| `bun run build`                                               | Passed (bundled 36 modules to `dist/cli.js`, 0.34 MB).                 |
| `python3 script/visual-audit.py <external-dir> --sizes 80x24` | 237 checks passed, 0 failed; 95 PNG captures.                          |
| `python3 script/visual-audit.py <external-dir> --built ...`   | 471 checks passed, 0 failed; 189 PNG captures across 80x24 and 120x36. |

## Session-window audit: 2026-09-12

The focused audit corrected active-subagent startup precedence, added `Ctrl+X` and conversation-pane `/` entry, unified local slash handling for all send controls, and restored reply focus after selected-sidebar-row clicks. Repeated-resize PTYs also exposed sidebar viewport drift; unchanged snapshot selections no longer trigger a scroll-to-selection. Existing uncommitted work was retained. The unit/rendering suite includes explicit child navigation after main-thread startup and draft-preserving command entry at 60 and 120 columns.

Verified on Linux with Bun **1.4.2**:

| Check                              | Result                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `bun test --timeout 30000`         | 672 passed, 0 failed, across 27 files.                                                                                       |
| `bun run typecheck`                | Passed.                                                                                                                      |
| `bun run format:check`             | Passed.                                                                                                                      |
| `bun run build`                    | Produced `dist/cli.js`, 33 bundled modules with external dependencies.                                                       |
| Built CLI `--help` and `--version` | Passed without connecting; version remains 1.0.14.                                                                           |
| Built CLI synthetic PTYs           | 341 checks passed, 0 failed; 150 cell-grid PNGs at 60x24 and 120x36, including repeated resizing and the 59x23 input shield. |

These checks use synthetic fixtures, not a production server. No live client or server was restarted. The final PTY command used `--built --sizes 60x24 120x36`; source remained unchanged throughout capture. It exercised conversation slash entry, local `Ctrl+S` dispatch, server-command routing, and `Ctrl+X` without unintended writes. An earlier harness run was interrupted by its dedicated tmux server shutting down between cases; the runner now retains that server until exact-socket cleanup. PNGs reconstruct terminal cells and are not a claim of visual approval or Windows/macOS verification.

## Follow-up audit: 2026-09-13

The follow-up found combinations missed by the earlier checks: streamed tail growth immediately after a history prepend, width changes while reading a wrapped paragraph, and paging beside a reply when a seventh message arrives. Regression tests now cover these paths plus End during delayed history requests. The standalone reproducer changed from two failures to two passes: prepend/stream kept the original marker on row 7, and resizing retained paragraph 25 instead of jumping to paragraph 17.

The child-only recent-page case now loads root metadata, and the task-owned notice opens the chosen owning session's reply editor after explicit Enter/click. Local slash actions remain accessible on read-only children. Wrapped reply sizing uses native wrapped rows, not newline counts, and tests retain the complete draft, focused editor, Send button, and draft controls across 60/120-column resizing.

Right-edge bounds checks also reproduced text extending beneath the transcript scrollbar. Transcript and dialog content now reserve its column; raw and rich rendering checks pass at 60 and 160 columns.

Linux/Bun 1.4.2 verification: **687 tests passed, 0 failed**, across 27 files; typecheck and rebuild passed. The rebuilt CLI passed **355 synthetic PTY checks, 0 failed**, at 60x24 and 120x36, with 158 terminal-cell PNGs and unchanged source during capture. The added cases inspect a wrapped paragraph across width changes, retain a long reply's tail and controls, and open a main-session reply from a child without sending. These are synthetic checks, not a claim that a production session's state was inspected or that other platforms were verified.

## Numbered-list follow-up

On 2026-09-13, ordered-list regressions reproduced numbers appearing above next-line item text. Fixes separate assistant metadata/content parts into Markdown blocks and remove only the native list body's erroneous first-child margin. Tests cover nested items, retained paragraph gaps, streamed 9-to-10 markers, narrow/wide reflow, and lists following metadata or reasoning. All **693 tests** pass with Bun 1.4.2; typecheck and rebuild pass. The rebuilt CLI passed **363 synthetic PTY checks** at 60x24 and 120x36, including numbered-list alignment after reasoning and width changes. The native parser and rendering safety budgets were not replaced or relaxed.

## Questions, picker, and exit verification: 2026-09-13

The question picker uses native options, multi-selection, custom text, and explicit review. New requests are offered automatically without taking over drafts or other forms, and dismissed requests do not loop on refresh. The session picker hides children only in the empty Recent view; explicit searches retain access to them and archived scopes remain separate.

Exit tests keep a real shell alive, seed its previous screen, and compare stty, cursor, alternate-screen, and mouse state after quitting. Synthetic delayed CSI/OSC replies reproduced shell leakage before bounded input settling and passed afterward. Keyboard and bracketed-paste input are blocked during settling. Run the focused exit suite with `python3 script/visual-audit.py /tmp/turen-exit-audit --built --exit-only --sizes 60x24 120x36` after building.

On Linux with Bun 1.4.2: **708 tests passed**, typecheck/build passed, and the rebuilt CLI passed **449 full PTY checks** at 60x24 and 120x36. The PTYs cover automatic questions, review-before-send, custom commas, picker browsing, exit restoration, and delayed replies. No live server or client was restarted.

## Framed questions and welcome: 2026-09-13

Questions now dock inside the session frame instead of masking the entire dashboard. Ctrl+K safely suspends/resumes the question while preserving request-scoped answers and custom cursor state; in-flight submissions still block navigation. The transcript no longer duplicates the question preview. A compact welcome state is used only without a selected session and does not add a startup gate.

Linux/Bun 1.4.2 verification: **721 tests passed**, typecheck/build passed, and **459 real-PTY checks passed** at 60x24 and 120x36. Coverage includes custom-entry picker cancellation, cross-session answer retention, busy navigation rejection, question schema changes, welcome connection-state updates, and direct New session entry. Existing clients and the live server were not restarted.

## Retro logo, sidebar finder, and shared folders: 2026-09-13

The New session mark is now original multicolored pixel art rendered with native foreground/background half blocks. Spacious launch views show a shaded wordmark and pilot emblem; small terminals, expanded settings, and retry screens retain a compact wordmark so the task and Send controls stay visible. Sidebar search reuses the Ctrl+K finder in a responsive right-side pane. Shared working folders use the existing authenticated global-storage endpoint, with bounded validation and revision-checked updates; no backend restart or new route is required on the standard server.

Final Linux/Bun 1.4.2 checks: **758 TUI tests passed**, typecheck/build and built help passed; **716 real-PTY checks passed** at 60x24, 120x36, and 160x48, with 285 captures and no source changes during capture. This includes native logo colors, focused task entry, sidebar search, folder browsing, resizing, and restored terminal state after exit. Evidence is in `/tmp/turen-retro-verified/summary.md` on the verification machine.

The companion GUI passed **1395 unit tests (1 skip)** and **50 browser-condition tests**, typecheck, and build. Real GUI and TUI folder controllers converged through one synthetic HTTP CAS server for initial seeding, concurrent opens, and bidirectional closes. Workspace projection and capacity-recovery regressions passed. Session-load benchmark payload remained 50 messages / 1 request / 3.1 MiB; local synthetic time was 4.3 ms before and 5.8 ms after, not a production performance measurement. No live client or server was restarted, and no live GUI visual verification is claimed.

## Rebuild

With Bun 1.4.2 on `PATH`, build and smoke-test the bundled client from this repository root:

```sh
bun run build
bun dist/cli.js --help
bun dist/cli.js --version
bun dist/cli.js https://turen.example
```

The build writes `dist/cli.js`, an ignored Bun-targeted JavaScript bundle. Dependencies are external: it still needs Bun and this checkout's intact `node_modules`, including OpenTUI native modules. This is not a standalone native binary. Rebuild after source changes; an existing source-based launcher continues using source, and already running clients are not restarted.

To exercise the rebuilt CLI in isolated synthetic PTYs instead of source:

```sh
python3 script/visual-audit.py /tmp/turen-tui-built-audit --built --sizes 60x24 120x36
```

## Ownership

This checkout owns source startup and the terminal client, not server installation, service control, or an already installed `turen-tui` helper. Keep Bun and the intact dependencies available when running the source CLI. There is no standalone compiled binary build yet.

Update [usage](usage.md) when operator behavior changes, [architecture](../architecture/overview.md) when connection boundaries change, and [provenance](../reference/provenance.md) when syncing copied code. Never include credentials, real session transcripts, shell history, or original machine installation records in fixtures or documentation.
