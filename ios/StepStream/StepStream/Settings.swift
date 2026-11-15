import Foundation
import Security

/// Server URL in UserDefaults (not secret); STEPS_TOKEN in the Keychain (secret, stays on this device).
enum Settings {
    private static let urlKey = "serverURL"
    private static let tokenAccount = "STEPS_TOKEN"
    private static let service = "StepStream"

    static var serverURL: String {
        get { UserDefaults.standard.string(forKey: urlKey) ?? "" }
        set { UserDefaults.standard.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: urlKey) }
    }

    /// e.g. https://abc.trycloudflare.com/live-steps (accepts the base URL with or without a trailing slash).
    static var liveStepsURL: URL? {
        var base = serverURL
        while base.hasSuffix("/") { base.removeLast() }
        if base.hasSuffix("/live-steps") { return URL(string: base) }
        guard !base.isEmpty else { return nil }
        return URL(string: base + "/live-steps")
    }

    static var token: String {
        get {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: tokenAccount,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ]
            var item: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
                  let data = item as? Data else { return "" }
            return String(decoding: data, as: UTF8.self)
        }
        set {
            let base: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: tokenAccount,
            ]
            SecItemDelete(base as CFDictionary)
            let value = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { return }
            var add = base
            add[kSecValueData as String] = Data(value.utf8)
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }
}
