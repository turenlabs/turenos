import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const output = path.join(root, "docs", "icon-reference.html")

const escape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

const source = async (relative: string) => Bun.file(path.join(root, relative)).text()

const names = (text: string) => [...text.matchAll(/^\s+"([^"]+)",$/gm)].map((match) => match[1])

const relative = (file: string) => path.relative(path.dirname(output), path.join(root, file)).split(path.sep).join("/")

const card = (name: string, family: string, artwork: string, detail: string) => `
  <article class="card" data-search="${escape(`${name} ${family} ${detail}`.toLowerCase())}">
    <div class="artwork">${artwork}</div>
    <div class="name">${escape(name)}</div>
    <div class="detail">${escape(detail)}</div>
    <div class="family">${escape(family)}</div>
  </article>`

async function iconSymbols(file: string, prefix: string) {
  const text = await source(file)
  const imports = new Map(
    [...text.matchAll(/^import (\w+) from "(@hugeicons\/core-free-icons\/[^\"]+)"$/gm)].map((match) => [
      match[1],
      match[2],
    ]),
  )
  const object = text.match(/const icons = \{([\s\S]*?)\n\}/)?.[1]
  if (!object) throw new Error(`Could not find icon registry in ${file}`)
  const entries = [...object.matchAll(/^\s+(?:"([^"]+)"|(\w+)): (\w+),$/gm)].map((match) => ({
    name: match[1] ?? match[2],
    imported: match[3],
  }))
  const tinted = new Set(
    [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]).filter((name) => name.endsWith("-active")),
  )
  const loaded = await Promise.all(
    [...new Set(entries.map((entry) => imports.get(entry.imported)))].map(async (specifier) => {
      const name = specifier!.split("/").at(-1)!
      return [
        specifier!,
        (
          await import(
            path.join(
              root,
              "packages",
              "ui",
              "node_modules",
              "@hugeicons",
              "core-free-icons",
              "dist",
              "esm",
              `${name}.js`,
            )
          )
        ).default,
      ] as const
    }),
  )
  const artwork = new Map(loaded)
  const markup = (icon: readonly [string, Record<string, unknown>][], fill: boolean) =>
    icon
      .map(([tag, attributes]) => {
        const serialized = Object.entries(attributes)
          .filter(([attribute]) => attribute !== "key")
          .map(
            ([attribute, value]) =>
              `${attribute.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}="${value}"`,
          )
          .join(" ")
        return `<${tag} ${serialized}${fill ? ' fill="currentColor" fill-opacity="0.1"' : ""}/>`
      })
      .join("")
  return {
    entries,
    symbols: entries
      .map(
        (entry) =>
          `<symbol id="${prefix}-${entry.name}" viewBox="0 0 24 24">${markup(artwork.get(imports.get(entry.imported)!)!, tinted.has(entry.name))}</symbol>`,
      )
      .join(""),
  }
}

function brandCards() {
  const winged = relative("packages/ui/src/assets/brand/forge-winged-lockup.png")
  const compact = relative("packages/ui/src/assets/brand/forge-compact-lockup.png")
  const marks = [
    [relative("packages/ui/src/assets/brand/forge-winged-lockup.png"), "Winged"],
    [relative("packages/ui/src/assets/brand/forge-compact-mark.png"), "Compact"],
  ]
    .map(([src, name]) => `<div><img src="${src}" alt=""><span>${name}</span></div>`)
    .join("")
  return (
    card(
      "Winged TurenOS",
      "Primary lockup",
      `<img class="brand-lockup" src="${winged}" alt="Winged TurenOS lockup">`,
      "Marketing, launch, and wide surfaces",
    ) +
    card(
      "Compact TurenOS",
      "Product lockup",
      `<img class="brand-lockup brand-lockup-compact" src="${compact}" alt="Compact TurenOS lockup">`,
      "Application shell and product identity",
    ) +
    card(
      "Mark comparison",
      "Small-size study",
      `<div class="mark-comparison">${marks}</div>`,
      "Mark-only crops at constrained sizes",
    )
  )
}

