// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "TurenRosettaHarness",
  platforms: [.macOS(.v14)],
  products: [.executable(name: "turen-rosetta-harness", targets: ["TurenRosettaHarness"])],
  targets: [.executableTarget(name: "TurenRosettaHarness")]
)
