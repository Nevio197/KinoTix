import CryptoKit
import Foundation
import Security

struct KinoAccountIdentity: Codable, Sendable {
    let id: String
    let email: String
}

struct KinoSignInChallenge: Sendable {
    let url: URL
}

actor KinoAccountClient {
    private struct Configuration: Decodable {
        let url: String
        let publishableKey: String

        static func load() -> Self? {
            guard let file = Bundle.main.url(forResource: "Supabase", withExtension: "json"),
                  let data = try? Data(contentsOf: file),
                  let config = try? JSONDecoder().decode(Self.self, from: data),
                  let url = URLComponents(string: config.url),
                  url.scheme == "https", url.port == nil, url.user == nil, url.password == nil,
                  url.query == nil, url.fragment == nil, ["", "/"].contains(url.path),
                  let host = url.host,
                  host.range(of: #"^[a-z0-9-]+\.supabase\.co$"#, options: .regularExpression) != nil,
                  config.publishableKey.range(of: #"^sb_publishable_[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil
            else { return nil }
            return Self(url: "https://" + host, publishableKey: config.publishableKey)
        }
    }

    private enum Failure: LocalizedError {
        case unconfigured, invalidResponse, unavailable, tooLarge, credentials, signedOut, alreadySignedIn, pairingExpired
        case http(Int)

        var errorDescription: String? {
            switch self {
            case .unconfigured: "Das KinoTix-Konto ist für diesen Build noch nicht eingerichtet."
            case .invalidResponse: "Der KinoTix-Kontodienst hat keine gültige Antwort geliefert."
            case .unavailable: "Der KinoTix-Kontodienst ist gerade nicht erreichbar."
            case .tooLarge: "Die Antwort des KinoTix-Kontodienstes ist zu groß."
            case .credentials: "Die Anmeldung konnte nicht sicher gespeichert oder geöffnet werden."
            case .signedOut: "Die Anmeldung ist nicht mehr aktiv."
            case .alreadySignedIn: "Ein Google-Konto ist bereits angemeldet."
            case .pairingExpired: "Die Anmeldung ist abgelaufen. Starte sie erneut."
            case .http(let status): "Der KinoTix-Kontodienst ist gerade nicht verfügbar (HTTP \(status))."
            }
        }
    }

    private struct Tokens: Decodable {
        let access_token: String
        let refresh_token: String
        let expires_in: Int
    }

    private struct Session: Sendable {
        let identity: KinoAccountIdentity
        let refresh: String
        let access: String
        let expiresAt: Date
    }

    private struct StoredSession: Codable {
        let origin: String
        let identity: KinoAccountIdentity
        let refresh: String
    }

    private struct PairingTicket: Decodable {
        let id: String
        let url: String
        let expiresIn: Int
    }

    private struct PairingStatus: Decodable {
        let status: String
        let code: String?
    }

    private struct Pairing {
        let id: String
        let verifier: String
        let readToken: String
        let expiry: Date
    }

    private struct Merge: Encodable {
        let p_items: [KinoSyncRow]
    }

    private final class RejectRedirects: NSObject, URLSessionTaskDelegate, Sendable {
        func urlSession(
            _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest
        ) async -> URLRequest? { nil }
    }

    private static let pairingPath = "/functions/v1/kinotix-tv-auth"
    private static let maximumResponse = 4 * 1024 * 1024
    private let config: Configuration?
    private let transport: URLSession
    private let keychainService = (Bundle.main.bundleIdentifier ?? "de.kinotix.ios") + ".account-v1"
    nonisolated let configured: Bool

    private var activeSession: Session?
    private var pairing: Pairing?
    private var awaitingConfirmation: Session?
    private var starting: UUID?
    private var polling: UUID?
    private var generation = UUID()
    private var refreshFlight: (id: UUID, task: Task<Session, Error>)?

    init() {
        let config = Configuration.load()
        self.config = config
        self.configured = config != nil
        let session = URLSessionConfiguration.ephemeral
        session.httpShouldSetCookies = false
        session.urlCredentialStorage = nil
        session.urlCache = nil
        session.requestCachePolicy = .reloadIgnoringLocalCacheData
        session.timeoutIntervalForRequest = 8
        session.timeoutIntervalForResource = 12
        self.transport = URLSession(configuration: session, delegate: RejectRedirects(), delegateQueue: nil)
    }

    deinit { transport.invalidateAndCancel() }

    func restore() async throws -> KinoAccountIdentity? {
        guard let config else { return nil }
        if let activeSession { return activeSession.identity }
        if pairing != nil || starting != nil { return nil }
        guard let data = try savedCredentials() else { return nil }
        let saved = try JSONDecoder().decode(StoredSession.self, from: data)
        guard saved.origin == config.url else { return nil }
        let identity = try Self.checkedIdentity(saved.identity)
        guard Self.validToken(saved.refresh) else { throw Failure.credentials }
        activeSession = Session(identity: identity, refresh: saved.refresh, access: "", expiresAt: .distantPast)
        return identity
    }

    func beginSignIn() async throws -> KinoSignInChallenge {
        guard let config else { throw Failure.unconfigured }
        guard activeSession == nil else { throw Failure.alreadySignedIn }
        cancelSignIn()
        let attempt = generation
        starting = attempt
        defer { if starting == attempt { starting = nil } }
        let verifier = try Self.randomToken()
        let readToken = try Self.randomToken()
        let body = ["challenge": Self.digest(verifier), "readHash": Self.digest(readToken)]
        let start = try await post(Self.pairingPath + "/start", body)
        try ensureCurrent(attempt)
        let ticket = try JSONDecoder().decode(PairingTicket.self, from: start)
        let urlPrefix = config.url + Self.pairingPath + "/login/" + ticket.id + "/"
        guard ticket.expiresIn > 0, ticket.expiresIn <= 300,
              Self.matches(ticket.id, #"^[A-Za-z0-9_-]{22}$"#), ticket.url.hasPrefix(urlPrefix),
              Self.matches(String(ticket.url.dropFirst(urlPrefix.count)), #"^[A-Za-z0-9_-]{43}$"#),
              let url = URL(string: ticket.url)
        else { throw Failure.invalidResponse }
        pairing = Pairing(
            id: ticket.id, verifier: verifier, readToken: readToken,
            expiry: Date().addingTimeInterval(TimeInterval(ticket.expiresIn))
        )
        return KinoSignInChallenge(url: url)
    }

    func pollSignIn() async throws -> String? {
        guard let pairing else { return nil }
        guard pairing.expiry > Date() else {
            cancelSignIn()
            throw Failure.pairingExpired
        }
        if let awaitingConfirmation { return awaitingConfirmation.identity.email }
        guard polling == nil else { return nil }
        let attempt = generation
        polling = attempt
        defer { if polling == attempt { polling = nil } }
        let data: Data
        do {
            data = try await post(Self.pairingPath + "/poll", ["id": pairing.id, "readToken": pairing.readToken])
        } catch Failure.http(429) {
            return nil
        } catch Failure.http(410) {
            try ensureCurrent(attempt)
            cancelSignIn()
            throw Failure.pairingExpired
        }
        try ensureCurrent(attempt)
        let status = try JSONDecoder().decode(PairingStatus.self, from: data)
        if status.status == "pending" { return nil }
        if status.status == "expired" {
            cancelSignIn()
            throw Failure.pairingExpired
        }
        guard status.status == "ready", let code = status.code,
              Self.matches(code, #"^[A-Za-z0-9._~-]{8,512}$"#) else { throw Failure.invalidResponse }
        let tokens = try await exchangeToken("pkce", body: ["auth_code": code, "code_verifier": pairing.verifier])
        do {
            try ensureCurrent(attempt)
            let verified = try await verify(tokens, expectedOwner: nil)
            try ensureCurrent(attempt)
            guard pairing.expiry > Date() else {
                cancelSignIn()
                throw Failure.pairingExpired
            }
            awaitingConfirmation = verified
            return verified.identity.email
        } catch {
            await revoke(tokens.access_token)
            throw error
        }
    }

    func confirmSignIn() async throws -> KinoAccountIdentity {
        guard let awaitingConfirmation, let pairing, pairing.expiry > Date() else {
            cancelSignIn()
            throw Failure.pairingExpired
        }
        try storeCredentials(awaitingConfirmation)
        activeSession = awaitingConfirmation
        self.awaitingConfirmation = nil
        self.pairing = nil
        return awaitingConfirmation.identity
    }

    func cancelSignIn() {
        guard activeSession == nil else { return }
        generation = UUID()
        pairing = nil
        starting = nil
        polling = nil
        if let token = awaitingConfirmation?.access {
            Task { await revoke(token) }
        }
        awaitingConfirmation = nil
    }

    func signOut() async throws {
        let status = SecItemDelete(keychainQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.credentials }
        let endedSession = activeSession
        cancelSignIn()
        generation = UUID()
        activeSession = nil
        let refresh = refreshFlight?.task
        refreshFlight = nil
        if let endedSession {
            Task {
                if let refresh, let renewed = try? await refresh.value {
                    await revoke(renewed.access)
                } else if endedSession.expiresAt > Date() {
                    await revoke(endedSession.access)
                } else if let tokens = try? await exchangeToken("refresh_token", body: ["refresh_token": endedSession.refresh]) {
                    await revoke(tokens.access_token)
                }
            }
        }
    }

    func readRows(for ownerID: String? = nil) async throws -> [KinoSyncRow] {
        let attempt = generation
        let kinds = [("catalog", 100, 100), ("media", 250, 5_000), ("progress", 500, 5_000)]
        var result: [KinoSyncRow] = []
        for (kind, count, maximum) in kinds {
            for offset in stride(from: 0, to: maximum, by: count) {
                let query = [
                    URLQueryItem(name: "select", value: "kind,item_id,updated_at,value"),
                    URLQueryItem(name: "kind", value: "eq." + kind),
                    URLQueryItem(name: "order", value: "updated_at.desc,item_id.asc"),
                    URLQueryItem(name: "limit", value: String(count)),
                    URLQueryItem(name: "offset", value: String(offset)),
                ]
                let data = try await syncRequest(
                    "/rest/v1/kinotix_sync", query: query, ownerID: ownerID, attempt: attempt
                )
                let page = try JSONDecoder().decode([KinoSyncRow].self, from: data)
                guard page.count <= count else { throw Failure.invalidResponse }
                result.append(contentsOf: page.filter { $0.kind == kind })
                if page.count < count { break }
            }
        }
        return result
    }

    func writeRows(_ rows: [KinoSyncRow], for ownerID: String? = nil) async throws {
        let attempt = generation
        for offset in stride(from: 0, to: rows.count, by: 100) {
            let batch = Array(rows[offset..<min(offset + 100, rows.count)])
            let body = try JSONEncoder().encode(Merge(p_items: batch))
            _ = try await syncRequest("/rest/v1/rpc/kinotix_merge", body: body, ownerID: ownerID, attempt: attempt)
        }
    }

    private func syncRequest(
        _ path: String, query: [URLQueryItem] = [], body: Data? = nil, ownerID: String?, attempt: UUID
    ) async throws -> Data {
        let initial = try await currentSession(ownerID: ownerID, attempt: attempt)
        let result: Data
        do {
            result = try await request(path, query: query, body: body, access: initial.access)
        } catch Failure.http(401) {
            let renewed = try await currentSession(ownerID: ownerID, attempt: attempt, rejected: initial.access)
            result = try await request(path, query: query, body: body, access: renewed.access)
        }
        try ensureCurrent(attempt)
        return result
    }

    private func currentSession(ownerID: String?, attempt: UUID, rejected: String? = nil) async throws -> Session {
        try ensureCurrent(attempt)
        guard let session = activeSession, ownerID == nil || ownerID == session.identity.id else { throw Failure.signedOut }
        if session.expiresAt.timeIntervalSinceNow > 60, session.access != rejected { return session }
        let flight: (id: UUID, task: Task<Session, Error>)
        if let refreshFlight {
            flight = refreshFlight
        } else {
            let task = Task {
                let tokens = try await exchangeToken("refresh_token", body: ["refresh_token": session.refresh])
                return try await verify(tokens, expectedOwner: session.identity.id)
            }
            flight = (UUID(), task)
            refreshFlight = flight
        }
        do {
            let renewed = try await flight.task.value
            try ensureCurrent(attempt)
            if refreshFlight?.id == flight.id {
                try storeCredentials(renewed)
                activeSession = renewed
                refreshFlight = nil
            }
            guard let activeSession else { throw Failure.signedOut }
            return activeSession
        } catch {
            if refreshFlight?.id == flight.id { refreshFlight = nil }
            throw error
        }
    }

    private func ensureCurrent(_ attempt: UUID) throws {
        guard attempt == generation else { throw Failure.signedOut }
    }

    private func exchangeToken(_ grant: String, body: [String: String]) async throws -> Tokens {
        let payload = try JSONEncoder().encode(body)
        let result = try await request(
            "/auth/v1/token", query: [URLQueryItem(name: "grant_type", value: grant)], body: payload
        )
        let tokens = try JSONDecoder().decode(Tokens.self, from: result)
        guard Self.validToken(tokens.access_token), Self.validToken(tokens.refresh_token),
              (1...86_400).contains(tokens.expires_in)
        else { throw Failure.invalidResponse }
        return tokens
    }

    private func verify(_ tokens: Tokens, expectedOwner: String?) async throws -> Session {
        let data = try await request("/auth/v1/user", access: tokens.access_token)
        let owner = try Self.checkedIdentity(JSONDecoder().decode(KinoAccountIdentity.self, from: data))
        guard expectedOwner == nil || expectedOwner == owner.id else { throw Failure.invalidResponse }
        return Session(
            identity: owner, refresh: tokens.refresh_token, access: tokens.access_token,
            expiresAt: Date().addingTimeInterval(TimeInterval(tokens.expires_in))
        )
    }

    private func revoke(_ access: String) async {
        guard Self.validToken(access) else { return }
        _ = try? await request(
            "/auth/v1/logout", query: [URLQueryItem(name: "scope", value: "local")],
            body: Data(), access: access
        )
    }

    private func post(_ path: String, _ values: [String: String]) async throws -> Data {
        try await request(path, body: JSONEncoder().encode(values))
    }

    private func request(
        _ path: String, query: [URLQueryItem] = [], body: Data? = nil, access: String? = nil
    ) async throws -> Data {
        guard let config, var target = URLComponents(string: config.url) else { throw Failure.unconfigured }
        target.path = path
        target.queryItems = query.isEmpty ? nil : query
        guard let url = target.url else { throw Failure.invalidResponse }
        guard body?.count ?? 0 <= Self.maximumResponse else { throw Failure.tooLarge }
        var request = URLRequest(url: url)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue(config.publishableKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let access { request.setValue("Bearer " + access, forHTTPHeaderField: "Authorization") }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw Failure.unavailable
        }
        guard let http = response as? HTTPURLResponse, http.url == url else { throw Failure.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw Failure.http(http.statusCode) }
        guard data.count <= Self.maximumResponse else { throw Failure.tooLarge }
        return data
    }

    private func keychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: "supabase-session",
        ]
    }

    private func savedCredentials() throws -> Data? {
        var query = keychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw Failure.credentials }
        return data
    }

    private func storeCredentials(_ session: Session) throws {
        guard let config else { throw Failure.unconfigured }
        let saved = StoredSession(origin: config.url, identity: session.identity, refresh: session.refresh)
        let data = try JSONEncoder().encode(saved)
        let query = keychainQuery()
        let fields: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, fields as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(fields) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw Failure.credentials }
    }

    private static func checkedIdentity(_ raw: KinoAccountIdentity) throws -> KinoAccountIdentity {
        guard let id = UUID(uuidString: raw.id), raw.email.contains("@"), raw.email.utf8.count <= 320,
              raw.email.rangeOfCharacter(from: .controlCharacters) == nil
        else { throw Failure.invalidResponse }
        return KinoAccountIdentity(id: id.uuidString.lowercased(), email: raw.email)
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        guard let match = text.range(of: pattern, options: .regularExpression) else { return false }
        return match == text.startIndex..<text.endIndex
    }

    private static func validToken(_ token: String) -> Bool {
        matches(token, #"^[A-Za-z0-9._~-]{8,16384}$"#)
    }

    private static func randomToken() throws -> String {
        var bytes = Data(count: 32)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw Failure.credentials }
        return base64URL(bytes)
    }

    private static func digest(_ token: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(token.utf8))))
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
