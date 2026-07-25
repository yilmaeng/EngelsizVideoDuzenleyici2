using System;
using System.IO;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;

internal static class Program
{
    private const string VirtualProcessLoopbackDevice = "VAD\\Process_Loopback";
    private const int AudioClientActivationTypeProcessLoopback = 1;
    private const int ProcessLoopbackModeIncludeTargetProcessTree = 0;
    private const int ProcessLoopbackModeExcludeTargetProcessTree = 1;
    private const int CLSCTX_ALL = 23;
    private const int EDataFlowRender = 0;
    private const int EDataFlowCapture = 1;
    private const int ERoleMultimedia = 1;
    private const int ERoleCommunications = 2;
    private const int VT_BLOB = 65;
    private const int AUDCLNT_SHAREMODE_SHARED = 0;
    private const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    private const int AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    private const int AUDCLNT_BUFFERFLAGS_SILENT = 0x00000002;
    private const int WAVE_FORMAT_PCM = 0x0001;
    private const int WAVE_FORMAT_IEEE_FLOAT = 0x0003;
    private const int WAVE_FORMAT_EXTENSIBLE = 0xFFFE;

    private static readonly Guid IID_IAudioClient = new("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    private static readonly Guid IID_IAudioCaptureClient = new("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    private static readonly Guid IID_IAudioSessionManager2 = new("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    private static readonly Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = new("00000003-0000-0010-8000-00AA00389B71");

    public static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("{\"success\":false,\"error\":\"windows_required\"}");
            return 2;
        }

        var pid = 0;
        var mode = ProcessLoopbackModeExcludeTargetProcessTree;
        var wsUrl = string.Empty;
        var microphoneMode = false;
        var microphoneDeviceId = string.Empty;
        var outputLoopbackMode = false;
        var sessionVolumeGet = false;
        double? sessionVolumeSet = null;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--pid" && i + 1 < args.Length && int.TryParse(args[i + 1], out var parsedPid))
            {
                pid = parsedPid;
                i++;
            }
            else if (args[i] == "--include-tree")
            {
                mode = ProcessLoopbackModeIncludeTargetProcessTree;
            }
            else if (args[i] == "--exclude-tree")
            {
                mode = ProcessLoopbackModeExcludeTargetProcessTree;
            }
            else if (args[i] == "--ws-url" && i + 1 < args.Length)
            {
                wsUrl = args[i + 1];
                i++;
            }
            else if (args[i] == "--microphone")
            {
                microphoneMode = true;
            }
            else if (args[i] == "--microphone-device-id" && i + 1 < args.Length)
            {
                microphoneDeviceId = args[i + 1];
                i++;
            }
            else if (args[i] == "--output-loopback")
            {
                outputLoopbackMode = true;
            }
            else if (args[i] == "--session-volume-get")
            {
                sessionVolumeGet = true;
            }
            else if (args[i] == "--session-volume-set" && i + 1 < args.Length && double.TryParse(args[i + 1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var parsedVolume))
            {
                sessionVolumeSet = Math.Clamp(parsedVolume, 0, 1);
                i++;
            }
        }

        if ((sessionVolumeGet || sessionVolumeSet.HasValue) && pid <= 0)
        {
            Console.Error.WriteLine("{\"success\":false,\"error\":\"pid_required\"}");
            return 2;
        }

        if (!sessionVolumeGet && !sessionVolumeSet.HasValue && !microphoneMode && !outputLoopbackMode && pid <= 0)
        {
            Console.Error.WriteLine("{\"success\":false,\"error\":\"pid_required\"}");
            return 2;
        }

        try
        {
            CoInitializeEx(IntPtr.Zero, 0);
            if (sessionVolumeGet || sessionVolumeSet.HasValue)
            {
                var result = AudioSessionVolumeController.ApplyForProcessTree((uint)pid, sessionVolumeSet);
                Console.Out.WriteLine(result.ToJson());
                return result.ChangedSessions > 0 ? 0 : 3;
            }
            using var capture = new ProcessLoopbackCapture((uint)pid, mode, wsUrl, microphoneMode, outputLoopbackMode, microphoneDeviceId);
            capture.Run();
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("{\"success\":false,\"error\":\"" + JsonEscape(ex.Message) + "\"}");
            return 1;
        }
        finally
        {
            CoUninitialize();
        }
    }

