import AppKit
import CoreAudio
import Foundation

struct CaptureSource: Codable {
    let id: String
    let name: String
    let processName: String
    let processId: Int32
    let bundleId: String
}

enum ProcessCatalog {
    static func listApplications() -> [CaptureSource] {
        let ownPID = ProcessInfo.processInfo.processIdentifier
        var seen = Set<String>()
        return NSWorkspace.shared.runningApplications
            .filter { application in
                application.processIdentifier != ownPID
                    && !application.isTerminated
                    && application.activationPolicy != .prohibited
            }
            .compactMap { application in
                let pid = application.processIdentifier
                let bundleID = application.bundleIdentifier ?? ""
                let name = application.localizedName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard !name.isEmpty else { return nil }
                let key = bundleID.isEmpty ? "pid:\(pid)" : "bundle:\(bundleID)"
                guard seen.insert(key).inserted else { return nil }
                return CaptureSource(
                    id: bundleID.isEmpty ? "process:\(pid)" : "application:\(bundleID)",
                    name: name,
                    processName: name,
                    processId: pid,
                    bundleId: bundleID
                )
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    static func bundleID(for pid: pid_t) -> String? {
        NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
    }

    @available(macOS 14.2, *)
    static func processObjectIDs(forBundleIDs bundleIDs: [String]) -> [AudioObjectID] {
        let requested = Set(bundleIDs.filter { !$0.isEmpty })
        guard !requested.isEmpty else { return [] }
        return NSWorkspace.shared.runningApplications.compactMap { application in
            guard let bundleID = application.bundleIdentifier,
                  requested.contains(bundleID),
                  !application.isTerminated else {
                return nil
            }
            return try? processObjectID(for: application.processIdentifier)
        }
    }

    @available(macOS 14.2, *)
    static func processObjectID(for pid: pid_t) throws -> AudioObjectID {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var processID = pid
        var objectID = AudioObjectID(kAudioObjectUnknown)
        var outputSize = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = withUnsafePointer(to: &processID) { qualifier in
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject),
                &address,
                UInt32(MemoryLayout<pid_t>.size),
                qualifier,
                &outputSize,
                &objectID
            )
        }
        try checkOSStatus(status, "translate_pid_to_audio_process")
        guard objectID != kAudioObjectUnknown else {
            throw HelperError.runtime("audio_process_not_found")
        }
        return objectID
    }
}
