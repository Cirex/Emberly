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

  private var host: UIHostingController<TranslatorHostView>?
  private let model = TranslatorModel()
  private var mounted = false

  /**
   * Host the SwiftUI view inside the app's real view hierarchy.
   *
   * This previously lived in its own `UIWindow` at `windowLevel -1000`, behind
   * everything. SwiftUI never ran `.translationTask` for it — the device
   * reported "the system never started a session" on every batch — because a
   * window the compositor never displays doesn't drive the view's update loop.
   * A 1×1, near-transparent child of the key window's root view controller is
   * just as invisible and is genuinely rendered, so the task fires.
   */
  private func mountIfNeeded() async throws {
    guard !mounted else { return }
    guard
      let scene = UIApplication.shared.connectedScenes
        .compactMap({ $0 as? UIWindowScene })
        .first(where: { $0.activationState == .foregroundActive }) ??
        UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
      let root = (scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first)?
        .rootViewController
    else {
      throw NSError(
        domain: "EmberlyTranslate", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "No active window to host translation"]
      )
    }

    let controller = UIHostingController(rootView: TranslatorHostView(model: model))
    controller.view.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
    controller.view.backgroundColor = .clear
    // Fully transparent views can be skipped entirely; keep it renderable.
    controller.view.alpha = 0.01
    controller.view.isUserInteractionEnabled = false
    root.addChild(controller)
    root.view.addSubview(controller.view)
    controller.didMove(toParent: root)
    host = controller
    mounted = true

    // `.translationTask` reacts to a *change* in the configuration it observes.
    // Assigning one in the same turn the view mounts means there is nothing
    // mounted yet to observe it, and the first batch hangs forever. Give
    // SwiftUI a turn to render before any configuration is set.
    await Task.yield()
    try? await Task.sleep(for: .milliseconds(100))
  }

  func translate(_ texts: [String], from: String, to: String) async throws -> [String] {
    if texts.isEmpty { return [] }
    try await mountIfNeeded()
    return try await model.run(texts: texts, from: from, to: to)
  }
}

@available(iOS 18.0, *)
@MainActor
final class TranslatorModel: ObservableObject {
  @Published var configuration: TranslationSession.Configuration?
  private var pending: [String] = []
  private var continuation: CheckedContinuation<[String], Error>?
  /// Distinguishes batches so a watchdog only ever cancels the batch it armed for.
  private var generation = 0

  /// A `.translationTask` that never fires leaves the continuation dangling and
  /// every later batch rejected by the in-flight guard — translation stays dead
  /// until the app restarts, with nothing logged. The watchdog turns that
  /// silence into an error the JS side can report.
  private static let batchTimeout: Duration = .seconds(20)

  /// One batch at a time — set the config, await the session callback.
  func run(texts: [String], from: String, to: String) async throws -> [String] {
    guard continuation == nil else {
      throw NSError(
        domain: "EmberlyTranslate", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "A translation batch is already in flight"]
      )
    }
    pending = texts
    generation &+= 1
    let batch = generation
    return try await withCheckedThrowingContinuation { cont in
      self.continuation = cont
      // `.translationTask` re-runs only when the configuration it observes
      // *changes*. Two Configurations for the same language pair are equal, so
      // assigning a fresh en→es config after the first batch is a no-op — the
      // task never re-fires, the session is never handed over, and every batch
      // after the first hangs until the watchdog trips. Apple's mechanism for
      // re-running the same pair is `invalidate()`; use it whenever a matching
      // configuration is already installed, and only build a new one when the
      // pair actually changes (or on the very first batch).
      let source = Locale.Language(identifier: from)
      let target = Locale.Language(identifier: to)
      if let existing = self.configuration, existing.source == source, existing.target == target {
        // Mutate the stored @Published value in place so the change republishes
        // and `.translationTask` re-fires. invalidate() bumps an internal id
        // that SwiftUI observes even though source/target are unchanged.
        self.configuration?.invalidate()
      } else {
        self.configuration = TranslationSession.Configuration(source: source, target: target)
      }
      Task { [weak self] in
        try? await Task.sleep(for: Self.batchTimeout)
        guard let self, self.generation == batch, self.continuation != nil else { return }
        self.finish(.failure(NSError(
          domain: "EmberlyTranslate", code: 3,
          userInfo: [NSLocalizedDescriptionKey:
            "Translation timed out — the system never started a session for \(from)→\(to)"]
        )))
      }
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
    // Deliberately NOT clearing `configuration`. Nil-ing it here and setting an
    // equal config back on the next batch coalesces to "no change" within a
    // runloop turn, so `.translationTask` never re-fires. The config stays
    // installed and the next batch re-runs it with `invalidate()`.
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
