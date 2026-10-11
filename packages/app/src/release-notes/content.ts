import type { ReleaseNote } from "../release-notes"

export const notes: readonly ReleaseNote[] = [
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
