import Foundation
import Virtualization

private let minimumMemory = 256 * 1024 * 1024
private let maximumMemory = 1024 * 1024 * 1024

@main
@MainActor
struct TurenRosettaHarness {
  static func main() async throws {
    let request = try Request.parse(CommandLine.arguments)
    if VZLinuxRosettaDirectoryShare.availability == .notSupported {
      throw HarnessError("Rosetta for Linux is unavailable on this Mac")
    }
    if VZLinuxRosettaDirectoryShare.availability == .notInstalled {
      try await VZLinuxRosettaDirectoryShare.installRosetta()
    }

    let staging = try StagingDirectory(executable: request.executable)
    defer { staging.remove() }
    let console = Pipe()
    let guestOutput = Pipe()
    let machine = VZVirtualMachine(configuration: try configuration(request: request, staging: staging.url, console: console, guestOutput: guestOutput))
    let lifecycle = Lifecycle()
    machine.delegate = lifecycle
    let reader = console.fileHandleForReading
    let outputReader = guestOutput.fileHandleForReading
    let consoleDrain = Task.detached { reader.readDataToEndOfFile() }
    let output = Task.detached { outputReader.readDataToEndOfFile() }

    do {
      try await machine.start()
      try await lifecycle.wait(timeoutSeconds: request.timeoutSeconds)
    } catch {
      try? await machine.stop()
      console.fileHandleForWriting.closeFile()
      guestOutput.fileHandleForWriting.closeFile()
      _ = await consoleDrain.value
      FileHandle.standardError.write(await output.value)
      throw error
    }
    console.fileHandleForWriting.closeFile()
    guestOutput.fileHandleForWriting.closeFile()
    _ = await consoleDrain.value
    let text = String(decoding: await output.value, as: UTF8.self)
    let payload: String
    if let begin = text.range(of: "TUREN_OUTPUT_BEGIN") {
      let body = text[begin.upperBound...]
      if let end = body.range(of: "TUREN_OUTPUT_END") {
        payload = String(body[..<end.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
      } else {
        payload = String(body).trimmingCharacters(in: .whitespacesAndNewlines)
      }
    } else {
      payload = ""
      FileHandle.standardError.write(Data(text.utf8))
    }
    guard let marker = text.range(of: "TUREN_EXIT=", options: .backwards) else {
      throw HarnessError("Guest stopped without an exit status")
    }
    let value = text[marker.upperBound...].prefix { $0 == "-" || $0.isNumber }
    guard let exit = Int(value) else { throw HarnessError("Guest returned an invalid exit status") }
    let result = try JSONSerialization.data(withJSONObject: ["exit": exit, "output": payload])
    FileHandle.standardOutput.write(result)
    Foundation.exit(0)
  }

  private static func configuration(request: Request, staging: URL, console: Pipe, guestOutput: Pipe) throws -> VZVirtualMachineConfiguration {
    let boot = VZLinuxBootLoader(kernelURL: request.kernel)
    boot.initialRamdiskURL = request.initrd
    boot.commandLine = "console=hvc0 rdinit=/init panic=-1"

    let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
    serial.attachment = VZFileHandleSerialPortAttachment(
      fileHandleForReading: FileHandle(forReadingAtPath: "/dev/null")!,
      fileHandleForWriting: console.fileHandleForWriting
    )
    let outputSerial = VZVirtioConsoleDeviceSerialPortConfiguration()
    outputSerial.attachment = VZFileHandleSerialPortAttachment(
      fileHandleForReading: FileHandle(forReadingAtPath: "/dev/null")!,
      fileHandleForWriting: guestOutput.fileHandleForWriting
    )

    let input = VZVirtioFileSystemDeviceConfiguration(tag: "turen-input")
    input.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: staging, readOnly: true))
    let rosetta = VZVirtioFileSystemDeviceConfiguration(tag: "rosetta")
    rosetta.share = try VZLinuxRosettaDirectoryShare()

    let config = VZVirtualMachineConfiguration()
    config.bootLoader = boot
    config.cpuCount = 1
    config.memorySize = UInt64(max(minimumMemory, min(maximumMemory, request.memoryMiB * 1024 * 1024)))
    config.serialPorts = [serial, outputSerial]
    config.directorySharingDevices = [rosetta, input]
    config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    try config.validate()
    return config
  }
}

private struct Request {
  let kernel: URL
  let initrd: URL
  let executable: URL
  let timeoutSeconds: Int
  let memoryMiB: Int

  static func parse(_ arguments: [String]) throws -> Request {
    let values = Dictionary(uniqueKeysWithValues: stride(from: 1, to: arguments.count - 1, by: 2).map {
      (arguments[$0], arguments[$0 + 1])
    })
    guard let kernel = values["--kernel"], let initrd = values["--initrd"], let executable = values["--executable"] else {
      throw HarnessError("usage: turen-rosetta-harness --kernel PATH --initrd PATH --executable PATH [--timeout SECONDS] [--memory MIB]")
    }
    return Request(
      kernel: URL(fileURLWithPath: kernel),
      initrd: URL(fileURLWithPath: initrd),
      executable: URL(fileURLWithPath: executable),
      timeoutSeconds: min(max(Int(values["--timeout"] ?? "30") ?? 30, 1), 120),
      memoryMiB: min(max(Int(values["--memory"] ?? "512") ?? 512, 256), 1024)
    )
  }
}

private final class StagingDirectory {
  let url: URL

  init(executable: URL) throws {
    url = FileManager.default.temporaryDirectory.appending(path: "turen-rosetta-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
    try FileManager.default.copyItem(at: executable, to: url.appending(path: "program"))
    try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: url.appending(path: "program").path)
  }

  func remove() {
    try? FileManager.default.removeItem(at: url)
  }
}

private final class Lifecycle: NSObject, VZVirtualMachineDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Void, Error>?

  func wait(timeoutSeconds: Int) async throws {
    try await withCheckedThrowingContinuation { continuation in
      lock.withLock { self.continuation = continuation }
      DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(timeoutSeconds)) { [weak self] in
        self?.settle(.failure(HarnessError("Execution exceeded \(timeoutSeconds) seconds")))
      }
    }
  }

  func guestDidStop(_ virtualMachine: VZVirtualMachine) {
    settle(.success(()))
  }

  func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: any Error) {
    settle(.failure(error))
  }

  private func settle(_ result: Result<Void, Error>) {
    let continuation = lock.withLock {
      defer { self.continuation = nil }
      return self.continuation
    }
    continuation?.resume(with: result)
  }
}

private struct HarnessError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}
