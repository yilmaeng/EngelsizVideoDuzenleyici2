import Foundation

protocol AudioSink: AnyObject {
    var transportName: String { get }
    var formatName: String { get }
    func write(floatStereo samples: [Float])
    func close()
}

final class StandardOutputSink: AudioSink {
    let transportName = "stdout"
    let formatName = "float32le"
    private let handle = FileHandle.standardOutput

    func write(floatStereo samples: [Float]) {
        guard !samples.isEmpty else { return }
        samples.withUnsafeBytes { bytes in
            handle.write(Data(bytes))
        }
    }

    func close() {}
}

final class WebSocketAudioSink: AudioSink {
    let transportName = "websocket"
    let formatName = "pcm_s16le"
    private let lock = NSLock()
    private var pendingWrites = 0
    private var closed = false
    private let task: URLSessionWebSocketTask

    init(url: URL) {
        task = URLSession.shared.webSocketTask(with: url)
        task.resume()
        receiveNextMessage()
    }

    func write(floatStereo samples: [Float]) {
        guard !samples.isEmpty else { return }
        lock.lock()
        guard !closed, pendingWrites < 8 else {
            lock.unlock()
            return
        }
        pendingWrites += 1
        lock.unlock()

        var pcm = [Int16](repeating: 0, count: samples.count)
        for index in samples.indices {
            let value = max(-1, min(1, samples[index]))
            pcm[index] = value < 0
                ? Int16((value * 32768).rounded())
                : Int16((value * 32767).rounded())
        }
        let data = pcm.withUnsafeBytes { Data($0) }
        task.send(.data(data)) { [weak self] error in
            guard let self else { return }
            self.lock.lock()
            self.pendingWrites = max(0, self.pendingWrites - 1)
            if error != nil { self.closed = true }
            self.lock.unlock()
            if let error {
                Diagnostics.error("monitor_audio_websocket_send_failed:\(error.localizedDescription)")
            }
        }
    }

    func close() {
        lock.lock()
        closed = true
        lock.unlock()
        task.cancel(with: .goingAway, reason: nil)
    }

    private func receiveNextMessage() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.receiveNextMessage()
            case .failure(let error):
                self.lock.lock()
                let shouldReport = !self.closed
                self.closed = true
                self.lock.unlock()
                if shouldReport {
                    Diagnostics.error("monitor_audio_websocket_receive_failed:\(error.localizedDescription)")
                }
            }
        }
    }
}

final class StereoResampler {
    private let inputRate: Double
    private let outputRate: Double
    private var position = 0.0
    private var previousFrame: (Float, Float)?

    init(inputRate: Double, outputRate: Double = 48_000) {
        self.inputRate = max(1, inputRate)
        self.outputRate = max(1, outputRate)
    }

    func process(_ input: [Float]) -> [Float] {
        guard input.count >= 2 else { return [] }
        if abs(inputRate - outputRate) < 0.5 { return input }

        var source = input
        if let previousFrame {
            source.insert(previousFrame.1, at: 0)
            source.insert(previousFrame.0, at: 0)
        }
        let frameCount = source.count / 2
        guard frameCount >= 2 else { return [] }
        let step = inputRate / outputRate
        var output: [Float] = []
        output.reserveCapacity(Int(Double(frameCount) / step) * 2)
        while position + 1 < Double(frameCount) {
            let index = Int(position)
            let fraction = Float(position - Double(index))
            let nextIndex = min(frameCount - 1, index + 1)
            let left = source[index * 2] + ((source[nextIndex * 2] - source[index * 2]) * fraction)
            let right = source[(index * 2) + 1] + ((source[(nextIndex * 2) + 1] - source[(index * 2) + 1]) * fraction)
            output.append(left)
            output.append(right)
            position += step
        }
        position -= Double(frameCount - 1)
        previousFrame = (source[(frameCount - 1) * 2], source[((frameCount - 1) * 2) + 1])
        return output
    }
}