    private static string JsonEscape(string value)
    {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    }

    private sealed class ProcessLoopbackCapture : IDisposable
    {
        private readonly uint _pid;
        private readonly int _mode;
        private readonly string _wsUrl;
        private readonly bool _microphoneMode;
        private readonly bool _outputLoopbackMode;
        private readonly string _microphoneDeviceId;
        private readonly ManualResetEventSlim _activateEvent = new(false);
        private readonly ManualResetEvent _sampleEvent = new(false);
        private IAudioClient? _audioClient;
        private IAudioCaptureClient? _captureClient;
        private WaveFormatInfo _format;
        private bool _disposed;
        private long _packetCount;
        private long _silentPacketCount;
        private long _frameCount;
        private long _writeCount;
        private long _byteCount;
        private double _lastPeak;

        public ProcessLoopbackCapture(uint pid, int mode, string wsUrl, bool microphoneMode, bool outputLoopbackMode, string microphoneDeviceId)
        {
            _pid = pid;
            _mode = mode;
            _wsUrl = wsUrl;
            _microphoneMode = microphoneMode;
            _outputLoopbackMode = outputLoopbackMode;
            _microphoneDeviceId = microphoneDeviceId;
        }

        public void Run()
        {
            _audioClient = _microphoneMode
                ? ActivateMicrophoneAudioClient(_microphoneDeviceId)
                : _outputLoopbackMode
                    ? ActivateDefaultRenderAudioClient()
                    : ActivateAudioClient();
            var mixFormatPtr = IntPtr.Zero;
            var ownsMixFormatPtr = false;
            try
            {
                var mixFormatHr = _audioClient.GetMixFormat(out mixFormatPtr);
                if (mixFormatHr >= 0 && mixFormatPtr != IntPtr.Zero)
                {
                    _format = WaveFormatInfo.FromPointer(mixFormatPtr);
                }
                else
                {
                    mixFormatPtr = BuildDefaultFloatStereoWaveFormatPointer();
                    ownsMixFormatPtr = true;
                    _format = WaveFormatInfo.CreateDefaultFloatStereo();
                }
                _audioClient.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    (_microphoneMode ? 0 : AUDCLNT_STREAMFLAGS_LOOPBACK) | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                    0,
                    0,
                    mixFormatPtr,
                    IntPtr.Zero).ThrowIfFailed("Initialize");
            }
            finally
            {
                if (mixFormatPtr != IntPtr.Zero)
                {
                    if (ownsMixFormatPtr)
                    {
                        Marshal.FreeHGlobal(mixFormatPtr);
                    }
                    else
                    {
                        CoTaskMemFree(mixFormatPtr);
                    }
                }
            }

            _audioClient.SetEventHandle(_sampleEvent.SafeWaitHandle.DangerousGetHandle()).ThrowIfFailed("SetEventHandle");
            var captureClientGuid = IID_IAudioCaptureClient;
            _audioClient.GetService(ref captureClientGuid, out var captureClientObj).ThrowIfFailed("GetService");
            _captureClient = (IAudioCaptureClient)captureClientObj;
            using var wsClient = CreateWebSocketClient();
            Console.Error.WriteLine("{\"success\":true,\"sampleRate\":" + _format.SampleRate + ",\"channels\":2,\"format\":\"" + (wsClient == null ? "float32le" : "pcm_s16le") + "\",\"pid\":" + _pid + ",\"mode\":" + _mode + ",\"source\":\"" + GetSourceName() + "\",\"transport\":\"" + (wsClient == null ? "stdout" : "websocket") + "\"}");
            _audioClient.Start().ThrowIfFailed("Start");

