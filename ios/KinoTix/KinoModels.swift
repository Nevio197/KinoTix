import CryptoKit
import Foundation

struct KinoCatalog: Codable, Sendable, Identifiable, Equatable {
    let version: Int
    let id: String
    let name: String
    let origin: URL
    let index: URL?
    let catalogHosts: [String]
    let playerHosts: [String]
    let mediaHosts: [String]
    let resourceHosts: [String]
    let listing: [String: String]
    let detail: [String: String]
    let player: [String: String]

    init(version: Int = 1, id: String, name: String, origin: URL, index: URL? = nil,
         catalogHosts: [String] = [], playerHosts: [String] = [], mediaHosts: [String],
         resourceHosts: [String] = [], listing: [String: String], detail: [String: String],
         player: [String: String] = [:]) {
        self.version = version
        self.id = id
        self.name = name
        self.origin = origin
        self.index = index
        self.catalogHosts = catalogHosts
        self.playerHosts = playerHosts
        self.mediaHosts = mediaHosts
        self.resourceHosts = resourceHosts
        self.listing = listing
        self.detail = detail
        self.player = player
    }

    init(from decoder: Decoder) throws {
        let data = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            version: try data.decode(Int.self, forKey: .version),
            id: try data.decode(String.self, forKey: .id),
            name: try data.decode(String.self, forKey: .name),
            origin: try data.decode(URL.self, forKey: .origin),
            index: try data.decodeIfPresent(URL.self, forKey: .index),
            catalogHosts: try data.decodeIfPresent([String].self, forKey: .catalogHosts) ?? [],
            playerHosts: try data.decodeIfPresent([String].self, forKey: .playerHosts) ?? [],
            mediaHosts: try data.decode([String].self, forKey: .mediaHosts),
            resourceHosts: try data.decodeIfPresent([String].self, forKey: .resourceHosts) ?? [],
            listing: try data.decode([String: String].self, forKey: .listing),
            detail: try data.decode([String: String].self, forKey: .detail),
            player: try data.decodeIfPresent([String: String].self, forKey: .player) ?? [:]
        )
    }
}

struct KinoTitle: Identifiable, Codable, Sendable, Hashable {
    let id: String
    let name: String
    let poster: URL?
    let provider: String
    let isSeries: Bool
    let catalogID: String?
    let url: URL?
}

struct KinoDetail: Sendable {
    let title: KinoTitle
    let description: String
    let episodes: [KinoEpisode]
}

struct KinoEpisode: Identifiable, Sendable, Hashable {
    let id: String
    let season: Int
    let number: Int
    let links: [URL]
}

struct KinoPlayback: Identifiable, Sendable {
    let id = UUID()
    let title: KinoTitle
    let episode: KinoEpisode
    let url: URL
    let resumeTime: Double
}

struct KinoResume: Identifiable, Sendable {
    let id: String
    let title: KinoTitle
    let season: Int
    let episode: Int
    let seconds: Double
}

struct KinoCatalogReference: Codable, Sendable {
    let url: String
    let title: String
    let season: Int
    let episode: Int
    let isSeries: Bool
}

struct KinoSyncValue: Codable, Sendable {
    var source: KinoCatalog? = nil
    var url: URL? = nil
    var title: String? = nil
    var removed: Bool? = nil
    var time: Double? = nil
    var duration: Double? = nil
    var finished: Bool? = nil
    var catalog: KinoCatalogReference? = nil
}

struct KinoSyncRow: Codable, Sendable {
    let kind: String
    let itemID: String
    let updatedAt: Int64
    let value: KinoSyncValue

    enum CodingKeys: String, CodingKey {
        case kind, value
        case itemID = "item_id"
        case updatedAt = "updated_at"
    }

    var key: String { kind + ":" + itemID }
}

enum KinoAddress {
    private static let privateParameters: Set<String> = [
        "authorization", "token", "auth", "key", "secret", "signature", "sig", "credential",
        "password", "jwt", "expires", "session", "policy", "accesstoken", "accesskey",
        "refreshtoken", "authkey", "apikey", "hdnea", "hdnts"
    ]

    static func https(_ text: String) -> URL? {
        guard text.utf8.count <= 4096,
              let decoded = text.removingPercentEncoding,
              !decoded.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              !text.contains("\\"),
              var parts = URLComponents(string: text),
              parts.scheme?.lowercased() == "https",
              let host = parts.host?.lowercased(),
              host.range(of: #"^[a-z0-9.-]{1,253}$"#, options: .regularExpression) != nil,
              parts.user == nil, parts.password == nil, parts.fragment == nil,
              parts.port.map({ (1...65535).contains($0) }) != false else { return nil }
        parts.scheme = "https"
        parts.host = host
        if parts.port == 443 { parts.port = nil }
        if parts.percentEncodedPath.isEmpty { parts.percentEncodedPath = "/" }
        return parts.url
    }

    static func shareable(_ url: URL) -> Bool {
        guard let canonical = https(url.absoluteString), canonical == url else { return false }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery ?? ""
        for field in query.split(whereSeparator: { $0 == "&" || $0 == ";" }) {
            let raw = String(field.prefix(while: { $0 != "=" }))
            guard let key = raw.removingPercentEncoding?.lowercased() else { return false }
            let parts = key.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            if key.hasPrefix("x-amz-") || key.hasPrefix("x-goog-") ||
                privateParameters.contains(parts.joined()) ||
                parts.contains(where: { privateParameters.contains(String($0)) }) { return false }
        }
        return true
    }

    static func mediaID(_ value: String) -> String {
        "media:" + SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func episodeID(_ titleID: String, _ season: Int, _ episode: Int) -> String {
        mediaID("\(titleID)|\(season)|\(episode)")
    }

    static func catalogPath(_ id: String, for catalog: KinoCatalog) -> String? {
        let prefix = "catalog:" + catalog.id + ":"
        guard id.hasPrefix(prefix) else { return nil }
        let value = String(id.dropFirst(prefix.count))
        guard value.count <= 1400, value.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else { return nil }
        let base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let data = Data(base64Encoded: base64 + String(repeating: "=", count: (4 - base64.count % 4) % 4)),
              let path = String(data: data, encoding: .utf8), path.hasPrefix("/"), !path.hasPrefix("//"),
              path.range(of: #"[?#\\\x00-\x20]"#, options: .regularExpression) == nil else { return nil }
        return path
    }
}
