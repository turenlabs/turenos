import { expect, test } from "bun:test"

const workflow = await Bun.file(new URL("../../../../.github/workflows/release.yml", import.meta.url)).text()
const windowsSigner = await Bun.file(new URL("../../../../script/sign-windows.ps1", import.meta.url)).text()

test("release workflow requires every signing identity before building", () => {
  for (const secret of [
    "APPLE_CERTIFICATE_APPLICATION_P12",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_ID",
    "APPLE_ID_PASSWORD",
    "APPLE_TEAM_ID",
    "AZURE_TRUSTED_SIGNING_ACCOUNT",
    "AZURE_TRUSTED_SIGNING_PROFILE",
    "RELEASE_GPG_PRIVATE_KEY_B64",
    "RELEASE_GPG_PASSPHRASE",
    "RELEASE_GPG_FINGERPRINT",
  ]) {
    expect(workflow).toContain(secret)
  }
  expect(workflow).not.toContain("APPLE_API_KEY")
  expect(workflow).toContain("sign-runtime-macos:")
  expect(workflow).toContain("sign-runtime-windows:")
  expect(workflow).toContain("script/build.ts --skip-install --platform")
  expect(workflow).toContain("pattern: runtime-darwin-unsigned-*")
  expect(workflow).toContain("pattern: runtime-windows-unsigned-*")
  expect(workflow).toContain('FORGE_REQUIRE_SIGNING: "1"')
  expect(windowsSigner).toContain("AZURE_TRUSTED_SIGNING_ACCOUNT")
  expect(windowsSigner).toContain("AZURE_TRUSTED_SIGNING_PROFILE")
  expect(windowsSigner).not.toContain("AZURE_TRUSTED_SIGNING_ACCOUNT_NAME")
})

test("release workflow signs and requires every published desktop format", () => {
  for (const artifact of [
    "turenos-desktop-mac-x64.dmg",
    "turenos-desktop-mac-x64.zip",
    "turenos-desktop-mac-arm64.dmg",
    "turenos-desktop-mac-arm64.zip",
    "turenos-desktop-win-x64.exe",
    "turenos-desktop-win-arm64.exe",
    "turenos-desktop-linux-x64.AppImage",
    "turenos-desktop-linux-x64.deb",
    "turenos-desktop-linux-x64.rpm",
    "turenos-desktop-linux-arm64.AppImage",
    "turenos-desktop-linux-arm64.deb",
    "turenos-desktop-linux-arm64.rpm",
  ]) {
    expect(workflow).toContain(artifact)
  }
  expect(workflow).toContain("gpg --batch --yes --armor --detach-sign")
  expect(workflow).toContain("xcrun notarytool submit")
  expect(workflow).toContain("Get-AuthenticodeSignature")
  expect(workflow).toContain("packages/desktop/dist/latest*.yml")
  expect(workflow).toContain("packages/desktop/dist/*.blockmap")
  expect(workflow).toContain("bun packages/desktop/scripts/update-artifacts.ts release-assets")
  expect(workflow).toContain('bun packages/desktop/scripts/update-artifacts.ts "$verify_dir" "$VERSION"')
})
