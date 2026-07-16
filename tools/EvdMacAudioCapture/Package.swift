// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "EvdMacAudioCapture",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "EvdMacAudioCapture", targets: ["EvdMacAudioCapture"])
    ],
    targets: [
        .executableTarget(
            name: "EvdMacAudioCapture",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("AudioToolbox"),
                .linkedFramework("CoreAudio")
            ]
        )
    ]
)
