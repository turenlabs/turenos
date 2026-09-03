import type { MemoryDrawer } from "@turenlabs/sdk/v2/client"
import { ButtonV2 } from "@turenlabs/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@turenlabs/ui/v2/dialog-v2"
import { DividerV2 } from "@turenlabs/ui/v2/divider-v2"
import { SelectV2 } from "@turenlabs/ui/v2/select-v2"
import { TextareaV2 } from "@turenlabs/ui/v2/textarea-v2"
import { TextInputV2 } from "@turenlabs/ui/v2/text-input-v2"
import { useDialog } from "@turenlabs/ui/context/dialog"
import { For, Show, createEffect, createMemo, createResource, createSignal, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { ServerSDKProvider, useServerSDK } from "@/context/server-sdk"
import "./settings-v2.css"

const kinds: MemoryDrawer["kind"][] = ["note", "fact", "decision", "observation"]

export const DialogMemoryV2: Component<{ server?: ServerConnection.Any }> = (props) => {
  const server = props.server
  if (!server) return <DialogMemoryContent />
  return (
    <ServerSDKProvider server={() => server}>
      <DialogMemoryContent />
    </ServerSDKProvider>
  )
}

const DialogMemoryContent: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const [wingID, setWingID] = createSignal("")
  const [roomID, setRoomID] = createSignal("")
  const [search, setSearch] = createSignal("")
  const [editing, setEditing] = createSignal<MemoryDrawer>()
  const [deleting, setDeleting] = createSignal("")
  const [adding, setAdding] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [form, setForm] = createStore({
    kind: "note" as MemoryDrawer["kind"],
    title: "",
    body: "",
    path: "",
    symbol: "",
  })

  const [wings, wingsActions] = createResource(serverSdk, (sdk) =>
    sdk.client.v2.memory.wings({ throwOnError: true }).then((result) => result.data),
  )
  const [rooms, roomsActions] = createResource(
    () => (wingID() ? { sdk: serverSdk(), wingID: wingID() } : undefined),
    (selected) =>
      selected.sdk.client.v2.memory
        .rooms({ wingID: selected.wingID }, { throwOnError: true })
        .then((result) => ({ wingID: selected.wingID, items: result.data })),
  )
  const [drawers, drawerActions] = createResource(
    () => (wingID() ? { sdk: serverSdk(), wingID: wingID(), roomID: roomID() || undefined } : undefined),
    (selected) =>
      selected.sdk.client.v2.memory
        .list({ wingID: selected.wingID, roomID: selected.roomID }, { throwOnError: true })
        .then((result) => ({ wingID: selected.wingID, roomID: selected.roomID, items: result.data })),
  )
  const currentRooms = createMemo(() => (rooms()?.wingID === wingID() ? rooms()?.items : undefined) ?? [])
  const currentDrawers = createMemo(() => {
    const value = drawers()
    if (value?.wingID !== wingID() || value.roomID !== (roomID() || undefined)) return []
    return value.items
  })

  createEffect(() => {
    const available = wings()
    if (!available?.length) {
      setWingID("")
      return
    }
    if (available.some((wing) => wing.id === wingID())) return
    setWingID(available[0].id)
  })

  createEffect(() => {
    const available = currentRooms()
    if (!available?.length) {
      setRoomID("")
      return
    }
    if (available.some((room) => room.id === roomID())) return
    setRoomID(available[0].id)
  })

  const filtered = createMemo(() => {
    const query = search().trim().toLocaleLowerCase()
    if (!query) return currentDrawers()
    return currentDrawers().filter((drawer) =>
      [drawer.kind, drawer.title, drawer.body, drawer.anchor.path, drawer.anchor.symbol]
        .filter((value): value is string => !!value)
        .some((value) => value.toLocaleLowerCase().includes(query)),
    )
  })
  const wingOptions = createMemo(() => (wings() ?? []).map((wing) => wing.id))
  const roomOptions = createMemo(() => currentRooms().map((room) => room.id))

  const openForm = (drawer?: MemoryDrawer) => {
    setError("")
    setEditing(drawer)
    setAdding(!drawer)
    setForm({
      kind: drawer?.kind ?? "note",
      title: drawer?.title ?? "",
      body: drawer?.body ?? "",
      path: drawer?.anchor.path ?? "",
      symbol: drawer?.anchor.symbol ?? "",
    })
  }

  const closeForm = () => {
    setAdding(false)
    setEditing(undefined)
    setError("")
  }

  const save = async () => {
    if (!form.title.trim() || !form.body.trim()) return
    setBusy(true)
    setError("")
    const sdk = serverSdk().client.v2.memory
    await Promise.resolve(wings()?.find((wing) => wing.id === wingID()))
      .then(
        (wing) =>
          wing ??
          sdk
            .wing({ kind: "person", key: "local-user", name: "Personal" }, { throwOnError: true })
            .then((result) => result.data),
      )
      .then(async (selectedWing) => {
        const selectedRoom =
          currentRooms().find((room) => room.id === roomID()) ??
          (await sdk
            .room({ wingID: selectedWing.id, slug: "general", name: "General" }, { throwOnError: true })
            .then((result) => result.data))
        if (!selectedRoom) throw new Error(language.t("memory.error.mutation"))
        const input = {
          wingID: selectedWing.id,
          roomID: selectedRoom.id,
          kind: form.kind,
          title: form.title.trim(),
          body: form.body.trim(),
          anchor: { path: form.path.trim() || undefined, symbol: form.symbol.trim() || undefined },
        }
        await (editing()
          ? sdk.update(
              { drawerID: editing()!.id, expectedTimeUpdated: editing()!.timeUpdated, ...input },
              { throwOnError: true },
            )
          : sdk.create(input, { throwOnError: true }))
        setWingID(selectedWing.id)
        setRoomID(selectedRoom.id)
        await Promise.all([wingsActions.refetch(), roomsActions.refetch(), drawerActions.refetch()])
        closeForm()
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : language.t("memory.error.mutation")))
    setBusy(false)
  }

  const remove = async (drawer: MemoryDrawer) => {
    setBusy(true)
    setError("")
    await serverSdk()
      .client.v2.memory.remove({ drawerID: drawer.id, wingID: drawer.wingID }, { throwOnError: true })
      .then(() => Promise.all([wingsActions.refetch(), roomsActions.refetch(), drawerActions.refetch()]))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : language.t("memory.error.mutation")))
    setDeleting("")
    setBusy(false)
  }

  const formOpen = () => adding() || !!editing()

  return (
    <Dialog size="x-large" class="settings-v2-memory-dialog">
      <DialogHeader>
        <DialogTitle>{language.t(formOpen() ? "memory.form.title" : "memory.title")}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <Show
        when={!formOpen()}
        fallback={
          <>
            <DialogBody class="settings-v2-memory-form">
              <div class="settings-v2-memory-field">
                <label>{language.t("memory.field.kind")}</label>
                <SelectV2
                  options={kinds}
                  current={form.kind}
                  value={(kind) => kind}
                  label={(kind) => language.t(`memory.kind.${kind}`)}
                  onSelect={(kind) => kind && setForm("kind", kind)}
                />
              </div>
              <div class="settings-v2-memory-field">
                <label>{language.t("memory.field.title")}</label>
                <TextInputV2
                  appearance="large"
                  value={form.title}
                  onInput={(event) => setForm("title", event.currentTarget.value)}
                  autofocus
                />
              </div>
              <div class="settings-v2-memory-field">
                <label>{language.t("memory.field.body")}</label>
                <TextareaV2
                  rows={8}
                  value={form.body}
                  onInput={(event) => setForm("body", event.currentTarget.value)}
                />
              </div>
              <div class="settings-v2-memory-anchor">
                <div class="settings-v2-memory-field">
                  <label>{language.t("memory.field.path")}</label>
                  <TextInputV2
                    appearance="large"
                    value={form.path}
                    onInput={(event) => setForm("path", event.currentTarget.value)}
                  />
                </div>
                <div class="settings-v2-memory-field">
                  <label>{language.t("memory.field.symbol")}</label>
                  <TextInputV2
                    appearance="large"
                    value={form.symbol}
                    onInput={(event) => setForm("symbol", event.currentTarget.value)}
                  />
                </div>
              </div>
              <Show when={error()}>
                <div class="settings-v2-memory-error">{error()}</div>
              </Show>
            </DialogBody>
            <DialogFooter>
              <ButtonV2 variant="neutral" disabled={busy()} onClick={closeForm}>
                {language.t("common.cancel")}
              </ButtonV2>
              <ButtonV2
                variant="contrast"
                disabled={busy() || !form.title.trim() || !form.body.trim()}
                onClick={() => void save()}
              >
                {busy() ? language.t("common.saving") : language.t("common.save")}
              </ButtonV2>
            </DialogFooter>
          </>
        }
      >
        <DialogBody class="settings-v2-memory-body">
          <div class="settings-v2-memory-toolbar">
            <SelectV2
              options={wingOptions()}
              current={wingID() || undefined}
              value={(id) => id}
              label={(id) => (wings() ?? []).find((wing) => wing.id === id)?.name ?? id}
              placeholder={language.t("memory.wing.empty")}
              onSelect={(id) => {
                if (!id) return
                setRoomID("")
                setWingID(id)
              }}
            />
            <SelectV2
              options={roomOptions()}
              current={roomID() || undefined}
              value={(id) => id}
              label={(id) => currentRooms().find((room) => room.id === id)?.name ?? id}
              placeholder={language.t("memory.room.empty")}
              onSelect={(id) => id && setRoomID(id)}
            />
            <TextInputV2
              type="search"
              appearance="base"
              value={search()}
              placeholder={language.t("memory.search")}
              onInput={(event) => setSearch(event.currentTarget.value)}
            />
            <ButtonV2 variant="contrast" onClick={() => openForm()}>
              {language.t("memory.add")}
            </ButtonV2>
          </div>
          <Show when={error()}>
            <div class="settings-v2-memory-error">{error()}</div>
          </Show>
          <Show
            when={!drawers.loading}
            fallback={<div class="settings-v2-memory-empty">{language.t("common.loading")}</div>}
          >
            <Show
              when={filtered().length}
              fallback={<div class="settings-v2-memory-empty">{language.t("memory.empty")}</div>}
            >
              <div class="settings-v2-memory-list">
                <For each={filtered()}>
                  {(drawer) => (
                    <article class="settings-v2-memory-card">
                      <div class="settings-v2-memory-card-copy">
                        <div class="settings-v2-memory-card-heading">
                          <span>{language.t(`memory.kind.${drawer.kind}`)}</span>
                          <strong>{drawer.title}</strong>
                        </div>
                        <p>{drawer.body}</p>
                        <Show when={drawer.anchor.path || drawer.anchor.symbol}>
                          <code>{[drawer.anchor.path, drawer.anchor.symbol].filter(Boolean).join(" · ")}</code>
                        </Show>
                      </div>
                      <div class="settings-v2-memory-actions">
                        <Show
                          when={deleting() === drawer.id}
                          fallback={
                            <>
                              <ButtonV2 variant="ghost-muted" disabled={busy()} onClick={() => openForm(drawer)}>
                                {language.t("common.edit")}
                              </ButtonV2>
                              <ButtonV2 variant="ghost-muted" disabled={busy()} onClick={() => setDeleting(drawer.id)}>
                                {language.t("common.delete")}
                              </ButtonV2>
                            </>
                          }
                        >
                          <span class="settings-v2-memory-delete-label">{language.t("memory.delete.confirm")}</span>
                          <ButtonV2 variant="neutral" disabled={busy()} onClick={() => setDeleting("")}>
                            {language.t("common.cancel")}
                          </ButtonV2>
                          <ButtonV2 variant="danger" disabled={busy()} onClick={() => void remove(drawer)}>
                            {language.t("common.delete")}
                          </ButtonV2>
                        </Show>
                      </div>
                    </article>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </DialogBody>
        <DialogFooter>
          <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
            {language.t("common.close")}
          </ButtonV2>
        </DialogFooter>
      </Show>
    </Dialog>
  )
}