            var stdout = Console.OpenStandardOutput();
            var keepRunning = true;
            var nextDiagnosticAt = DateTime.UtcNow.AddSeconds(2);
            Console.CancelKeyPress += (_, eventArgs) =>
            {
                keepRunning = false;
                eventArgs.Cancel = true;
                _sampleEvent.Set();
            };

            while (keepRunning)
            {
                _sampleEvent.WaitOne(200);
                Drain(stdout, wsClient);
                var now = DateTime.UtcNow;
                if (now >= nextDiagnosticAt)
                {
                    WriteDiagnostic();
                    nextDiagnosticAt = now.AddSeconds(3);
                }
            }
        }

        private ClientWebSocket? CreateWebSocketClient()
        {
            if (string.IsNullOrWhiteSpace(_wsUrl))
            {
                return null;
            }
            var client = new ClientWebSocket();
            client.ConnectAsync(new Uri(_wsUrl), CancellationToken.None).GetAwaiter().GetResult();
            return client;
        }

        private IAudioClient ActivateAudioClient()
        {
            var audioClientGuid = IID_IAudioClient;
            var activationParams = new AudioClientActivationParams
            {
                ActivationType = AudioClientActivationTypeProcessLoopback,
                TargetProcessId = _pid,
                ProcessLoopbackMode = _mode
            };
            var activationSize = Marshal.SizeOf<AudioClientActivationParams>();
            var activationPtr = Marshal.AllocHGlobal(activationSize);
            var propPtr = Marshal.AllocHGlobal(Marshal.SizeOf<PropVariantBlob>());
            try
            {
                Marshal.StructureToPtr(activationParams, activationPtr, false);
                var prop = new PropVariantBlob
                {
                    vt = VT_BLOB,
                    wReserved1 = 0,
                    wReserved2 = 0,
                    wReserved3 = 0,
                    blobSize = activationSize,
                    blobData = activationPtr
                };
                Marshal.StructureToPtr(prop, propPtr, false);

                var handler = new ActivationHandler(_activateEvent);
                ActivateAudioInterfaceAsync(VirtualProcessLoopbackDevice, ref audioClientGuid, propPtr, handler, out _).ThrowIfFailed("ActivateAudioInterfaceAsync");
                if (!_activateEvent.Wait(TimeSpan.FromSeconds(8)))
                {
                    throw new InvalidOperationException("process_loopback_activation_timeout");
                }
                if (handler.ResultHr != 0)
                {
                    handler.ResultHr.ThrowIfFailed("ActivateCompleted");
                }
                if (handler.ActivatedInterface is not IAudioClient audioClient)
                {
                    throw new InvalidOperationException("audio_client_missing");
                }
                return audioClient;
            }
            finally
            {
                Marshal.FreeHGlobal(propPtr);
                Marshal.FreeHGlobal(activationPtr);
            }
        }

        private static IAudioClient ActivateMicrophoneAudioClient(string deviceId)
        {
            var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator
                ?? throw new InvalidOperationException("microphone_device_enumerator_missing");
            var normalizedDeviceId = (deviceId ?? string.Empty).Trim();
            if (normalizedDeviceId.Length > 0)
            {
                enumerator.GetDevice(normalizedDeviceId, out var selectedDevice).ThrowIfFailed("GetDevice microphone");
                return ActivateDeviceAudioClient(selectedDevice, "Activate selected microphone audio client");
            }
            enumerator.GetDefaultAudioEndpoint(EDataFlowCapture, ERoleCommunications, out var device).ThrowIfFailed("GetDefaultAudioEndpoint");
            return ActivateDeviceAudioClient(device, "Activate microphone audio client");
        }

        private static IAudioClient ActivateDeviceAudioClient(IMMDevice device, string context)
        {
            var audioClientGuid = IID_IAudioClient;
            device.Activate(ref audioClientGuid, CLSCTX_ALL, IntPtr.Zero, out var audioClientObj).ThrowIfFailed(context);
            return (IAudioClient)audioClientObj;
        }

