import Foundation

enum CaptureSelection: Equatable {
    case globalOutput
    case include
    case exclude
}

struct CLIOptions {
    var showCapabilities = false
    var listSources = false
    var selection: CaptureSelection?
    var pid: pid_t = 0
    var bundleIDs: [String] = []
    var excludedBundleIDs: [String] = []
    var webSocketURL: URL?

    static func parse(_ arguments: [String]) throws -> CLIOptions {
        var result = CLIOptions()
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--capabilities":
                result.showCapabilities = true
            case "--list-sources":
                result.listSources = true
            case "--output-loopback":
                result.selection = .globalOutput
            case "--include-tree":
                result.selection = .include
            case "--exclude-tree":
                result.selection = .exclude
            case "--pid":
                index += 1
                guard index < arguments.count, let value = Int32(arguments[index]), value > 0 else {
                    throw HelperError.invalidArgument("pid_required")
                }
                result.pid = value
            case "--bundle-id":
                index += 1
                guard index < arguments.count, !arguments[index].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw HelperError.invalidArgument("bundle_id_required")
                }
                result.bundleIDs.append(arguments[index])
            case "--exclude-bundle-id":
                index += 1
                guard index < arguments.count, !arguments[index].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw HelperError.invalidArgument("exclude_bundle_id_required")
                }
                result.excludedBundleIDs.append(arguments[index])
            case "--ws-url":
                index += 1
                guard index < arguments.count, let url = URL(string: arguments[index]), ["ws", "wss"].contains(url.scheme?.lowercased() ?? "") else {
                    throw HelperError.invalidArgument("websocket_url_invalid")
                }
                result.webSocketURL = url
            case "--session-volume-get", "--session-volume-set", "--microphone", "--microphone-device-id":
                throw HelperError.unsupported("unsupported_on_platform")
            default:
                throw HelperError.invalidArgument("unknown_argument:\(argument)")
            }
            index += 1
        }
        return result
    }
}

enum HelperError: Error, CustomStringConvertible {
    case invalidArgument(String)
    case unsupported(String)
    case coreAudio(String, OSStatus)
    case runtime(String)

    var description: String {
        switch self {
        case .invalidArgument(let value), .unsupported(let value), .runtime(let value):
            return value
        case .coreAudio(let operation, let status):
            return "\(operation):\(status)"
        }
    }
}

@inline(__always)
func checkOSStatus(_ status: OSStatus, _ operation: String) throws {
    guard status == noErr else {
        throw HelperError.coreAudio(operation, status)
    }
}