async function main() {
  const [legacy, v2, providerSprite, fileSprite, providerNames, fileNames, appIcon] = await Promise.all([
    iconSymbols("packages/ui/src/components/icon.tsx", "legacy"),
    iconSymbols("packages/ui/src/v2/components/icon.tsx", "v2"),
    source("packages/ui/src/components/provider-icons/sprite.svg"),
    source("packages/ui/src/components/file-icons/sprite.svg"),
    source("packages/ui/src/components/provider-icons/types.ts").then(names),
    source("packages/ui/src/components/file-icons/types.ts").then(names),
    source("packages/ui/src/components/app-icon.tsx"),
  ])
  const appAssets = [...appIcon.matchAll(/^import \w+ from "\.\.\/(assets\/icons\/app\/[^\"]+)"$/gm)].map(
    (match) => match[1],
  )
  const appCards = appAssets
    .map((asset) =>
      card(
        path.basename(asset, path.extname(asset)),
        "Open in app",
        `<img src="${relative(`packages/ui/src/${asset}`)}" alt="">`,
        asset,
      ),
    )
    .join("")
  const legacyCards = legacy.entries
    .map((entry) =>
      card(
        entry.name,
        "Legacy UI glyph",
        `<svg viewBox="0 0 24 24"><use href="#legacy-${entry.name}"/></svg>`,
        `<Icon name="${entry.name}" />`,
      ),
    )
    .join("")
  const v2Cards = v2.entries
    .map((entry) =>
      card(
        entry.name,
        "V2 UI glyph",
        `<svg viewBox="0 0 24 24"><use href="#v2-${entry.name}"/></svg>`,
        `<IconV2 name="${entry.name}" />`,
      ),
    )
    .join("")
  const providerCards = providerNames
    .map((name) =>
      card(
        name,
        "Provider logo",
        `<svg viewBox="0 0 40 40"><use href="#${name}"/></svg>`,
        `<ProviderIcon id="${name}" />`,
      ),
    )
    .join("")
  const fileCards = fileNames
    .map((name) =>
      card(name, "File type", `<svg viewBox="0 0 24 24"><use href="#${name}"/></svg>`, "Runtime file/folder mapping"),
    )
    .join("")
  const compactMark = relative("packages/ui/src/assets/brand/forge-compact-mark.png")
  const favicon = relative("packages/ui/src/assets/favicon/web-app-manifest-512x512.png")
  const appIconPreview = relative("packages/desktop/icons/app-icon.png")
  const socialShare = relative("packages/ui/src/assets/images/social-share.png")
  const wingedLockup = relative("packages/ui/src/assets/brand/forge-winged-lockup.png")
  const webCards = [
    card(
      "Favicon scale test",
      "Web branding",
      `<div class="favicon-scales">${[16, 24, 32, 64].map((size) => `<div><img src="${favicon}" alt="" style="width:${size}px;height:${size}px"><span>${size}</span></div>`).join("")}</div>`,
      "Compact mark at 16, 24, 32, and 64px",
    ),
    card(
      "Browser tab",
      "Web branding",
      `<div class="browser-preview"><div class="browser-dot"></div><img src="${compactMark}" alt=""><span>TurenOS</span><b>×</b></div>`,
      "Compact mark in a typical browser tab",
    ),
    card(
      "Desktop app",
      "Desktop branding",
      `<div class="desktop-preview"><img src="${appIconPreview}" alt="TurenOS desktop app icon"><span>TurenOS</span></div>`,
      "Compact mark on the near-black application tile",
    ),
    card(
      "Social sharing",
      "Web branding",
      `<img class="social-preview" src="${socialShare}" alt="TurenOS social sharing preview">`,
      "Winged lockup on a 1200 by 630 sharing card",
    ),
    card(
      "Website header",
      "Web branding",
      `<div class="website-preview"><img src="${wingedLockup}" alt="Winged TurenOS lockup"><button>Download</button></div>`,
      "Winged lockup for expressive web surfaces",
    ),
  ].join("")
  const section = (id: string, title: string, count: number, content: string, note = "") =>
    `<section id="${id}"><header><h2>${title}</h2><span>${count}</span></header>${note ? `<p class="note">${note}</p>` : ""}<div class="grid">${content}</div></section>`
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TurenOS icon reference</title><style>
:root{color-scheme:dark;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#101410;color:#eef4e9}*{box-sizing:border-box}body{margin:0}.hero{padding:48px max(24px,calc((100vw - 1440px)/2));background:radial-gradient(circle at top right,#394d28,#101410 45%);border-bottom:1px solid #34422d}h1{font-size:clamp(2rem,5vw,4.5rem);letter-spacing:-.07em;margin:0}.hero p{color:#b6c4aa;max-width:760px;line-height:1.55}.filter{display:flex;gap:12px;align-items:center;max-width:720px;margin-top:28px}.filter input{background:#182018;color:inherit;border:1px solid #53694b;border-radius:10px;padding:13px 15px;font:inherit;width:100%}.filter output{color:#b6c4aa;white-space:nowrap}nav{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}nav a{color:#d8ebc8;text-decoration:none;background:#273321;padding:6px 9px;border-radius:6px;font-size:13px}main{max-width:1440px;margin:auto;padding:20px 24px 80px}section{padding-top:34px}header{display:flex;align-items:center;gap:10px;border-bottom:1px solid #2c3829;padding-bottom:10px;margin-bottom:14px}h2{font-size:20px;margin:0;letter-spacing:-.02em}header span{font-size:12px;background:#33402e;border-radius:99px;padding:3px 7px;color:#c7d8bb}.note{color:#a9b6a2;font-size:13px;line-height:1.5}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(135px,1fr));gap:10px}.card{min-height:154px;background:#182018;border:1px solid #2d3b2a;border-radius:9px;padding:11px;display:flex;flex-direction:column;gap:5px;overflow:hidden}.artwork{height:70px;display:grid;place-items:center;background:#111810;border-radius:6px;color:#eaf6e2}.artwork svg{width:38px;height:38px;fill:none;stroke:currentColor}.artwork img{max-width:86px;max-height:58px;object-fit:contain}.name{font-size:13px;font-weight:650;overflow-wrap:anywhere}.detail,.family{font-size:10px;color:#aab8a1;line-height:1.3;overflow-wrap:anywhere}.family{color:#84967a;margin-top:auto;text-transform:uppercase;letter-spacing:.06em;font-size:9px}.hidden-sprite{position:absolute;width:0;height:0;overflow:hidden}@media(max-width:600px){.hero{padding:32px 18px}main{padding:10px 14px 60px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.card{min-height:144px}}
/* Dark iron and aged-gold concept derived from the supplied anvil artwork. */
:root{background:#090c0b;color:#eee5d2;--gold:#d9b66f;--gold-deep:#8f6936;--muted:#aa9c83;--panel:#121613;--line:#382f22}body{background:radial-gradient(circle at 50% 0,#1b1b16 0,#090c0b 34rem)}.hero{position:relative;isolation:isolate;min-height:500px;overflow:hidden;background:#090c0b;border-color:#5e492d}.hero::before{content:"";position:absolute;z-index:-2;inset:0;background:linear-gradient(90deg,#090c0b 9%,rgba(9,12,11,.94) 47%,rgba(9,12,11,.25) 100%)}.hero::after{content:"";position:absolute;z-index:-3;top:50%;right:max(0px,calc((100vw - 1440px)/2));width:min(54vw,620px);aspect-ratio:1;transform:translateY(-50%);background:url("${relative("docs/assets/forge-winged-lockup-source.png")}") center/contain no-repeat;opacity:.82;filter:saturate(.8) contrast(1.08)}h1,h2{font-family:Georgia,"Times New Roman",serif;font-weight:500;color:#f1e5cc}h1{max-width:700px;line-height:.94}.hero p{color:#b9aa8e;max-width:620px}.filter input{background:rgba(17,21,19,.92);border-color:#735936;border-radius:3px}.filter input:focus{outline:2px solid rgba(217,182,111,.25);border-color:var(--gold)}.filter output,.note{color:var(--muted)}nav a{color:#ddc38e;background:#211d16;border:1px solid #493a25;border-radius:3px}header{border-color:var(--line)}header span{background:#2b2419;color:#d7bf8d}.card{background:linear-gradient(145deg,#151916,#101311);border-color:var(--line);border-radius:4px}.artwork{background:#090c0b;color:var(--gold);border:1px solid #241f18;border-radius:2px}.name{color:#eee5d2}.detail{color:#9e927d}.family{color:#8c724b}@media(max-width:760px){.hero{min-height:460px}.hero::before{background:rgba(9,12,11,.8)}.hero::after{right:-28%;width:100vw;opacity:.3}}
#brand .grid{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}#brand .card{min-height:260px;padding:14px}#brand .artwork{height:168px;padding:12px}#brand .brand-lockup{width:100%;max-width:360px;max-height:145px}#brand .brand-lockup-compact{max-width:230px}.mark-comparison{display:flex;align-items:end;justify-content:center;gap:18px;width:100%}.mark-comparison div{display:grid;gap:8px;justify-items:center}.mark-comparison img{width:94px!important;max-width:none!important;max-height:54px!important;object-fit:contain}.mark-comparison span{color:#887a62;font-size:9px;letter-spacing:.1em;text-transform:uppercase}h1,h2,#brand .name{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}h1{font-weight:720;letter-spacing:-.065em}h2{font-weight:650}#brand .name{font-size:17px;font-weight:650;letter-spacing:-.02em}
#web .grid{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}#web .card{min-height:236px;padding:14px}#web .artwork{height:142px;padding:14px;overflow:hidden}.favicon-scales{display:flex;align-items:end;justify-content:center;gap:14px;width:100%}.favicon-scales div{display:grid;justify-items:center;gap:7px}.favicon-scales img{max-width:none;max-height:none;border-radius:20%}.favicon-scales span{font-size:9px;color:#85765f}.browser-preview{display:flex;align-items:center;width:100%;max-width:260px;height:42px;padding:0 12px;background:#1b1d1b;border:1px solid #34352f;border-radius:8px 8px 2px 2px;box-shadow:0 14px 28px rgba(0,0,0,.35)}.browser-preview .browser-dot{width:7px;height:7px;margin-right:10px;border-radius:50%;background:#6e604b}.browser-preview img{width:22px;max-width:none;max-height:none;margin-right:8px}.browser-preview span{font-size:11px;color:#e6ddcb}.browser-preview b{margin-left:auto;color:#776e60;font-size:13px;font-weight:400}.desktop-preview{display:grid;justify-items:center;gap:9px}.desktop-preview img{width:86px;max-width:none;max-height:none;border-radius:22%;box-shadow:0 13px 30px rgba(0,0,0,.55)}.desktop-preview span{font-size:10px;color:#b4aa97}.artwork .social-preview{width:100%;max-width:240px;max-height:126px;border:1px solid #342c20}.website-preview{display:flex;align-items:center;justify-content:space-between;width:100%;max-width:280px;padding:13px;background:#0d100e;border:1px solid #2e271d}.website-preview img{width:132px;max-width:none;max-height:48px}.website-preview button{padding:6px 9px;color:#17130d;background:#d1ad65;border:0;border-radius:2px;font:600 9px inherit;text-transform:uppercase;letter-spacing:.05em}
</style></head><body><svg class="hidden-sprite" aria-hidden="true"><defs>${legacy.symbols}${v2.symbols}</defs></svg><div class="hidden-sprite" aria-hidden="true">${providerSprite}${fileSprite}</div><div class="hero"><h1>TurenOS Visual Reference</h1><p>Dark iron and aged gold, based on the supplied anvil and android crest. The detailed artwork leads at presentation scale while a shaped, forged anvil profile remains clear inside the product.</p><label class="filter"><input type="search" autofocus placeholder="Filter every icon and logo" aria-label="Filter icons"><output></output></label><nav><a href="#brand">Brand</a><a href="#ui">Legacy UI</a><a href="#v2">V2 UI</a><a href="#apps">Open in app</a><a href="#providers">Providers</a><a href="#files">File types</a><a href="#web">Web and desktop</a></nav></div><main>${section("brand", "TurenOS brand", 3, brandCards())}${section("ui", "Legacy UI glyphs", legacy.entries.length, legacyCards)}${section("v2", "V2 UI glyphs", v2.entries.length, v2Cards)}${section("apps", "Open in app", appAssets.length, appCards)}${section("providers", "Provider logos", providerNames.length, providerCards, "All generated provider IDs are runtime-reachable from model data.")}${section("files", "File and folder types", fileNames.length, fileCards, "The file browser resolves these dynamically from names, extensions, and folder states.")}${section("web", "Web and desktop branding", 5, webCards, "Production deployment assets generated from the approved compact and winged TurenOS artwork.")}</main><script>const input=document.querySelector('input'),cards=[...document.querySelectorAll('.card')],output=document.querySelector('output');function filter(){const query=input.value.toLowerCase();let visible=0;cards.forEach(card=>{const match=card.dataset.search.includes(query);card.hidden=!match;if(match)visible++});output.value=visible+' shown'}input.addEventListener('input',filter);filter()</script></body></html>`
  await Bun.write(
    output,
    html.replace(
      "Dark iron and aged gold, based on the supplied anvil and android crest. The detailed artwork leads at presentation scale while a shaped, forged anvil profile remains clear inside the product.",
      "Two complementary TurenOS lockups in dark iron and gold. The winged mark leads on expressive surfaces; the restrained compact mark carries the product at smaller sizes.",
    ),
  )
}

await main()