        private static IAudioClient ActivateDefaultRenderAudioClient()
        {
            var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator
                ?? throw new InvalidOperationException("render_device_enumerator_missing");
            enumerator.GetDefaultAudioEndpoint(EDataFlowRender, ERoleMultimedia, out var device).ThrowIfFailed("GetDefaultAudioEndpoint render");
            var audioClientGuid = IID_IAudioClient;
            device.Activate(ref audioClientGuid, CLSCTX_ALL, IntPtr.Zero, out var audioClientObj).ThrowIfFailed("Activate render audio client");
            return (IAudioClient)audioClientObj;
        }

        private string GetSourceName()
        {
            if (_microphoneMode) return "microphone";
            if (_outputLoopbackMode) return "output_loopback";
            return "process_loopback";
        }

        private static IntPtr BuildDefaultFloatStereoWaveFormatPointer()
        {
            var ptr = Marshal.AllocHGlobal(18);
            Marshal.WriteInt16(ptr, 0, WAVE_FORMAT_IEEE_FLOAT);
            Marshal.WriteInt16(ptr, 2, 2);
            Marshal.WriteInt32(ptr, 4, 48000);
            Marshal.WriteInt32(ptr, 8, 48000 * 2 * sizeof(float));
            Marshal.WriteInt16(ptr, 12, 2 * sizeof(float));
            Marshal.WriteInt16(ptr, 14, 32);
            Marshal.WriteInt16(ptr, 16, 0);
            return ptr;
        }

        private void Drain(Stream stdout, ClientWebSocket? wsClient)
        {
            if (_captureClient == null) return;
            while (true)
            {
                _captureClient.GetNextPacketSize(out var packetFrames).ThrowIfFailed("GetNextPacketSize");
                if (packetFrames == 0) return;
                _captureClient.GetBuffer(out var data, out var frames, out var flags, out _, out _).ThrowIfFailed("GetBuffer");
                try
                {
                    _packetCount++;
                    _frameCount += frames;
                    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0)
                    {
                        _silentPacketCount++;
                    }
                    if (wsClient == null)
                    {
                        WriteFloatStereo(stdout, data, frames, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0);
                    }
                    else
                    {
                        WriteInt16StereoWebSocket(wsClient, data, frames, (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0);
                    }
                }
                finally
                {
                    _captureClient.ReleaseBuffer(frames).ThrowIfFailed("ReleaseBuffer");
                }
            }
        }

        private void WriteInt16StereoWebSocket(ClientWebSocket wsClient, IntPtr data, uint frames, bool silent)
        {
            if (wsClient.State != WebSocketState.Open)
            {
                throw new InvalidOperationException("monitor_audio_websocket_not_open");
            }
            if (silent || data == IntPtr.Zero)
            {
                _writeCount++;
                _lastPeak = 0;
                return;
            }
            var outBytes = new byte[frames * 2 * sizeof(short)];
            var peak = 0.0;
            unsafe
            {
                fixed (byte* outPtr = outBytes)
                {
                    var dst = (short*)outPtr;
                    if (_format.IsFloat && _format.BitsPerSample == 32)
                    {
                        var src = (float*)data;
                        for (var frame = 0; frame < frames; frame++)
                        {
                            var baseIndex = frame * _format.Channels;
                            var left = Math.Clamp(src[baseIndex], -1f, 1f);
                            var right = Math.Clamp(_format.Channels > 1 ? src[baseIndex + 1] : left, -1f, 1f);
                            dst[(frame * 2) + 0] = FloatToInt16(left);
                            dst[(frame * 2) + 1] = FloatToInt16(right);
                            peak = Math.Max(peak, Math.Max(Math.Abs(left), Math.Abs(right)));
                        }
                    }
                    else if (!_format.IsFloat && _format.BitsPerSample == 16)
                    {
                        var src = (short*)data;
                        for (var frame = 0; frame < frames; frame++)
                        {
                            var baseIndex = frame * _format.Channels;
                            var left = src[baseIndex];
                            var right = _format.Channels > 1 ? src[baseIndex + 1] : left;
                            dst[(frame * 2) + 0] = left;
                            dst[(frame * 2) + 1] = right;
                            peak = Math.Max(peak, Math.Max(Math.Abs(left / 32768.0), Math.Abs(right / 32768.0)));
                        }
                    }
                }
            }
            wsClient.SendAsync(outBytes, WebSocketMessageType.Binary, true, CancellationToken.None).GetAwaiter().GetResult();
            _lastPeak = peak;
            _writeCount++;
            _byteCount += outBytes.Length;
        }

