import ExpoModulesCore
import SwiftUI
import Translation

/**
 * EmberlyTranslate — on-device batch translation of work-order prose via Apple's
 * Translation framework (iOS 18+).
 *
 * Apple vends a `TranslationSession` only through the SwiftUI `.translationTask`
 * modifier — there is no headless initializer — so this hosts a 1×1 offscreen
 * SwiftUI view whose task closure receives the session and runs the batch. The
 * app foregrounds during sync (which is when the JS side calls this), so a
 * window scene is available. Everything is gated to iOS 18; older systems and
 * missing language packs surface as errors and the JS falls back to English.
 *
 * ⚠️ ON-DEVICE VERIFICATION NEEDED: the offscreen-hosting + `TranslationSession`
 * batch path can only be confirmed on a real iOS 18 device/simulator with the
 * es⇄en language pack. Treat this as the spike to validate before relying on it.
 */
public class EmberlyTranslateModule: Module {
  public func definition() -> ModuleDefinition {
    Name("EmberlyTranslate")

    AsyncFunction("availability") { (from: String, to: String, promise: Promise) in
      guard #available(iOS 18.0, *) else {
        promise.resolve("unsupported")
        return
      }
      Task {
        let status = await LanguageAvailability().status(
          from: Locale.Language(identifier: from),
          to: Locale.Language(identifier: to)
        )
        switch status {
        case .installed: promise.resolve("installed")
        case .supported: promise.resolve("supported")
        case .unsupported: promise.resolve("unsupported")
        @unknown default: promise.resolve("unsupported")
        }
      }
    }

    AsyncFunction("translateBatch") { (texts: [String], from: String, to: String, promise: Promise) in
      guard #available(iOS 18.0, *) else {
        promise.reject("ERR_UNSUPPORTED", "On-device translation requires iOS 18")
        return
      }
      Task { @MainActor in
        do {
          let output = try await TranslationCoordinator.shared.translate(texts, from: from, to: to)
          promise.resolve(output)
        } catch {
          promise.reject("ERR_TRANSLATE", error.localizedDescription)
        }
      }
    }
  }
}

// MARK: - Coordinator (offscreen SwiftUI host driving TranslationSession)

@available(iOS 18.0, *)
@MainActor
final class TranslationCoordinator {
  static let shared = TranslationCoordinator()

  private var window: UIWindow?
  private let model = TranslatorModel()
  private var mounted = false

  /// Keep a 1×1 offscreen window so the SwiftUI `.translationTask` actually runs
  /// without ever being visible. Mounted lazily on first use.
  private func mountIfNeeded() throws {
    guard !mounted else { return }
    guard
      let scene = UIApplication.shared.connectedScenes
        .compactMap({ $0 as? UIWindowScene })
        .first(where: { $0.activationState == .foregroundActive }) ??
        UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first
    else {
      throw NSError(
        domain: "EmberlyTranslate", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "No active window scene to host translation"]
      )
    }
    let host = UIHostingController(rootView: TranslatorHostView(model: model))
    host.view.backgroundColor = .clear
    let w = UIWindow(windowScene: scene)
    w.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
    w.rootViewController = host
    w.windowLevel = UIWindow.Level(rawValue: -1000) // behind everything
    w.isUserInteractionEnabled = false
    w.isHidden = false
    window = w
    mounted = true
  }

  func translate(_ texts: [String], from: String, to: String) async throws -> [String] {
    if texts.isEmpty { return [] }
    try mountIfNeeded()
    return try await model.run(texts: texts, from: from, to: to)
  }
}

@available(iOS 18.0, *)
@MainActor
final class TranslatorModel: ObservableObject {
  @Published var configuration: TranslationSession.Configuration?
  private var pending: [String] = []
  private var continuation: CheckedContinuation<[String], Error>?

  /// One batch at a time — set the config, await the session callback.
  func run(texts: [String], from: String, to: String) async throws -> [String] {
    guard continuation == nil else {
      throw NSError(
        domain: "EmberlyTranslate", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "A translation batch is already in flight"]
      )
    }
    pending = texts
    return try await withCheckedThrowingContinuation { cont in
      self.continuation = cont
      // Assigning a fresh config triggers `.translationTask` to hand us a session.
      self.configuration = TranslationSession.Configuration(
        source: Locale.Language(identifier: from),
        target: Locale.Language(identifier: to)
      )
    }
  }

  /// Called from the SwiftUI task closure with a live session.
  func perform(with session: TranslationSession) async {
    let requests = pending.enumerated().map { index, text in
      TranslationSession.Request(sourceText: text, clientIdentifier: String(index))
    }
    do {
      // A `supported` pair translates only after its language pack is on the
      // device, and nothing downloads it implicitly — without this, a tech who
      // has never used Apple Translate gets English prose forever and no error
      // they can see. `prepareTranslation` presents the system download prompt
      // and is a no-op once the pack is installed, so it is safe every batch.
      try await session.prepareTranslation()
      let responses = try await session.translations(from: requests)
      var byIndex: [Int: String] = [:]
      for response in responses {
        if let id = response.clientIdentifier, let index = Int(id) {
          byIndex[index] = response.targetText
        }
      }
      // Preserve input order; fall back to the source for any missing response.
      let ordered = (0..<pending.count).map { byIndex[$0] ?? pending[$0] }
      finish(.success(ordered))
    } catch {
      finish(.failure(error))
    }
  }

  private func finish(_ result: Result<[String], Error>) {
    let cont = continuation
    continuation = nil
    configuration = nil
    pending = []
    switch result {
    case .success(let value): cont?.resume(returning: value)
    case .failure(let error): cont?.resume(throwing: error)
    }
  }
}

@available(iOS 18.0, *)
struct TranslatorHostView: View {
  @ObservedObject var model: TranslatorModel

  var body: some View {
    Color.clear
      .translationTask(model.configuration) { session in
        await model.perform(with: session)
      }
  }
}
