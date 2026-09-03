import { createSignal } from "solid-js"
import { TextInputV2 } from "@turenlabs/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { OFFICIAL_CATALOG_ENDPOINT, useSettings } from "@/context/settings"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

export function SettingsCatalogSection() {
  const language = useLanguage()
  const settings = useSettings()
  const [draft, setDraft] = createSignal(settings.general.catalogEndpoint())

  const commit = (value: string) => {
    const endpoint = value.trim()
    setDraft(endpoint)
    settings.general.setCatalogEndpoint(endpoint)
  }

  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.general.section.catalog")}</h3>
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.catalog.title")}
          description={language.t("settings.general.row.catalog.description")}
        >
          <div class="w-full sm:w-[280px]">
            <TextInputV2
              data-action="settings-catalog-endpoint"
              type="url"
              value={draft()}
              placeholder={OFFICIAL_CATALOG_ENDPOINT}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onChange={(event) => commit(event.currentTarget.value)}
              spellcheck={false}
              autocomplete="off"
              aria-label={language.t("settings.general.row.catalog.title")}
            />
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </div>
  )
}