        private static short FloatToInt16(float value)
        {
            return value < 0
                ? (short)Math.Round(value * 32768f)
                : (short)Math.Round(value * 32767f);
        }

        private void WriteFloatStereo(Stream stdout, IntPtr data, uint frames, bool silent)
        {
            if (silent || data == IntPtr.Zero)
            {
                _writeCount++;
                _lastPeak = 0;
                return;
            }
            var outBytes = new byte[frames * 2 * sizeof(float)];
            var peak = 0.0;
            unsafe
            {
                fixed (byte* outPtr = outBytes)
                {
                    var dst = (float*)outPtr;
                    if (_format.IsFloat && _format.BitsPerSample == 32)
                    {
                        var src = (float*)data;
                        for (var frame = 0; frame < frames; frame++)
                        {
                            var baseIndex = frame * _format.Channels;
                            var left = src[baseIndex];
                            var right = _format.Channels > 1 ? src[baseIndex + 1] : left;
                            dst[(frame * 2) + 0] = left;
                            dst[(frame * 2) + 1] = right;
                            peak = Math.Max(peak, Math.Max(Math.Abs(left), Math.Abs(right)));
                        }
                    }
                    else if (!_format.IsFloat && _format.BitsPerSample == 16)
                    {
                        var src = (short*)data;
                        for (var frame = 0; frame < frames; frame++)
                        {
                            var baseIndex = frame * _format.Channels;
                            var left = src[baseIndex] / 32768f;
                            var right = _format.Channels > 1 ? src[baseIndex + 1] / 32768f : left;
                            dst[(frame * 2) + 0] = left;
                            dst[(frame * 2) + 1] = right;
                            peak = Math.Max(peak, Math.Max(Math.Abs(left), Math.Abs(right)));
                        }
                    }
                }
            }
            _lastPeak = peak;
            stdout.Write(outBytes, 0, outBytes.Length);
            stdout.Flush();
            _writeCount++;
            _byteCount += outBytes.Length;
        }

