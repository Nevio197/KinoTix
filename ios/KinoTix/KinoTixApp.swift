import Network
import SwiftUI

@main
struct KinoTixApp: App {
    @StateObject private var store: KinoStore

    init() {
        if let resolver = URL(string: "https://cloudflare-dns.com/dns-query") {
            let addresses: [NWEndpoint] = [
                .hostPort(host: "1.1.1.1", port: .https),
                .hostPort(host: "1.0.0.1", port: .https),
                .hostPort(host: "2606:4700:4700::1111", port: .https)
            ]
            NWParameters.PrivacyContext.default.requireEncryptedNameResolution(
                true, fallbackResolver: .https(resolver, serverAddresses: addresses)
            )
        }
        _store = StateObject(wrappedValue: KinoStore())
    }

    var body: some Scene {
        WindowGroup { KinoTixRootView(store: store) }
    }
}
