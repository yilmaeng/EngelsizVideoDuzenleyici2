import AudioToolbox
import CoreAudio
import Darwin
import Foundation

@available(macOS 14.2, *)
final class CoreAudioTapCapture {
    private let options: CLIOptions
    private let sink: AudioSink
    private let ioQueue = DispatchQueue(label: "com.engelsiz.evd.native-audio.io", qos: .userInteractive)
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var resampler: StereoResampler?
    private var inputSampleRate = 48_000.0
    private var packetCount: UInt64 = 0
    private var frameCount: UInt64 = 0
    private var writeCount: UInt64 = 0
    private var byteCount: UInt64 = 0
    private var lastPeak: Float = 0
    private var diagnosticTimer: DispatchSourceTimer?

    init(options: CLIOptions, sink: AudioSink) {
        self.options = options
        self.sink = sink
    }

    func run() throws {
        let description = try makeTapDescription()
        try checkOSStatus(AudioHardwareCreateProcessTap(description, &tapID), "create_process_tap")
        let tapUID = try readTapUID()
        inputSampleRate = try readTapFormat().mSampleRate
        resampler = StereoResampler(inputRate: inputSampleRate)
        try createAggregateDevice(tapUID: tapUID)
        try registerIOProc()

        Diagnostics.write([
            "success": true,
            "sampleRate": 48_000,
            "sourceSampleRate": inputSampleRate,
            "channels": 2,
            "format": sink.formatName,
            "pid": options.pid,
            "mode": modeNumber,
            "source": sourceName,
            "transport": sink.transportName
        ])

        installSignalHandlers()
        startDiagnostics()
        try checkOSStatus(AudioDeviceStart(aggregateDeviceID, ioProcID), "start_aggregate_device")
        RunLoop.current.run()
    }

    func stop() {
        diagnosticTimer?.cancel()
        diagnosticTimer = nil
        if aggregateDeviceID != kAudioObjectUnknown {
            _ = AudioDeviceStop(aggregateDeviceID, ioProcID)
        }
        if let ioProcID, aggregateDeviceID != kAudioObjectUnknown {
            _ = AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
        }
        ioProcID = nil
        if aggregateDeviceID != kAudioObjectUnknown {
            _ = AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = kAudioObjectUnknown
        }
        if tapID != kAudioObjectUnknown {
            _ = AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }
        sink.close()
    }

    private var modeNumber: Int {
        options.selection == .exclude ? 1 : 0
    }

    private var sourceName: String {
        options.selection == .globalOutput ? "output_loopback" : "process_loopback"
    }

    private func makeTapDescription() throws -> CATapDescription {
        let bundleIDs = options.bundleIDs + options.excludedBundleIDs
        var processIDs = ProcessCatalog.processObjectIDs(forBundleIDs: bundleIDs)
        if options.pid > 0 {
            if options.selection == .include {
                processIDs.append(try ProcessCatalog.processObjectID(for: options.pid))
            } else if let processID = try? ProcessCatalog.processObjectID(for: options.pid) {
                processIDs.append(processID)
            }
        }
        processIDs = Array(Set(processIDs)).sorted()

        let description: CATapDescription
        if options.selection == .include {
            guard !processIDs.isEmpty else {
                throw HelperError.runtime("audio_process_not_found")
            }
            description = CATapDescription(stereoMixdownOfProcesses: processIDs)
        } else {
            description = CATapDescription(stereoGlobalTapButExcludeProcesses: processIDs)
        }
        description.isPrivate = true
        description.muteBehavior = .unmuted
        description.name = "EVD Native Audio \(UUID().uuidString)"
        return description
    }

