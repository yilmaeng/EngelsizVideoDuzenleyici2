import Foundation

enum Diagnostics {
    private static let lock = NSLock()

    static func write(_ payload: [String: Any], to handle: FileHandle = .standardError) {
        lock.lock()
        defer { lock.unlock() }
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
            return
        }
        handle.write(data)
        handle.write(Data([0x0A]))
    }

    static func error(_ value: String) {
        write(["success": false, "error": value])
    }
}
