# TurenOS Desktop — interface system

## App shell direction (decided 2026-07-19, mockup approved)

Two-level navigation: **persistent 52px icon rail + surface-owned workspace**.

- The rail is a thin shell switching between **two separate features**: Agents and Analysis. Each feature owns its content layout and state; the shell only provides navigation, shared status, and narrow reactive interfaces.
- Rail items: Agents (terminal glyph) and Analysis (isolated-workspace glyph); pinned bottom: Help, Settings, and server status. Keyboard: ⌘1 Agents, ⌘2 Analysis, ⌘\ toggle the available panel.
- **Status spine** (signature): the Agents icon carries the running-agent count using the success-state treatment.
- The Agents panel collapses by click or ⌘\ and auto-collapses when the embedded terminal takes focus. Analysis is deliberately panel-free. The rail never collapses, so orientation and status remain visible.
- **Home always presents the Agents panel** (decided 2026-07-19 after owner testing): the panel is most of Home's content (projects, search, new session), so entering `/` clears a persisted Agents collapse. Collapsing while already on Home sticks until the next entry; session routes retain the persisted collapse. On the Agents surface the rail icon's tooltip reads show/hide panel so a collapsed panel keeps a labeled affordance.
- No hover-expand overlays; expansion is click/keyboard only.

## Visual language

Use the existing `--v2-*` tokens exclusively — bg-base / bg-layer-01 / bg-layer-02 elevation, 0.5px muted borders (`box-shadow: inset 0 0 0 0.5px`), 13px UI text, muted→base text hierarchy. Rail active item = layer-02 + inset border, same idiom as settings-v2 triggers. Depth strategy: surface shifts + hairline borders, no shadows. Reference implementation of the idiom: packages/app/src/components/settings-v2/.

Mockup artifact (approved direction): claude.ai/code/artifact/88e818e9-d4c0-4620-a976-8783c822a46b