    private func readTapUID() throws -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var value: CFString = "" as CFString
        var size = UInt32(MemoryLayout<CFString>.size)
        let status = withUnsafeMutablePointer(to: &value) { pointer in
            AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, pointer)
        }
        try checkOSStatus(status, "read_tap_uid")
        return value as String
    }

    private func readTapFormat() throws -> AudioStreamBasicDescription {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try checkOSStatus(AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &format), "read_tap_format")
        guard format.mFormatID == kAudioFormatLinearPCM,
              format.mBitsPerChannel == 32,
              (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0 else {
            throw HelperError.runtime("unsupported_tap_audio_format")
        }
        return format
    }

    private func createAggregateDevice(tapUID: String) throws {
        let uid = "com.engelsiz.evd.native-audio.aggregate.\(UUID().uuidString)"
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "EVD Native Audio",
            kAudioAggregateDeviceUIDKey: uid,
            kAudioAggregateDeviceMainSubDeviceKey: tapUID,
            kAudioAggregateDeviceClockDeviceKey: tapUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: tapUID,
                kAudioSubTapDriftCompensationKey: true
            ]]
        ]
        try checkOSStatus(AudioHardwareCreateAggregateDevice(description as CFDictionary, &aggregateDeviceID), "create_aggregate_device")
    }

    private func registerIOProc() throws {
        let status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateDeviceID, ioQueue) { [weak self] _, inputData, _, _, _ in
            self?.consume(inputData)
        }
        try checkOSStatus(status, "create_io_proc")
    }

    private func consume(_ inputData: UnsafePointer<AudioBufferList>) {
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
        guard !buffers.isEmpty else { return }
        let first = buffers[0]
        guard first.mData != nil else { return }
        let channelCount = max(1, Int(first.mNumberChannels))
        let frameCount = Int(first.mDataByteSize) / (MemoryLayout<Float>.size * channelCount)
        guard frameCount > 0 else { return }

        var stereo = [Float](repeating: 0, count: frameCount * 2)
        if buffers.count >= 2, buffers[0].mNumberChannels == 1, buffers[1].mNumberChannels == 1,
           let leftData = buffers[0].mData, let rightData = buffers[1].mData {
            let left = leftData.assumingMemoryBound(to: Float.self)
            let right = rightData.assumingMemoryBound(to: Float.self)
            for frame in 0..<frameCount {
                stereo[frame * 2] = left[frame]
                stereo[(frame * 2) + 1] = right[frame]
            }
        } else if let data = first.mData {
            let source = data.assumingMemoryBound(to: Float.self)
            for frame in 0..<frameCount {
                let base = frame * channelCount
                stereo[frame * 2] = source[base]
                stereo[(frame * 2) + 1] = channelCount > 1 ? source[base + 1] : source[base]
            }
        }

        let output = resampler?.process(stereo) ?? stereo
        guard !output.isEmpty else { return }
        lastPeak = output.reduce(0) { max($0, abs($1)) }
        packetCount += 1
        self.frameCount += UInt64(output.count / 2)
        writeCount += 1
        byteCount += UInt64(output.count * (sink.formatName == "float32le" ? MemoryLayout<Float>.size : MemoryLayout<Int16>.size))
        sink.write(floatStereo: output)
    }

    private func startDiagnostics() {
        let timer = DispatchSource.makeTimerSource(queue: ioQueue)
        timer.schedule(deadline: .now() + 2, repeating: 3)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            Diagnostics.write([
                "diagnostic": "capture_stats",
                "pid": self.options.pid,
                "mode": self.modeNumber,
                "source": self.sourceName,
                "packets": self.packetCount,
                "silentPackets": 0,
                "frames": self.frameCount,
                "writes": self.writeCount,
                "bytes": self.byteCount,
                "peak": self.lastPeak
            ])
        }
        timer.resume()
        diagnosticTimer = timer
    }

    private func installSignalHandlers() {
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        let signals = [SIGINT, SIGTERM].map { DispatchSource.makeSignalSource(signal: $0, queue: .main) }
        for source in signals {
            source.setEventHandler { [weak self] in
                self?.stop()
                CFRunLoopStop(CFRunLoopGetMain())
            }
            source.resume()
        }
        SignalStorage.sources = signals
    }
}

private enum SignalStorage {
    static var sources: [DispatchSourceSignal] = []
}
