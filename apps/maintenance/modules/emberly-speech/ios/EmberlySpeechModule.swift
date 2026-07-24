import AVFoundation
import ExpoModulesCore
import Speech

/**
 * On-device dictation for the work-order notes editor.
 *
 * `requiresOnDeviceRecognition` is set unconditionally and the module refuses
 * to start when the locale can't satisfy it. Maintenance notes name residents
 * and units, so shipping that audio to Apple's servers for transcription is not
 * a trade this app makes — a locale without an on-device model reports
 * unavailable instead of quietly falling back to the network.
 *
 * Emits:
 *   onResult { text, isFinal }  — partial transcripts as they firm up
 *   onError  { message }        — recognition or audio-session failure
 */
public final class EmberlySpeechModule: Module {
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private let engine = AVAudioEngine()
  /// Guards start/stop against overlapping calls from the JS side.
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("EmberlySpeech")

    Events("onResult", "onError")

    /**
     * Whether dictation can run for `locale` right now:
     *   "ready"        — permission granted and an on-device model is present
     *   "needsPermission" — usable, but speech/mic access hasn't been granted
     *   "unsupported"  — no recognizer, or no on-device model for this locale
     */
    AsyncFunction("availability") { (locale: String) -> String in
      guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
            recognizer.isAvailable else {
        return "unsupported"
      }
      if #available(iOS 13.0, *), !recognizer.supportsOnDeviceRecognition {
        // Network recognition would work here — deliberately not offered.
        return "unsupported"
      }
      let speech = SFSpeechRecognizer.authorizationStatus()
      let mic = AVAudioSession.sharedInstance().recordPermission
      if speech == .authorized && mic == .granted { return "ready" }
      if speech == .denied || speech == .restricted || mic == .denied { return "denied" }
      return "needsPermission"
    }

    /** Prompt for speech + microphone access. Resolves to the same vocabulary
     *  as `availability`. */
    AsyncFunction("requestPermissions") { (promise: Promise) in
      SFSpeechRecognizer.requestAuthorization { speechStatus in
        guard speechStatus == .authorized else {
          promise.resolve(speechStatus == .notDetermined ? "needsPermission" : "denied")
          return
        }
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
          promise.resolve(granted ? "ready" : "denied")
        }
      }
    }

    AsyncFunction("start") { (locale: String) in
      try self.start(locale: locale)
    }

    AsyncFunction("stop") {
      self.stop()
    }

    OnDestroy {
      self.stop()
    }
  }

  private func start(locale: String) throws {
    lock.lock()
    defer { lock.unlock() }

    // Restarting over a live session leaks the engine's tap; tear down first.
    teardown()

    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
          recognizer.isAvailable else {
      throw Exception(name: "ERR_SPEECH_UNAVAILABLE", description: "No speech recognizer for \(locale)")
    }
    if #available(iOS 13.0, *), !recognizer.supportsOnDeviceRecognition {
      throw Exception(
        name: "ERR_SPEECH_NOT_ON_DEVICE",
        description: "No on-device model for \(locale); network recognition is not permitted here"
      )
    }
    self.recognizer = recognizer

    let audioSession = AVAudioSession.sharedInstance()
    // .measurement keeps iOS from applying its own processing to the input,
    // which meaningfully helps accuracy in a mechanical room.
    try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
    try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    if #available(iOS 13.0, *) { request.requiresOnDeviceRecognition = true }
    // Unit numbers and part codes are dictated as strings of digits and
    // letters; punctuation guessing mangles them more often than it helps.
    if #available(iOS 16.0, *) { request.addsPunctuation = false }
    self.request = request

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.request?.append(buffer)
    }

    engine.prepare()
    try engine.start()

    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      guard let self else { return }
      if let result {
        self.sendEvent("onResult", [
          "text": result.bestTranscription.formattedString,
          "isFinal": result.isFinal,
        ])
        if result.isFinal { self.stop() }
      }
      if let error {
        // A cancelled task on an intentional stop is not an error worth
        // surfacing — the JS side already knows it stopped.
        let nsError = error as NSError
        let cancelled = nsError.domain == "kAFAssistantErrorDomain" && nsError.code == 216
        if !cancelled {
          self.sendEvent("onError", ["message": error.localizedDescription])
        }
        self.stop()
      }
    }
  }

  private func stop() {
    lock.lock()
    defer { lock.unlock() }
    teardown()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  /// Caller holds `lock`.
  private func teardown() {
    if engine.isRunning {
      engine.stop()
      engine.inputNode.removeTap(onBus: 0)
    }
    request?.endAudio()
    task?.cancel()
    task = nil
    request = nil
  }
}
