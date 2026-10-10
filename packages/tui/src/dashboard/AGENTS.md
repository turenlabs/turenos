# The dashboard

`mountApp` (`app.ts`) owns the server picker and swaps dashboards. `mountDashboard` (`mount.ts`) builds one:
1. the process-local state (`src/state.ts`);
2. the layout (`src/layout.ts`);
3. the feature controllers, in `createControls` (`controls.ts`), group by group onto the controller set, d.c;
4. the renderer listeners (`attach` in `lifecycle.ts`).

## Conventions

- A group may read the controllers of the groups built before it. Anything else is reached through d.c inside a callback, because it does not exist yet.
- Feature folders expose one `create…` factory from their façade (`src/queue.ts`, `src/team.ts`, …). Dialogs open through d.c.dialogs (`src/dialogs/`).
- `routeKey` (`key-router.ts`) tries its stages in priority order: the screensaver, global keys, the open dialog, search, chords, capital letters, Esc, Tab, single characters, then the focused pane.
  - A stage returns true once it used the key, and calls `preventDefault` so the focused editor does not also get it.
  - A new binding goes in the stage whose context it needs.
- Match keys with `matchesKey` (`src/keys.ts`), which requires the exact modifiers.
- Every user-facing key appears in three places:
  - the `?` help text (`src/menus/help-text.ts`);
  - the command palette entry's `key:` (`commands.ts`), when the palette has one;
  - `docs/systems/tui/usage.md`.

  The help's first page must keep its essentials at small sizes; tests check it.
- Status-line notices go through `d.say`; an error notice is `d.say(text, true)`.
