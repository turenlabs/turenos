import { loadCanonicalVersion, VERSIONED_PACKAGE_FILES, versionMismatches } from "./version"

const version = await loadCanonicalVersion()
const mismatches = await versionMismatches(version)

if (mismatches.length) throw new Error(`TurenOS version drift:\n${mismatches.join("\n")}`)

console.log(`TurenOS version ${version} is synchronized across ${VERSIONED_PACKAGE_FILES.length} manifests`)