        private void WriteDiagnostic()
        {
            Console.Error.WriteLine(
                "{\"diagnostic\":\"capture_stats\",\"pid\":" + _pid +
                ",\"mode\":" + _mode +
                ",\"source\":\"" + GetSourceName() + "\"" +
                ",\"packets\":" + _packetCount +
                ",\"silentPackets\":" + _silentPacketCount +
                ",\"frames\":" + _frameCount +
                ",\"writes\":" + _writeCount +
                ",\"bytes\":" + _byteCount +
                ",\"peak\":" + _lastPeak.ToString(System.Globalization.CultureInfo.InvariantCulture) +
                "}");
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try { _audioClient?.Stop(); } catch { }
            _sampleEvent.Dispose();
            _activateEvent.Dispose();
        }
    }

    private sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler
    {
        private readonly ManualResetEventSlim _event;
        public int ResultHr { get; private set; }
        public object? ActivatedInterface { get; private set; }

        public ActivationHandler(ManualResetEventSlim evt)
        {
            _event = evt;
        }

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            try
            {
                operation.GetActivateResult(out var hr, out var activatedInterface);
                ResultHr = hr;
                ActivatedInterface = activatedInterface;
            }
            finally
            {
                _event.Set();
            }
        }
    }

    private sealed class AudioSessionVolumeResult
    {
        public bool Success { get; init; }
        public int TargetProcessId { get; init; }
        public int MatchedSessions { get; init; }
        public int ChangedSessions { get; init; }
        public double? PreviousVolume { get; init; }
        public double? AppliedVolume { get; init; }
        public string Error { get; init; } = string.Empty;

        public string ToJson()
        {
            static string Number(double? value) => value.HasValue
                ? value.Value.ToString("0.######", System.Globalization.CultureInfo.InvariantCulture)
                : "null";
            return "{\"success\":" + (Success ? "true" : "false") +
                ",\"targetProcessId\":" + TargetProcessId +
                ",\"matchedSessions\":" + MatchedSessions +
                ",\"changedSessions\":" + ChangedSessions +
                ",\"previousVolume\":" + Number(PreviousVolume) +
                ",\"appliedVolume\":" + Number(AppliedVolume) +
                ",\"error\":\"" + JsonEscape(Error) + "\"}";
        }
    }

    private static class AudioSessionVolumeController
    {
        public static AudioSessionVolumeResult ApplyForProcessTree(uint rootPid, double? targetVolume)
        {
            var targetPids = GetProcessTree(rootPid);
            var matched = 0;
            var changed = 0;
            var previousVolumes = new List<double>();
            try
            {
                var enumerator = new MMDeviceEnumerator() as IMMDeviceEnumerator
                    ?? throw new InvalidOperationException("render_device_enumerator_missing");
                enumerator.GetDefaultAudioEndpoint(EDataFlowRender, ERoleMultimedia, out var device).ThrowIfFailed("GetDefaultAudioEndpoint render");
                var managerGuid = IID_IAudioSessionManager2;
                device.Activate(ref managerGuid, CLSCTX_ALL, IntPtr.Zero, out var managerObj).ThrowIfFailed("Activate audio session manager");
                var manager = (IAudioSessionManager2)managerObj;
                manager.GetSessionEnumerator(out var sessionEnumerator).ThrowIfFailed("GetSessionEnumerator");
                sessionEnumerator.GetCount(out var count).ThrowIfFailed("GetCount");

                for (var i = 0; i < count; i++)
                {
                    sessionEnumerator.GetSession(i, out var sessionControl).ThrowIfFailed("GetSession");
                    try
                    {
                        var sessionControl2 = sessionControl as IAudioSessionControl2;
                        if (sessionControl2 == null)
                        {
                            continue;
                        }
                        sessionControl2.GetProcessId(out var sessionPid).ThrowIfFailed("GetProcessId");
                        if (!targetPids.Contains(sessionPid))
                        {
                            continue;
                        }
                        var simpleVolume = sessionControl as ISimpleAudioVolume;
                        if (simpleVolume == null)
                        {
                            continue;
                        }
                        matched++;
                        simpleVolume.GetMasterVolume(out var currentVolume).ThrowIfFailed("GetMasterVolume");
                        previousVolumes.Add(Math.Clamp(currentVolume, 0f, 1f));
                        if (targetVolume.HasValue)
                        {
                            simpleVolume.SetMasterVolume((float)Math.Clamp(targetVolume.Value, 0, 1), Guid.Empty).ThrowIfFailed("SetMasterVolume");
                            changed++;
                        }
                    }
                    finally
                    {
                        if (sessionControl != null)
                        {
                            Marshal.ReleaseComObject(sessionControl);
                        }
                    }
                }

                return new AudioSessionVolumeResult
                {
                    Success = matched > 0,
                    TargetProcessId = (int)rootPid,
                    MatchedSessions = matched,
                    ChangedSessions = changed,
                    PreviousVolume = previousVolumes.Count > 0 ? previousVolumes.Average() : null,
                    AppliedVolume = targetVolume,
                    Error = matched > 0 ? string.Empty : "audio_session_not_found"
                };
            }
            catch (Exception ex)
            {
                return new AudioSessionVolumeResult
                {
                    Success = false,
                    TargetProcessId = (int)rootPid,
                    MatchedSessions = matched,
                    ChangedSessions = changed,
                    PreviousVolume = previousVolumes.Count > 0 ? previousVolumes.Average() : null,
                    AppliedVolume = targetVolume,
                    Error = ex.Message
                };
            }
        }

        private static HashSet<uint> GetProcessTree(uint rootPid)
        {
            var result = new HashSet<uint> { rootPid };
            var parentMap = new Dictionary<uint, List<uint>>();
            var snapshot = CreateToolhelp32Snapshot(0x00000002, 0);
            if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1))
            {
                return result;
            }
            try
            {
                var entry = new PROCESSENTRY32
                {
                    dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>()
                };
                if (!Process32First(snapshot, ref entry))
                {
                    return result;
                }
                do
                {
                    if (!parentMap.TryGetValue(entry.th32ParentProcessID, out var children))
                    {
                        children = new List<uint>();
                        parentMap[entry.th32ParentProcessID] = children;
                    }
                    children.Add(entry.th32ProcessID);
                } while (Process32Next(snapshot, ref entry));
            }
            finally
            {
                CloseHandle(snapshot);
            }

            var queue = new Queue<uint>();
            queue.Enqueue(rootPid);
            while (queue.Count > 0)
            {
                var current = queue.Dequeue();
                if (!parentMap.TryGetValue(current, out var children))
                {
                    continue;
                }
                foreach (var child in children)
                {
                    if (result.Add(child))
                    {
                        queue.Enqueue(child);
                    }
                }
            }
            return result;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariantBlob
    {
        public ushort vt;
        public ushort wReserved1;
        public ushort wReserved2;
        public ushort wReserved3;
        public int blobSize;
        public IntPtr blobData;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AudioClientActivationParams
    {
        public int ActivationType;
        public uint TargetProcessId;
        public int ProcessLoopbackMode;
    }

    private readonly struct WaveFormatInfo
    {
        public readonly int FormatTag;
        public readonly int Channels;
        public readonly int SampleRate;
        public readonly int BitsPerSample;
        public readonly bool IsFloat;

        private WaveFormatInfo(int formatTag, int channels, int sampleRate, int bitsPerSample, bool isFloat)
        {
            FormatTag = formatTag;
            Channels = channels;
            SampleRate = sampleRate;
            BitsPerSample = bitsPerSample;
            IsFloat = isFloat;
        }

        public static WaveFormatInfo CreateDefaultFloatStereo()
        {
            return new WaveFormatInfo(WAVE_FORMAT_IEEE_FLOAT, 2, 48000, 32, true);
        }

        public static WaveFormatInfo FromPointer(IntPtr ptr)
        {
            var tag = Marshal.ReadInt16(ptr, 0) & 0xffff;
            var channels = Marshal.ReadInt16(ptr, 2);
            var sampleRate = Marshal.ReadInt32(ptr, 4);
            var bits = Marshal.ReadInt16(ptr, 14);
            var isFloat = tag == WAVE_FORMAT_IEEE_FLOAT;
            if (tag == WAVE_FORMAT_EXTENSIBLE)
            {
                var subFormatBytes = new byte[16];
                Marshal.Copy(ptr + 24, subFormatBytes, 0, 16);
                isFloat = new Guid(subFormatBytes) == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
            }
            return new WaveFormatInfo(tag, Math.Max(1, (int)channels), sampleRate, bits, isFloat);
        }
    }

    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr pvReserved, int dwCoInit);

    [DllImport("ole32.dll")]
    private static extern void CoUninitialize();

    [DllImport("ole32.dll")]
    private static extern void CoTaskMemFree(IntPtr pv);

    [DllImport("Mmdevapi.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int ActivateAudioInterfaceAsync(
        string deviceInterfacePath,
        ref Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator
    {
    }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig]
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig]
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        [PreserveSig]
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig]
        int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig]
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig]
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);
        [PreserveSig]
        int OpenPropertyStore(int access, out IntPtr properties);
        [PreserveSig]
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig]
        int GetState(out int state);
    }

    [ComImport]
    [Guid("41D949AB-9862-444A-80F6-C261334DA5EB")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    [ComImport]
    [Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig]
        int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport]
    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig]
        int Initialize(int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
        [PreserveSig]
        int GetBufferSize(out uint bufferSize);
        [PreserveSig]
        int GetStreamLatency(out long latency);
        [PreserveSig]
        int GetCurrentPadding(out uint padding);
        [PreserveSig]
        int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr closestMatch);
        [PreserveSig]
        int GetMixFormat(out IntPtr deviceFormat);
        [PreserveSig]
        int GetDevicePeriod(out long defaultDevicePeriod, out long minimumDevicePeriod);
        [PreserveSig]
        int Start();
        [PreserveSig]
        int Stop();
        [PreserveSig]
        int Reset();
        [PreserveSig]
        int SetEventHandle(IntPtr eventHandle);
        [PreserveSig]
        int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport]
    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig]
        int GetBuffer(out IntPtr data, out uint numFramesToRead, out int flags, out long devicePosition, out long qpcPosition);
        [PreserveSig]
        int ReleaseBuffer(uint numFramesRead);
        [PreserveSig]
        int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    [ComImport]
    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2
    {
        [PreserveSig]
        int GetAudioSessionControl(IntPtr audioSessionGuid, int streamFlags, out IAudioSessionControl sessionControl);
        [PreserveSig]
        int GetSimpleAudioVolume(IntPtr audioSessionGuid, int streamFlags, out ISimpleAudioVolume audioVolume);
        [PreserveSig]
        int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnumerator);
        [PreserveSig]
        int RegisterSessionNotification(IntPtr sessionNotification);
        [PreserveSig]
        int UnregisterSessionNotification(IntPtr sessionNotification);
        [PreserveSig]
        int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duckNotification);
        [PreserveSig]
        int UnregisterDuckNotification(IntPtr duckNotification);
    }

    [ComImport]
    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator
    {
        [PreserveSig]
        int GetCount(out int sessionCount);
        [PreserveSig]
        int GetSession(int sessionIndex, out IAudioSessionControl sessionControl);
    }

    [ComImport]
    [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl
    {
        [PreserveSig]
        int GetState(out int state);
        [PreserveSig]
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
        [PreserveSig]
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, Guid eventContext);
        [PreserveSig]
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
        [PreserveSig]
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, Guid eventContext);
        [PreserveSig]
        int GetGroupingParam(out Guid groupingParam);
        [PreserveSig]
        int SetGroupingParam(Guid groupingParam, Guid eventContext);
        [PreserveSig]
        int RegisterAudioSessionNotification(IntPtr notification);
        [PreserveSig]
        int UnregisterAudioSessionNotification(IntPtr notification);
    }

    [ComImport]
    [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2
    {
        [PreserveSig]
        int GetState(out int state);
        [PreserveSig]
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
        [PreserveSig]
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, Guid eventContext);
        [PreserveSig]
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
        [PreserveSig]
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, Guid eventContext);
        [PreserveSig]
        int GetGroupingParam(out Guid groupingParam);
        [PreserveSig]
        int SetGroupingParam(Guid groupingParam, Guid eventContext);
        [PreserveSig]
        int RegisterAudioSessionNotification(IntPtr notification);
        [PreserveSig]
        int UnregisterAudioSessionNotification(IntPtr notification);
        [PreserveSig]
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string retVal);
        [PreserveSig]
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string retVal);
        [PreserveSig]
        int GetProcessId(out uint retVal);
        [PreserveSig]
        int IsSystemSoundsSession();
        [PreserveSig]
        int SetDuckingPreference(bool optOut);
    }

    [ComImport]
    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ISimpleAudioVolume
    {
        [PreserveSig]
        int SetMasterVolume(float level, Guid eventContext);
        [PreserveSig]
        int GetMasterVolume(out float level);
        [PreserveSig]
        int SetMute(bool isMuted, Guid eventContext);
        [PreserveSig]
        int GetMute(out bool isMuted);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}

internal static class HResultExtensions
{
    public static void ThrowIfFailed(this int hr, string operation)
    {
        if (hr < 0)
        {
            var message = Marshal.GetExceptionForHR(hr)?.Message ?? "Unknown HRESULT";
            throw new InvalidOperationException($"{operation} failed: 0x{hr:X8} {message}");
        }
    }
}
