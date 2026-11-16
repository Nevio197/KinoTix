import Foundation
import SwiftSoup

actor KinoCatalogClient {
    private let session: URLSession
    private var shelves: [String: (catalog: KinoCatalog, expires: Date, titles: [KinoTitle])] = [:]
    private var lastIndex: (address: URL, expires: Date, paths: [String])?

    init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = 20
        configuration.httpShouldSetCookies = false
        self.session = URLSession(configuration: configuration)
    }

    func listing(_ catalog: KinoCatalog) async throws -> [KinoTitle] {
        _ = try Self.validate(catalog)
        if let cache = shelves[catalog.id], cache.catalog == catalog, cache.expires > .now {
            return cache.titles
        }
        let reply = try await fetch(catalog.origin, hosts: Self.catalogHosts(catalog), limit: 2_097_152)
        let document = try SwiftSoup.parse(reply.text)
        if let root = catalog.listing["root"], try document.select(root).first() == nil {
            throw CatalogError.invalidListing
        }
        let entries = try document.select(catalog.listing["items"] ?? "").array()
        var titles: [KinoTitle] = []
        var seen = Set<String>()
        let available = Self.catalogHosts(catalog)
        let covers = available.union(catalog.resourceHosts).union(catalog.mediaHosts)
        for row in entries.prefix(200) {
            let rawAddress = try row.attr("href")
            guard let address = Self.resolve(rawAddress, relativeTo: reply.url, hosts: available) else { continue }
            let image = try row.select("img").first()
            var name = try row.text()
            if name.isEmpty { name = try row.attr("title") }
            if name.isEmpty { name = try image?.attr("alt") ?? "" }
            guard let title = Self.title(name: name, address: address,
                                         poster: Self.listingPoster(row, name: name, address: address,
                                                                    relativeTo: reply.url, hosts: covers),
                                         catalog: catalog), seen.insert(title.id).inserted else { continue }
            titles.append(title)
        }
        guard !titles.isEmpty else { throw CatalogError.invalidListing }
        shelves[catalog.id] = (catalog, Date().addingTimeInterval(120), titles)
        return titles
    }

    func search(_ query: String, in catalog: KinoCatalog) async throws -> [KinoTitle] {
        _ = try Self.validate(catalog)
        let normalizedQuery = Self.normalized(String(query.prefix(160)))
        let terms = normalizedQuery.split(whereSeparator: \.isWhitespace)
        guard !terms.isEmpty else { return [] }
        let local = (try? await listing(catalog)) ?? []
        var matches = local.filter { title in terms.allSatisfy { Self.normalized(title.name).contains($0) } }
        guard let index = catalog.index else { return Array(matches.prefix(80)) }
        var ids = Set(matches.map(\.id))
        let paths: [String]
        if let cached = lastIndex, cached.address == index, cached.expires > .now {
            paths = cached.paths
        } else {
            do {
                let reply = try await fetch(index, hosts: Self.catalogHosts(catalog), limit: 14 * 1024 * 1024,
                                            redirects: false, accept: "application/xml,text/xml")
                let reader = CatalogIndexReader()
                paths = try reader.read(reply.data)
                lastIndex = (index, Date().addingTimeInterval(120), paths)
            } catch {
                if !matches.isEmpty { return Array(matches.prefix(80)) }
                throw error
            }
        }
        var ranked: [(rank: Int, title: KinoTitle)] = []
        for (index, raw) in paths.enumerated() {
            if index.isMultiple(of: 512) { try Task.checkCancellation() }
            guard let path = URLComponents(string: raw)?.percentEncodedPath,
                  let slug = path.split(separator: "/").last?.removingPercentEncoding,
                  !slug.isEmpty else { continue }
            let name = Self.slugName(slug)
            let normalizedName = Self.normalized(name)
            guard terms.allSatisfy({ normalizedName.contains($0) }),
                  let address = Self.resolve(raw, relativeTo: catalog.origin, hosts: Self.catalogHosts(catalog)),
                  let item = Self.title(name: name, address: address, poster: nil, catalog: catalog),
                  ids.insert(item.id).inserted else { continue }
            let rank = normalizedName == normalizedQuery ? 0 : normalizedName.hasPrefix(normalizedQuery + " ") ? 1 : 2
            ranked.append((rank, item))
            if ranked.count >= 160 {
                ranked.sort(by: Self.indexOrder)
                for entry in ranked.dropFirst(80) { ids.remove(entry.title.id) }
                ranked.removeSubrange(80...)
            }
        }
        matches.append(contentsOf: ranked.sorted(by: Self.indexOrder).map(\.title))
        return Array(matches.prefix(80))
    }

    func cover(_ title: KinoTitle, in catalog: KinoCatalog) async throws -> URL? {
        _ = try Self.validate(catalog)
        let hosts = Self.catalogHosts(catalog)
        guard title.catalogID == catalog.id, let address = title.url,
              Self.belongs(address, to: hosts) else { throw CatalogError.invalidAddress }
        let coverHosts = hosts.union(catalog.resourceHosts).union(catalog.mediaHosts)
        if let url = title.poster, Self.belongs(url, to: coverHosts) { return url }
        guard catalog.detail["poster"] != nil else { return nil }
        let reply = try await fetch(address, hosts: hosts, limit: 2_097_152)
        return try Self.detailPoster(SwiftSoup.parse(reply.text), relativeTo: reply.url, catalog: catalog)
    }

    func detail(_ title: KinoTitle, in catalog: KinoCatalog) async throws -> KinoDetail {
        _ = try Self.validate(catalog)
        guard title.catalogID == catalog.id, let address = title.url,
              Self.belongs(address, to: Self.catalogHosts(catalog)) else { throw CatalogError.invalidAddress }
        let reply = try await fetch(address, hosts: Self.catalogHosts(catalog), limit: 2_097_152)
        let document = try SwiftSoup.parse(reply.text)
        let rules = catalog.detail
        let name = try document.select(rules["title"] ?? "").first()?.text() ?? ""
        guard !name.isEmpty else { throw CatalogError.invalidTitle }
        let description = try rules["description"].flatMap { try document.select($0).first()?.text() } ?? ""
        let photo = try Self.detailPoster(document, relativeTo: reply.url, catalog: catalog)
        let allowed = Set(catalog.playerHosts + catalog.mediaHosts)
        let embed = Self.regularExpression(rules["embedPattern"], captures: 1)
        let extractionDeadline = Date().addingTimeInterval(0.6)
        var episodes: [EpisodeNumber: [URL]] = [:]
        var matrixBudget = 300_000

        func add(_ season: Int, _ number: Int, _ raw: String) {
            guard (1...999).contains(season), (1...9_999).contains(number),
                  let url = Self.resolve(raw, relativeTo: reply.url, hosts: allowed) else { return }
            let key = EpisodeNumber(season: season, number: number)
            var candidates = episodes[key] ?? []
            if candidates.count < 6, !candidates.contains(url) {
                candidates.append(url)
                episodes[key] = candidates
            }
        }

        for group in try document.select(rules["groups"] ?? "").array().prefix(24) {
            let controls = try rules["controls"].map { try group.select($0).array() } ?? []
            if !controls.isEmpty {
                for control in controls.prefix(500) {
                    let coordinates = try control.attr(rules["episodeAttribute"] ?? "data-episode")
                        .split(whereSeparator: { $0 == "-" || $0 == ":" })
                    guard coordinates.count >= 2,
                          let season = Int(coordinates[0].trimmingCharacters(in: .whitespacesAndNewlines)),
                          let number = Int(coordinates[1].trimmingCharacters(in: .whitespacesAndNewlines)) else { continue }
                    var source = try control.attr(rules["sourceAttribute"] ?? "data-source")
                    if let embed, let match = Self.captures(embed, text: source, length: 32_768,
                                                           limit: 1, deadline: extractionDeadline).first {
                        source = match[0]
                    }
                    if source.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("<") {
                        source = try SwiftSoup.parseBodyFragment(String(source.prefix(32_768)))
                            .select("iframe[src],video[src],source[src]")
                            .first()?.attr("src") ?? ""
                    }
                    add(season, number, source)
                }
                continue
            }
            let frame = try rules["iframe"].flatMap { try group.select($0).first() }
                ?? group.select("video[src],source[src]").first()
            if let frame, let raw = try? frame.attr("src"),
               Self.resolve(raw, relativeTo: reply.url, hosts: allowed) != nil {
                add(1, 1, raw)
                continue
            }
            for script in try group.select("script:not([src])").array().prefix(32) where matrixBudget > 0 {
                let scriptText = script.data()
                let input = Array(scriptText.utf8.prefix(min(matrixBudget, 100_000)))
                matrixBudget -= input.count
                var matrix = LiteralEpisodeMatrix(input)
                for slot in matrix.links() { add(slot.season, slot.number, slot.address) }
            }
        }
        guard !episodes.isEmpty else { throw CatalogError.noEpisodes }
        let items = episodes.keys.sorted().map { key in
            KinoEpisode(id: KinoAddress.episodeID(title.id, key.season, key.number),
                        season: key.season, number: key.number, links: episodes[key] ?? [])
        }
        let resolved = KinoTitle(id: title.id, name: String(name.prefix(180)),
                                 poster: photo ?? title.poster,
                                 provider: catalog.name, isSeries: title.isSeries || items.count > 1,
                                 catalogID: catalog.id, url: address)
        return KinoDetail(title: resolved, description: String(description.prefix(600)), episodes: items)
    }

    func playable(_ episode: KinoEpisode, in catalog: KinoCatalog) async throws -> URL {
        _ = try Self.validate(catalog)
        let allowed = Set(catalog.playerHosts + catalog.mediaHosts)
        let media = Set(catalog.mediaHosts)
        let pattern = Self.regularExpression(catalog.player["variants"], captures: 2)
        for address in episode.links.prefix(6) {
            try Task.checkCancellation()
            guard Self.belongs(address, to: allowed) else { continue }
            if Self.belongs(address, to: media), Self.hasVideoSuffix(address) { return address }
            do {
                let reply = try await fetch(address, hosts: allowed, limit: 2_097_152, video: true)
                if reply.isVideo, Self.belongs(reply.url, to: media) { return reply.url }
                let document = try SwiftSoup.parse(reply.text)
                var variants: [(height: Int, url: URL)] = []
                let deadline = Date().addingTimeInterval(0.6)
                if let pattern {
                    for script in try document.select("script:not([src])").array().prefix(100) {
                        for values in Self.captures(pattern, text: script.data(), length: 100_000,
                                                    limit: 20, deadline: deadline) {
                            guard let url = Self.resolve(values[1], relativeTo: reply.url, hosts: media) else { continue }
                            let height = Int(values[0]) ?? 0
                            variants.append(((0...4_320).contains(height) ? height : 0, url))
                        }
                        if variants.count >= 20 || Date() >= deadline { break }
                    }
                }
                for video in try document.select("video[src],video source[src]").array().prefix(10) {
                    if let url = Self.resolve(try video.attr("src"), relativeTo: reply.url, hosts: media) {
                        variants.append((0, url))
                    }
                }
                if let best = variants.max(by: { $0.height < $1.height }) { return best.url }
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                continue
            }
        }
        throw CatalogError.noVideo
    }

    func discover(_ url: URL) async throws -> KinoCatalog {
        guard let host = url.host(), Self.belongs(url, to: [host]) else { throw CatalogError.invalidAddress }
        let reply = try await fetch(url, hosts: [host], limit: 2_097_152)
        if reply.text.trimmingCharacters(in: .whitespacesAndNewlines).first == "{" {
            return try Self.decodeCatalog(reply.data)
        }
        let document = try SwiftSoup.parse(reply.text)
        let links = try document.select("link[rel=alternate][type='application/vnd.kinotix.catalog+json']").array()
        for node in links.prefix(12) {
            if let candidate = Self.resolve(try node.attr("href"), relativeTo: reply.url, hosts: [host]),
               candidate.port == reply.url.port {
                let file = try await fetch(candidate, hosts: [host], limit: 65_536)
                return try Self.decodeCatalog(file.data)
            }
        }
        throw CatalogError.invalidCatalog
    }

    static func decodeCatalog(_ data: Data) throws -> KinoCatalog {
        guard data.count <= 65_536 else { throw CatalogError.tooLarge }
        return try validate(JSONDecoder().decode(KinoCatalog.self, from: data))
    }

    @discardableResult
    static func validate(_ catalog: KinoCatalog) throws -> KinoCatalog {
        let groups = [catalog.catalogHosts, catalog.playerHosts, catalog.mediaHosts, catalog.resourceHosts]
        let selectors = [catalog.listing, catalog.detail, catalog.player]
        guard catalog.version == 1, catalog.id.range(of: #"^[a-z0-9][a-z0-9-]{0,30}$"#, options: .regularExpression) != nil,
              !catalog.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, catalog.name.count <= 80,
              let host = catalog.origin.host(), belongs(catalog.origin, to: [host]),
              (catalog.origin.path.isEmpty || catalog.origin.path == "/"), catalog.origin.query == nil,
              groups.allSatisfy({ $0.count <= 20 && $0.allSatisfy(Self.hostIsValid) }),
              selectors.allSatisfy({ $0.count <= 24 && $0.values.allSatisfy { !$0.isEmpty && $0.count <= 450 } }),
              catalog.listing["items"] != nil, catalog.detail["title"] != nil, catalog.detail["groups"] != nil else {
            throw CatalogError.invalidCatalog
        }
        if let index = catalog.index, !belongs(index, to: catalogHosts(catalog)) || index.query != nil {
            throw CatalogError.invalidCatalog
        }
        return catalog
    }

    private struct Reply {
        let url: URL
        let data: Data
        let isVideo: Bool
        var text: String { String(decoding: data, as: UTF8.self).trimmingCharacters(in: CharacterSet(charactersIn: "\u{FEFF}")) }
    }

    private func fetch(_ url: URL, hosts: Set<String>, limit: Int, redirects: Bool = true,
                       video: Bool = false, accept: String = "text/html,application/json,video/*,*/*;q=0.5") async throws -> Reply {
        guard Self.belongs(url, to: hosts) else { throw CatalogError.invalidAddress }
        var request = URLRequest(url: url)
        request.setValue(accept, forHTTPHeaderField: "Accept")
        // The shared catalog selectors describe the standard HTML layout.
        request.setValue("KinoTix", forHTTPHeaderField: "User-Agent")
        let delegate = RedirectPolicy(hosts: hosts, redirects: redirects)
        let (bytes, response) = try await session.bytes(for: request, delegate: delegate)
        guard let http = response as? HTTPURLResponse, let final = http.url, Self.belongs(final, to: hosts) else {
            throw CatalogError.invalidAddress
        }
        guard (200..<300).contains(http.statusCode) else { throw CatalogError.http(http.statusCode) }
        let type = (http.mimeType ?? "").lowercased()
        if video, type.hasPrefix("video/") || type.contains("mpegurl") || Self.hasVideoSuffix(final) {
            bytes.task.cancel()
            return Reply(url: final, data: Data(), isVideo: true)
        }
        guard http.expectedContentLength <= limit else {
            bytes.task.cancel()
            throw CatalogError.tooLarge
        }
        var data = Data()
        if http.expectedContentLength > 0 { data.reserveCapacity(Int(http.expectedContentLength)) }
        for try await byte in bytes {
            guard data.count < limit else {
                bytes.task.cancel()
                throw CatalogError.tooLarge
            }
            data.append(byte)
        }
        return Reply(url: final, data: data, isVideo: false)
    }

    private final class RedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        let hosts: Set<String>
        let redirects: Bool

        init(hosts: Set<String>, redirects: Bool) {
            self.hosts = hosts
            self.redirects = redirects
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
            if redirects, let url = request.url, KinoCatalogClient.belongs(url, to: hosts) {
                completionHandler(request)
            } else {
                completionHandler(nil)
            }
        }
    }

    private enum CatalogError: LocalizedError {
        case invalidAddress, invalidCatalog, invalidListing, invalidTitle, noEpisodes, noVideo, invalidIndex, tooLarge
        case http(Int)

        var errorDescription: String? {
            switch self {
            case .invalidAddress: return "Die Adresse gehört nicht zu den freigegebenen HTTPS-Quellen."
            case .invalidCatalog: return "Die Adresse liefert keinen gültigen KinoTix-Katalog."
            case .invalidListing: return "Die Webseite liefert keine passenden Titel für diesen Katalog."
            case .invalidTitle: return "Der Katalog hat keinen gültigen Titel geliefert."
            case .noEpisodes: return "Der Katalog hat keine verfügbaren Folgen oder Videos geliefert."
            case .noVideo: return "Keine Katalogquelle liefert ein direkt abspielbares Video."
            case .invalidIndex: return "Der Katalog-Suchindex enthält ungültiges XML."
            case .tooLarge: return "Die Quelle liefert zu viele Daten."
            case .http(let status): return "Die Quelle antwortet mit HTTP \(status)."
            }
        }
    }

    private struct EpisodeNumber: Comparable, Hashable {
        let season: Int
        let number: Int
        static func < (left: Self, right: Self) -> Bool {
            (left.season, left.number) < (right.season, right.number)
        }
    }

    private static func catalogHosts(_ catalog: KinoCatalog) -> Set<String> {
        Set(catalog.catalogHosts + [catalog.origin.host() ?? ""])
    }

    private static func hostIsValid(_ name: String) -> Bool {
        name.range(of: #"^[a-z0-9.-]{1,253}$"#, options: .regularExpression) != nil
    }

    private static func belongs(_ url: URL, to hosts: Set<String>) -> Bool {
        guard let canonical = KinoAddress.https(url.absoluteString), let host = canonical.host(),
              hosts.contains(host), let decoded = url.absoluteString.removingPercentEncoding else { return false }
        return !decoded.contains("\\")
    }

    private static func resolve(_ raw: String, relativeTo base: URL, hosts: Set<String>) -> URL? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: #"\/"#, with: "/")
        guard !value.isEmpty, value.utf8.count <= 4096, !value.contains("\\"),
              let url = URL(string: value, relativeTo: base)?.absoluteURL,
              belongs(url, to: hosts) else { return nil }
        return url
    }

    private static func title(name: String, address: URL, poster: URL?, catalog: KinoCatalog) -> KinoTitle? {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, let path = URLComponents(url: address, resolvingAgainstBaseURL: true)?.percentEncodedPath,
              path.hasPrefix("/"), !path.hasPrefix("//"), path.utf8.count <= 1_000,
              let canonical = resolve(path, relativeTo: catalog.origin, hosts: catalogHosts(catalog)) else { return nil }
        let encoded = Data(path.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let prefix = catalog.detail["seriesPrefix"] ?? ""
        return KinoTitle(id: "catalog:\(catalog.id):\(encoded)", name: String(clean.prefix(180)), poster: poster,
                         provider: catalog.name, isSeries: !prefix.isEmpty && path.hasPrefix(prefix),
                         catalogID: catalog.id, url: canonical)
    }

    private static func detailPoster(_ document: Document, relativeTo base: URL, catalog: KinoCatalog) throws -> URL? {
        guard let selector = catalog.detail["poster"], let element = try document.select(selector).first() else { return nil }
        let hosts = catalogHosts(catalog).union(catalog.resourceHosts).union(catalog.mediaHosts)
        if let url = posterURL(element, relativeTo: base, hosts: hosts) { return url }
        return try element.select("img").first().flatMap { posterURL($0, relativeTo: base, hosts: hosts) }
    }

    private static func listingPoster(_ row: Element, name: String, address: URL,
                                      relativeTo base: URL, hosts: Set<String>) -> URL? {
        var card = row
        var outer: Element? = row
        while let element = outer {
            if element.tagNameNormal() == "article" || element.hasClass("short") {
                card = element
                break
            }
            outer = element.parent()
        }
        guard let images = try? card.select("img").array() else { return nil }
        let nameKey = normalizedPosterTitle(name)
        var best: URL?
        var bestScore = -1
        for image in images.prefix(24) {
            guard let url = posterURL(image, relativeTo: base, hosts: hosts) else { continue }
            let matchesTitle = !nameKey.isEmpty && normalizedPosterTitle((try? image.attr("alt")) ?? "") == nameKey
            var matchesLink = false
            var parent = image.parent()
            while let element = parent {
                if element.tagNameNormal() == "a", let href = try? element.attr("href"), !href.isEmpty {
                    matchesLink = URL(string: href, relativeTo: base)?.absoluteURL == address
                    break
                }
                parent = element.parent()
            }
            let width = Int((try? image.attr("width")) ?? "") ?? 0
            let height = Int((try? image.attr("height")) ?? "") ?? 0
            let displayed = (try? image.attr("src")).flatMap { resolve($0, relativeTo: base, hosts: hosts) } == url
            if displayed, !matchesTitle, !matchesLink, width > 0, height > 0, max(width, height) < 64 { continue }
            let score = (matchesTitle ? 8 : 0) + (matchesLink ? 4 : 0)
                + (width > 0 && height > width ? 2 : 0) + (max(width, height) >= 110 ? 1 : 0)
            if score > bestScore {
                best = url
                bestScore = score
            }
        }
        return best
    }

    private static func normalizedPosterTitle(_ value: String) -> String {
        value.precomposedStringWithCompatibilityMapping
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
            .lowercased()
    }

    private static let decorativeImage = try? NSRegularExpression(
        pattern: #"(^|[_.-])(logo|icon|placeholder|spacer|blank|spinner|no[-_]?image)([_.-]|$)"#,
        options: [.caseInsensitive]
    )

    private static func posterURL(_ image: Element, relativeTo base: URL, hosts: Set<String>) -> URL? {
        for key in ["data-src", "data-lazy-src", "data-original", "src"] {
            guard let value = try? image.attr(key), let url = resolve(value, relativeTo: base, hosts: hosts) else { continue }
            let filename = url.lastPathComponent
            guard decorativeImage?.firstMatch(in: filename, range: NSRange(filename.startIndex..., in: filename)) == nil else { continue }
            return url
        }
        return nil
    }

    private static func normalized(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "de_DE"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func slugName(_ slug: String) -> String {
        var text = slug[...]
        if let hyphen = text.firstIndex(of: "-"), hyphen != text.startIndex,
           text[..<hyphen].allSatisfy({ $0.isASCII && $0.isNumber }) {
            text = text[text.index(after: hyphen)...]
        }
        if let dot = text.lastIndex(of: ".") {
            let extensionText = text[text.index(after: dot)...]
            if (2...5).contains(extensionText.count), extensionText.allSatisfy({ $0.isASCII && $0.isLetter }) {
                text = text[..<dot]
            }
        }
        let name = text.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
        guard let first = name.first else { return "" }
        return first.uppercased() + name.dropFirst()
    }

    private static func indexOrder(_ lhs: (rank: Int, title: KinoTitle), _ rhs: (rank: Int, title: KinoTitle)) -> Bool {
        (lhs.rank, lhs.title.name.count, lhs.title.name, lhs.title.id) <
            (rhs.rank, rhs.title.name.count, rhs.title.name, rhs.title.id)
    }

    private static func regularExpression(_ pattern: String?, captures: Int) -> NSRegularExpression? {
        guard let pattern, pattern.count <= 450,
              let regex = try? NSRegularExpression(pattern: pattern), regex.numberOfCaptureGroups >= captures else { return nil }
        return regex
    }

    private static func captures(_ regex: NSRegularExpression, text: String, length: Int,
                                 limit: Int, deadline: Date) -> [[String]] {
        guard Date() < deadline, !text.isEmpty, !Task.isCancelled else { return [] }
        let bounded = String(text.prefix(length))
        var captures: [[String]] = []
        regex.enumerateMatches(in: bounded, options: [.reportProgress], range: NSRange(bounded.startIndex..., in: bounded)) { match, _, stop in
            if Date() >= deadline || Task.isCancelled {
                stop.pointee = true
                return
            }
            guard let match else { return }
            let values = (1..<match.numberOfRanges).map { Range(match.range(at: $0), in: bounded).map { String(bounded[$0]) } ?? "" }
            captures.append(values)
            if captures.count >= limit { stop.pointee = true }
        }
        return captures
    }

    private static func hasVideoSuffix(_ url: URL) -> Bool {
        ["mp4", "m4v", "mov", "m3u8", "webm", "mpd"].contains(url.pathExtension.lowercased())
    }

    private final class CatalogIndexReader: NSObject, XMLParserDelegate {
        var paths: [String] = []
        private var depth = 0
        private var rootNamespace: String?
        private var insideURL = false
        private var activeLocation = false
        private var value = ""
        private var invalid = false

        func read(_ data: Data) throws -> [String] {
            let declaration = Data("<!DOCTYPE".utf8)
            guard data.range(of: declaration) == nil else { throw CatalogError.invalidIndex }
            let parser = XMLParser(data: data)
            parser.shouldProcessNamespaces = true
            parser.shouldResolveExternalEntities = false
            parser.externalEntityResolvingPolicy = .never
            parser.delegate = self
            let complete = parser.parse()
            try Task.checkCancellation()
            guard !invalid, rootNamespace != nil, complete || paths.count >= 80_000 else {
                throw CatalogError.invalidIndex
            }
            return paths
        }

        func parser(_ parser: XMLParser, didStartElement element: String, namespaceURI: String?,
                    qualifiedName: String?, attributes: [String: String]) {
            depth += 1
            switch depth {
            case 1:
                if element == "urlset" { rootNamespace = namespaceURI ?? "" }
                else { invalid = true; parser.abortParsing() }
            case 2: insideURL = element == "url" && (namespaceURI ?? "") == rootNamespace
            case 3:
                activeLocation = insideURL && element == "loc" && (namespaceURI ?? "") == rootNamespace
                value = ""
            default: activeLocation = false
            }
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) {
            if activeLocation, value.utf8.count <= 4096 { value.append(contentsOf: string) }
        }

        func parser(_ parser: XMLParser, didEndElement element: String, namespaceURI: String?, qualifiedName: String?) {
            if depth == 3 && activeLocation {
                if value.utf8.count <= 4096 { paths.append(value.trimmingCharacters(in: .whitespacesAndNewlines)) }
                activeLocation = false
                if paths.count >= 80_000 || Task.isCancelled { parser.abortParsing() }
            }
            depth -= 1
        }

        func parser(_ parser: XMLParser, foundInternalEntityDeclarationWithName name: String, value: String?) {
            invalid = true
            parser.abortParsing()
        }

        func parser(_ parser: XMLParser, foundExternalEntityDeclarationWithName name: String, publicID: String?, systemID: String?) {
            invalid = true
            parser.abortParsing()
        }
    }
}

private struct LiteralEpisodeMatrix {
    struct Slot {
        let season: Int
        let number: Int
        let address: String
    }

    private let input: [UInt8]
    private var index = 0

    init(_ input: [UInt8]) { self.input = input }

    mutating func links() -> [Slot] {
        var candidates = 0
        while index < input.count {
            trivia()
            guard let byte = peek else { break }
            if [34, 39, 96].contains(byte) {
                skipString(byte)
                continue
            }
            index += 1
            guard byte == 46, matches("show") else { continue }
            candidates += 1
            if candidates > 12 { break }
            var candidate = self
            candidate.index += 4
            if let slots = candidate.parseCall(), !slots.isEmpty { return slots }
        }
        return []
    }

    private mutating func parseCall() -> [Slot]? {
        guard consume(40) else { return nil }
        trivia()
        let start = index
        while let digit = peek, (48...57).contains(digit) {
            index += 1
            if index - start > 4 { return nil }
        }
        guard index > start, consume(44), consume(91) else { return nil }
        var slots: [Slot] = []
        if !consume(93) {
            var season = 1
            while season <= 999 {
                guard consume(91) else { return nil }
                if !consume(93) {
                    var number = 1
                    while number <= 9_999 {
                        trivia()
                        if matches("null") { index += 4 }
                        else {
                            guard let address = string() else { return nil }
                            if !address.isEmpty, slots.count < 2_500 {
                                slots.append(Slot(season: season, number: number, address: address))
                            }
                        }
                        if consume(93) { break }
                        guard number < 9_999, consume(44) else { return nil }
                        if consume(93) { break }
                        number += 1
                    }
                }
                if consume(93) { break }
                guard season < 999, consume(44) else { return nil }
                if consume(93) { break }
                season += 1
            }
        }
        return consume(41) ? slots : nil
    }

    private mutating func string() -> String? {
        guard let delimiter = peek, delimiter == 34 || delimiter == 39 else { return nil }
        index += 1
        var bytes: [UInt8] = []
        var usable = true
        while let byte = peek {
            index += 1
            if byte == delimiter {
                return usable ? String(bytes: bytes, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "" : ""
            }
            guard byte != 10 && byte != 13 else { return nil }
            if byte != 92 {
                if bytes.count < 4096 { bytes.append(byte) } else { usable = false }
                continue
            }
            guard let escape = peek else { return nil }
            index += 1
            switch escape {
            case 34, 39, 47, 92: bytes.append(escape)
            case 117, 120:
                guard let value = hexadecimal(escape == 117 ? 4 : 2) else { return nil }
                if let scalar = UnicodeScalar(value), value >= 32, value != 127 {
                    bytes.append(contentsOf: String(scalar).utf8)
                } else { usable = false }
            case 10: break
            case 13: if peek == 10 { index += 1 }
            case 48, 98, 102, 110, 114, 116, 118: usable = false
            default: return nil
            }
            if bytes.count > 4096 { return nil }
        }
        return nil
    }

    private mutating func hexadecimal(_ count: Int) -> UInt32? {
        var result: UInt32 = 0
        for _ in 0..<count {
            guard let byte = peek, let digit = UInt32(String(UnicodeScalar(byte)), radix: 16) else { return nil }
            index += 1
            result = 16 * result + digit
        }
        return result
    }

    private mutating func skipString(_ delimiter: UInt8) {
        index += 1
        while let byte = peek {
            index += 1
            if byte == delimiter { return }
            if byte == 92 && peek != nil { index += 1 }
        }
    }

    private mutating func trivia() {
        while let byte = peek {
            if [9, 10, 11, 12, 13, 32].contains(byte) { index += 1 }
            else if matches("//") {
                index += 2
                while let next = peek, next != 10 && next != 13 { index += 1 }
            } else if matches("/*") {
                index += 2
                while peek != nil && !matches("*/") { index += 1 }
                if peek != nil { index += 2 }
            } else { break }
        }
    }

    private mutating func consume(_ byte: UInt8) -> Bool {
        trivia()
        guard peek == byte else { return false }
        index += 1
        return true
    }

    private var peek: UInt8? { index < input.count ? input[index] : nil }

    private func matches(_ value: String) -> Bool {
        input[index...].starts(with: value.utf8)
    }
}
