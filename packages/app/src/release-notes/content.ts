import type { ReleaseNote } from "../release-notes"

export const notes: readonly ReleaseNote[] = [
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
