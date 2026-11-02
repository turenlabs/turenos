import type { ReleaseNote } from "../release-notes"

export const notes: readonly ReleaseNote[] = [
  {
    version: "1.0.48",
    summary:
      "A hardening release: file edits handle mixed line endings and encodings, provider thinking and tool results are forwarded correctly, and permission prompts reach the right session.",
    changes: {
      new: [
        "Tool results are retained for scoped context access.",
      ],
      improved: [
        "Gemini thinking configuration and level forward on the native route, and parallel tool results send in one turn for Gemini and Bedrock.",
        "Claude thinking blocks keep their signature when streamed text is empty, and unsigned thinking replayed from failed turns is dropped.",
      ],
      fixed: [
        "Editing files that mix LF and CRLF line endings matches the old text line by line, and non-UTF-8 files are refused instead of corrupted.",
        "Native ripgrep keeps working on very long or non-UTF-8 matching lines, and grep and glob return paths that read and edit can open.",
        "Permission requests from subagent sessions route to the parent in `forge run` and ACP sessions.",
        "The terminal client restores draft carets correctly and never saves a memory body the edit form cut short.",
        "The desktop app grants renderer permissions to every window and stops sidecar respawns after shutdown.",
      ],
    },
  },
  {
    version: "1.0.47",
    summary:
      "More resilient providers and a steadier terminal client: refusal handling, credential redaction, Team waits, and TUI polish.",
    changes: {
      new: [
        "OpenAI Responses refusals surface as visible completions instead of a silent stop.",
      ],
      improved: [
        "A 429 that only reports quota exhaustion retries as a rate limit, and a rejected ChatGPT sign-in refreshes once and retries the turn.",
        "Provider error diagnostics and transport logs redact embedded credentials.",
        "A session stays parked while any of its Team room waits is blocked, and a factory run waiting for input can be stopped.",
      ],
      fixed: [
        "A burst of messages can no longer drop a WebSocket stream silently — it fails visibly instead.",
        "Missing Team resources answer 404 instead of a generic error.",
        "The terminal client keeps the transcript in view after resize, preserves swarm post drafts, and skips updates to disposed panels.",
        "Native terminals drain their final output before the process exits.",
        "Working-folder sync is bounded during outages.",
      ],
    },
  },
  {
    version: "1.0.46",
    summary:
      "The terminal client ships inside the `forge` CLI, and the app links it into your shell as `forge` and `turenos`.",
    changes: {
      new: [
        "Run `forge tui` to open the full terminal client from the compiled `forge` binary.",
        "The app links its bundled CLI into ~/.local/bin as `forge` and `turenos` so both commands work in any terminal.",
      ],
      improved: [
        "The terminal client qualifies its embedded native builds and quits cleanly across terminal platforms.",
      ],
      fixed: [
        "Team room history stays stable and reloads less often.",
        "Retrying duty loading from the room error action works again.",
        "Shared project navigation is scoped by directory.",
      ],
    },
  },
  {
    version: "1.0.45",
    summary:
      "A new terminal client, composer predictions, bundled release notes, and Team tools across the app and terminal.",
    changes: {
      new: [
        "Try the new `turen-tui` terminal client: sessions, Team rooms, factory runs, and agent commands with its own sandbox and offline checks.",
        "Opt in to composer predictions that suggest your next prompt.",
        "See bundled release notes in the app after an update.",
        "Manage Team rooms, teammates, duties, and factory runs from the terminal client's agent commands.",
      ],
      improved: [
        "Delegated teammates can run without a lifetime cap while fewer than five children are unfinished.",
        "The terminal client attaches to your persistent server through its Unix socket and names it in the picker.",
        "Factory communication is execution-focused so run updates stay actionable.",
      ],
      fixed: [
        "Worktree creation that is interrupted now settles instead of sticking.",
        "Removed worktrees behind a symlinked path are forgotten correctly.",
        "TypeScript files are detected as text, not MPEG video, when attached.",
      ],
    },
  },
  {
    version: "1.0.44",
    summary:
      "Team collaboration improvements, secure 1Password environment access, and more reliable workspace search and automations.",
    changes: {
      new: [
        "Use the 1Password Developer Environments integration to manage approved local environment mounts without exposing secret values to agents.",
        "See teammate activity directly in Team room chat.",
      ],
      improved: [
        "Team rooms reopen at the latest message and remember the last room you visited.",
        "Factory run details stay open while Team activity refreshes.",
      ],
      fixed: [
        "Workspace search recovers from ripgrep WASM failures instead of leaving searches without results.",
        "Bash permission rules match each simple command rather than the entire compound command.",
        "Scheduled automations are rescheduled after timezone changes.",
      ],
    },
  },
]
