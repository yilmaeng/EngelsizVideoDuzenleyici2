import Foundation

func isSupportedSystem() -> Bool {
    if #available(macOS 14.2, *) { return true }
    return false
}

func writeCapabilities() {
    Diagnostics.write([
        "success": true,
        "supported": isSupportedSystem(),
        "minimumSystemVersion": "14.2",
        "systemAudio": isSupportedSystem(),
        "applicationAudio": isSupportedSystem(),
        "microphone": false,
        "sessionVolume": false,
        "websocket": isSupportedSystem(),
        "sourceList": true
    ], to: .standardOutput)
}

do {
    let options = try CLIOptions.parse(Array(CommandLine.arguments.dropFirst()))
    if options.showCapabilities {
        writeCapabilities()
        exit(EXIT_SUCCESS)
    }
    if options.listSources {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(SourceListResponse(success: true, sources: ProcessCatalog.listApplications()))
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
        exit(EXIT_SUCCESS)
    }
    guard #available(macOS 14.2, *) else {
        throw HelperError.unsupported("macos_14_2_required")
    }
    guard options.selection != nil else {
        throw HelperError.invalidArgument("capture_mode_required")
    }
    if options.selection == .include, options.pid <= 0, options.bundleIDs.isEmpty {
        throw HelperError.invalidArgument("pid_or_bundle_id_required")
    }
    let sink: AudioSink
    if let webSocketURL = options.webSocketURL {
        sink = WebSocketAudioSink(url: webSocketURL)
    } else {
        sink = StandardOutputSink()
    }
    let capture = CoreAudioTapCapture(options: options, sink: sink)
    defer { capture.stop() }
    try capture.run()
} catch {
    Diagnostics.error(String(describing: error))
    exit(EXIT_FAILURE)
}

private struct SourceListResponse: Encodable {
    let success: Bool
    let sources: [CaptureSource]
}
