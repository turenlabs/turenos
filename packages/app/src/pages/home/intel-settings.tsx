import { createSignal, For, onMount, Show } from "solid-js"
import { Tag } from "@turenlabs/ui/v2/badge-v2"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { TextInputV2 } from "@turenlabs/ui/v2/text-input-v2"
import { type IntelApi, type IntelFeed, type IntelFeedKind } from "./intel-api"
import { IntelEmpty, IntelError } from "./intel-tables"

export const INTEL_FEED_KINDS: ReadonlyArray<IntelFeedKind> = ["kev", "nvd", "epss", "github", "rss"]

/** Client-side mirror of the server feed-URL rule: only http(s) URLs poll. */
export function isValidFeedUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

const ROW = "border-b border-v2-border-border-muted px-4 py-4 last:border-b-0"
const NAME = "text-[13px] leading-4 text-v2-text-text-base [font-weight:530]"
const META = "truncate font-mono text-[10px] text-v2-text-text-faint"
const CHIP = (active: boolean) =>
  `rounded-[6px] px-2 py-1 font-mono text-[11px] outline-none transition-colors focus-visible:outline-2 focus-visible:outline-v2-border-border-focus ${
    active
      ? "bg-v2-background-bg-layer-03 text-v2-text-text-base"
      : "text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
  }`

/**
 * Power-user feed settings: per-feed enable/disable, name/URL edits, adding
 * custom feeds, and one-click reset to the built-in defaults. Writes persist
 * per-user on the server and the next ingestion poll honors them.
 */
