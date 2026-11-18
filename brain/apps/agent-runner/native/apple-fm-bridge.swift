import Foundation
import FoundationModels

struct CheckOutput: Encodable {
    let available: Bool
    let macOsVersion: String
    let model: String
    let reason: String?
}

struct PromptOutput: Encodable {
    let content: String
    let model: String
    let macOsVersion: String
    let durationMs: Int
}

struct ErrorOutput: Encodable {
    let error: String
}

func macOsVersionString() -> String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

func availabilityReason(_ availability: SystemLanguageModel.Availability) -> String? {
    switch availability {
    case .available:
        return nil
    case .unavailable(let reason):
        return String(describing: reason)
    @unknown default:
        return "unknown"
    }
}

func printJson<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(value), let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

@main
struct AppleFmBridge {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        let osVer = macOsVersionString()
        let modelId = "apple-foundation-model:macos-\(osVer)"
        let model = SystemLanguageModel.default

        if args.contains("--check") {
            let reason = availabilityReason(model.availability)
            printJson(CheckOutput(
                available: reason == nil,
                macOsVersion: osVer,
                model: modelId,
                reason: reason
            ))
            exit(reason == nil ? 0 : 2)
        }

        var promptText: String? = nil
        if let idx = args.firstIndex(of: "--prompt"), idx + 1 < args.count {
            promptText = args[idx + 1]
        } else if args.contains("--stdin") {
            let inputData = FileHandle.standardInput.readDataToEndOfFile()
            promptText = String(data: inputData, encoding: .utf8)
        }

        guard let prompt = promptText?.trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty else {
            printJson(ErrorOutput(error: "Prompt is required (--prompt <text> or --stdin)."))
            exit(1)
        }

        if let reason = availabilityReason(model.availability) {
            printJson(ErrorOutput(error: "Apple Foundation Model unavailable: \(reason)"))
            exit(2)
        }

        let start = Date()
        do {
            let session = LanguageModelSession(
                instructions: "You are Brain Brain Runner operating in draft-only mode. Provide concise, accurate draft analysis without claiming to modify files or run commands."
            )
            let response = try await session.respond(to: prompt)
            let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
            printJson(PromptOutput(
                content: response.content,
                model: modelId,
                macOsVersion: osVer,
                durationMs: max(0, elapsedMs)
            ))
        } catch {
            printJson(ErrorOutput(error: String(describing: error)))
            exit(1)
        }
    }
}