export function IntelSettings(props: { api: IntelApi; onChanged?: () => void }) {
  const [feeds, setFeeds] = createSignal<ReadonlyArray<IntelFeed>>()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [editingID, setEditingID] = createSignal<string>()
  const [editName, setEditName] = createSignal("")
  const [editUrl, setEditUrl] = createSignal("")
  const [adding, setAdding] = createSignal(false)
  const [addName, setAddName] = createSignal("")
  const [addKind, setAddKind] = createSignal<IntelFeedKind>("rss")
  const [addUrl, setAddUrl] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  async function load() {
    setLoading(true)
    setError(undefined)
    try {
      setFeeds(await props.api.feeds())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load feeds.")
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void load()
  })

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(undefined)
    try {
      await action()
      await load()
      props.onChanged?.()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not update feeds.")
    } finally {
      setBusy(false)
    }
  }

  function startEdit(feed: IntelFeed) {
    setEditingID(feed.id)
    setEditName(feed.name)
    setEditUrl(feed.url)
    setError(undefined)
  }

  async function saveEdit(feed: IntelFeed) {
    const name = editName().trim()
    const url = editUrl().trim()
    if (!name) {
      setError("Feed name must be non-empty.")
      return
    }
    if (!isValidFeedUrl(url)) {
      setError("Feed URL must be an http(s) URL.")
      return
    }
    if (name === feed.name && url === feed.url) {
      setEditingID(undefined)
      return
    }
    setEditingID(undefined)
    await run(() => props.api.updateFeed(feed.id, { name, url }))
  }

  async function saveAdd() {
    const name = addName().trim()
    const url = addUrl().trim()
    if (!name) {
      setError("Feed name must be non-empty.")
      return
    }
    if (!isValidFeedUrl(url)) {
      setError("Feed URL must be an http(s) URL.")
      return
    }
    await run(() => props.api.addFeed({ name, kind: addKind(), url }))
    setAddName("")
    setAddUrl("")
    setAdding(false)
  }

  return (
    <div data-component="intel-settings" class="flex flex-col">
      <div class="flex items-center justify-between gap-2 px-3.5 py-2.5">
        <p class="text-[11px] leading-4 text-v2-text-text-muted">
          Changes save per user and apply on the next automatic poll.
        </p>
        <ButtonV2
          variant="ghost"
          size="normal"
          data-action="intel-feeds-reset"
          disabled={busy() || loading()}
          onClick={() => void run(() => props.api.resetFeeds())}
        >
          Reset to defaults
        </ButtonV2>
      </div>

      <Show when={error()}>
        {(message) => <IntelError message={message()} onRetry={() => void load()} />}
      </Show>

      <Show when={loading() && feeds() === undefined}>
        <p class="px-3.5 py-8 text-center text-[12px] text-v2-text-text-muted">Loading feeds…</p>
      </Show>

      <Show when={feeds() !== undefined}>
        <Show when={(feeds() ?? []).length > 0} fallback={<IntelEmpty title="No feeds" hint="Reset to defaults to restore the built-in feed list." />}>
          <div data-component="intel-feed-list">
            <For each={feeds() ?? []}>
              {(feed) => (
                <div data-component="intel-feed-row" data-feed={feed.id} class={ROW}>
                  <div class="flex items-center gap-2">
                    <div class="min-w-0 flex-1">
                      <div class="flex min-w-0 items-center gap-1.5">
                        <span class={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${NAME}`}>{feed.name}</span>
                        <Tag class="shrink-0">{feed.kind}</Tag>
                        <span
                          data-state={feed.enabled ? "enabled" : "disabled"}
                          class={`shrink-0 font-mono text-[10px] ${feed.enabled ? "text-v2-text-text-faint" : "text-v2-state-fg-warning"}`}
                        >
                          {feed.enabled ? "on" : "off"}
                        </span>
                      </div>
                      <p class={META} title={feed.url}>
                        {feed.url}
                      </p>
                    </div>
                    <ButtonV2
                      variant="ghost"
                      size="normal"
                      data-action={`intel-feed-toggle-${feed.id}`}
                      aria-pressed={feed.enabled}
                      disabled={busy()}
                      onClick={() => void run(() => props.api.updateFeed(feed.id, { enabled: !feed.enabled }))}
                    >
                      {feed.enabled ? "Disable" : "Enable"}
                    </ButtonV2>
                    <ButtonV2
                      variant="ghost"
                      size="normal"
                      data-action={`intel-feed-edit-${feed.id}`}
                      disabled={busy()}
                      onClick={() => startEdit(feed)}
                    >
                      Edit
                    </ButtonV2>
                  </div>
                  <Show when={editingID() === feed.id}>
                    <form
                      class="mt-2 flex flex-col gap-2"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void saveEdit(feed)
                      }}
                    >
                      <TextInputV2
                        class="!w-full !min-w-0"
                        value={editName()}
                        placeholder="Feed name"
                        aria-label={`Name for ${feed.id}`}
                        onInput={(event) => setEditName(event.currentTarget.value)}
                      />
                      <TextInputV2
                        class="!w-full !min-w-0"
                        value={editUrl()}
                        placeholder="https://example.com/feed.xml"
                        aria-label={`URL for ${feed.id}`}
                        onInput={(event) => setEditUrl(event.currentTarget.value)}
                      />
                      <div class="flex items-center gap-2">
                        <ButtonV2 type="submit" variant="ghost" size="normal" data-action={`intel-feed-save-${feed.id}`} disabled={busy()}>
                          Save
                        </ButtonV2>
                        <ButtonV2
                          variant="ghost"
                          size="normal"
                          data-action={`intel-feed-cancel-${feed.id}`}
                          onClick={() => setEditingID(undefined)}
                        >
                          Cancel
                        </ButtonV2>
                      </div>
                    </form>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      <div class="px-3.5 py-2.5">
        <Show
          when={adding()}
          fallback={
            <ButtonV2
              variant="ghost"
              size="normal"
              data-action="intel-feed-add-open"
              disabled={busy() || loading()}
              onClick={() => {
                setAdding(true)
                setError(undefined)
              }}
            >
              Add feed
            </ButtonV2>
          }
        >
          <form
            class="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void saveAdd()
            }}
          >
            <TextInputV2
              class="!w-full !min-w-0"
              value={addName()}
              placeholder="Feed name"
              aria-label="New feed name"
              onInput={(event) => setAddName(event.currentTarget.value)}
            />
            <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="New feed kind">
              <For each={INTEL_FEED_KINDS}>
                {(kind) => (
                  <button
                    type="button"
                    data-action={`intel-feed-kind-${kind}`}
                    aria-pressed={addKind() === kind}
                    class={CHIP(addKind() === kind)}
                    onClick={() => setAddKind(kind)}
                  >
                    {kind}
                  </button>
                )}
              </For>
            </div>
            <TextInputV2
              class="!w-full !min-w-0"
              value={addUrl()}
              placeholder="https://example.com/feed.xml"
              aria-label="New feed URL"
              onInput={(event) => setAddUrl(event.currentTarget.value)}
            />
            <div class="flex items-center gap-2">
              <ButtonV2 type="submit" variant="ghost" size="normal" data-action="intel-feed-add-save" disabled={busy()}>
                Save feed
              </ButtonV2>
              <ButtonV2
                variant="ghost"
                size="normal"
                data-action="intel-feed-add-cancel"
                onClick={() => setAdding(false)}
              >
                Cancel
              </ButtonV2>
            </div>
          </form>
        </Show>
      </div>
    </div>
  )
}
