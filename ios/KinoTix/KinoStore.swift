import Foundation
import SwiftUI
import UIKit
import UniformTypeIdentifiers

@MainActor
final class KinoStore: ObservableObject {
    @Published private(set) var titles: [KinoTitle] = []
    @Published private(set) var continueWatching: [KinoResume] = []
    @Published private(set) var catalogs: [KinoCatalog] = []
    @Published private(set) var favorites: Set<String> = []
    @Published private(set) var favoriteTitles: [KinoTitle] = []
    @Published private(set) var accountEmail: String?
    @Published private(set) var accountCandidate: String?
    @Published private(set) var accountPending = false
    @Published private(set) var status: String?
    @Published private(set) var isBusy = false
    @Published private(set) var playback: KinoPlayback?
    @Published private(set) var coverScope = UUID()

    private struct Library: Codable {
        var rows: [String: KinoSyncRow] = [:]
        var outbox: [String: KinoSyncRow] = [:]
        var localItems: [String: KinoTitle] = [:]
        var favorites: [String: KinoTitle] = [:]
        var observedTitles: [String: KinoTitle] = [:]
    }

    private let client = KinoCatalogClient()
    private let account = KinoAccountClient()
    private let folder: URL
    private var library = Library()
    private var owner: KinoAccountIdentity?
    private var homeTitles: [KinoTitle] = []
    private var started = false
    private var syncing = false
    private var refreshing = false
    private var backgroundSync: Task<Void, Never>?
    private var pendingSync: Task<Void, Never>?
    private var signInPolling: Task<Void, Never>?
    private var signInAttempt: UUID?
    private var openingSignIn = false
    private var waitingForBrowser = false
    private var leftForBrowser = false
    private var confirmingSignIn = false
    private var sceneIsActive = false
    private var playRequest = UUID()
    private var coverTasks: [String: Task<Void, Never>] = [:]
    private var coverRetryAfter: [String: Date] = [:]

    init() {
        folder = URL.applicationSupportDirectory.appending(path: "KinoTix", directoryHint: .isDirectory)
    }

    func start() async {
        guard !started else { return }
        started = true
        select(nil)
        do {
            if let identity = try await account.restore() { select(identity) }
        } catch {
            status = error.localizedDescription
        }
        await becameActive()
        backgroundSync = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard !Task.isCancelled else { break }
                await self?.syncNow()
            }
        }
    }

    func sceneChanged(isActive: Bool) {
        sceneIsActive = isActive
        if waitingForBrowser {
            if !isActive { leftForBrowser = true }
            else if leftForBrowser { waitingForBrowser = false }
        }
        if isActive {
            startAccountPolling()
            Task { await becameActive() }
        }
    }

    private func becameActive() async {
        guard sceneIsActive else { return }
        if owner != nil { await syncNow() }
        else if !catalogs.isEmpty && homeTitles.isEmpty { await refreshCatalogs() }
    }

    func syncNow() async {
        guard let owner, !syncing else { return }
        syncing = true
        defer { syncing = false }
        do {
            let outgoing = library.outbox.values.sorted { $0.updatedAt < $1.updatedAt }.prefix(1000)
            if !outgoing.isEmpty { try await account.writeRows(Array(outgoing), for: owner.id) }
            guard self.owner?.id == owner.id else { return }
            for row in outgoing where library.outbox[row.key]?.updatedAt == row.updatedAt {
                library.outbox.removeValue(forKey: row.key)
            }
            if !outgoing.isEmpty { save() }
            let received = try await account.readRows(for: owner.id)
            guard self.owner?.id == owner.id else { return }
            let previous = catalogs
            var changed = false
            for row in received where valid(row) && (library.rows[row.key]?.updatedAt ?? 0) < row.updatedAt {
                if playback?.episode.id == row.itemID && row.kind == "progress" { continue }
                library.rows[row.key] = row
                changed = true
            }
            if changed {
                save()
                rebuild()
            }
            status = "Konto synchronisiert."
            if catalogs != previous || (!catalogs.isEmpty && homeTitles.isEmpty) {
                await refreshCatalogs()
            }
        } catch {
            if self.owner?.id == owner.id {
                status = "Abgleich gerade nicht möglich. Änderungen bleiben auf diesem Gerät gespeichert."
            }
        }
    }

    func signIn() async {
        guard owner == nil, !accountPending else { return }
        let attempt = UUID()
        signInAttempt = attempt
        accountPending = true
        openingSignIn = true
        status = nil
        do {
            let challenge = try await account.beginSignIn()
            guard signInAttempt == attempt else { return }
            waitingForBrowser = true
            leftForBrowser = !sceneIsActive
            guard await UIApplication.shared.open(challenge.url) else {
                throw KinoStoreError("Der Link zur Google-Anmeldung konnte nicht geöffnet werden.")
            }
            guard signInAttempt == attempt else { return }
            openingSignIn = false
            startAccountPolling()
        } catch {
            guard signInAttempt == attempt else { return }
            await cancelSignIn()
            if !(error is CancellationError) { status = error.localizedDescription }
        }
    }

    private func startAccountPolling() {
        guard let attempt = signInAttempt, signInPolling == nil, canPollAccount(attempt) else { return }
        signInPolling = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.signInAttempt == attempt { self.signInPolling = nil }
            }
            while self.canPollAccount(attempt), !Task.isCancelled {
                await self.pollAccount(attempt)
                guard self.canPollAccount(attempt) else { break }
                do { try await Task.sleep(for: .seconds(2)) } catch { break }
            }
        }
    }

    private func canPollAccount(_ attempt: UUID) -> Bool {
        sceneIsActive && !openingSignIn && !waitingForBrowser && signInAttempt == attempt && accountCandidate == nil
    }

    private func pollAccount(_ attempt: UUID) async {
        do {
            if let candidate = try await account.pollSignIn(), signInAttempt == attempt {
                accountCandidate = candidate
            }
        } catch is CancellationError {
            // iOS may cancel an HTTP request as Safari takes the foreground.
        } catch {
            guard signInAttempt == attempt else { return }
            await cancelSignIn()
            status = (error is DecodingError) ?
                "Die Anmeldung konnte nicht bestätigt werden. Starte sie bitte erneut." : error.localizedDescription
        }
    }

    func confirmAccount() async {
        guard accountPending, accountCandidate != nil, !isBusy else { return }
        confirmingSignIn = true
        isBusy = true
        defer {
            confirmingSignIn = false
            isBusy = false
        }
        do {
            let identity = try await account.confirmSignIn()
            accountCandidate = nil
            accountPending = false
            signInAttempt = nil
            signInPolling?.cancel()
            signInPolling = nil
            select(identity)
            await syncNow()
        } catch {
            confirmingSignIn = false
            await cancelSignIn()
            if !(error is CancellationError) { status = error.localizedDescription }
        }
    }

    func cancelSignIn() async {
        guard accountPending, !confirmingSignIn, signInAttempt != nil else { return }
        signInAttempt = nil
        openingSignIn = false
        waitingForBrowser = false
        leftForBrowser = false
        accountCandidate = nil
        signInPolling?.cancel()
        signInPolling = nil
        await account.cancelSignIn()
        accountPending = false
    }

    func signOut() async {
        guard owner != nil else { return }
        do {
            try await account.signOut()
            select(nil)
            status = nil
            await refreshCatalogs()
        } catch {
            status = error.localizedDescription
        }
    }

    func search(_ query: String) async -> [KinoTitle] {
        let terms = query.lowercased().split(whereSeparator: \.isWhitespace)
        guard !terms.isEmpty else { return [] }
        var found = titles.filter { title in terms.allSatisfy { title.name.lowercased().contains($0) } }
        var seen = Set(found.map(\.id))
        let snapshot = catalogs
        for catalog in snapshot {
            guard !Task.isCancelled else { return [] }
            let result = (try? await client.search(query, in: catalog)) ?? []
            for title in result where seen.insert(title.id).inserted { found.append(title) }
        }
        guard catalogs == snapshot, !Task.isCancelled else { return [] }
        return found.prefix(100).map(withKnownCover)
    }

    func poster(for title: KinoTitle) -> URL? {
        title.poster ?? library.observedTitles[title.id]?.poster ?? library.favorites[title.id]?.poster
    }

    func loadCover(for title: KinoTitle) async {
        guard let catalogID = title.catalogID else { return }
        let scope = coverScope
        while !Task.isCancelled, scope == coverScope, poster(for: title) == nil,
              coverTasks[title.id] == nil, (coverRetryAfter[title.id] ?? .distantPast) <= .now,
              let catalog = catalogs.first(where: { $0.id == catalogID }) {
            if coverTasks.count >= 4, let pending = coverTasks.values.first {
                await pending.value
                continue
            }
            let task = Task { [weak self, client] in
                let result = try? await client.cover(title, in: catalog)
                guard let self, coverScope == scope else { return }
                coverTasks[title.id] = nil
                guard !Task.isCancelled, catalogs.contains(catalog) else { return }
                if let url = result {
                    let known = library.observedTitles[title.id] ?? title
                    if poster(for: known) == nil {
                        library.observedTitles[title.id] = replacingPoster(of: known, with: url)
                        save()
                        rebuild()
                    }
                } else {
                    coverRetryAfter[title.id] = Date.now.addingTimeInterval(120)
                }
            }
            coverTasks[title.id] = task
            await task.value
            return
        }
    }

    func detail(_ title: KinoTitle) async throws -> KinoDetail {
        if let id = title.catalogID {
            guard let catalog = catalogs.first(where: { $0.id == id }) else {
                throw KinoStoreError("Füge den Katalog für diesen Titel hinzu.")
            }
            let scope = owner?.id
            let result = try await client.detail(title, in: catalog)
            guard scope == owner?.id, catalogs.contains(catalog) else { throw CancellationError() }
            let observed = withKnownCover(result.title)
            if library.observedTitles[title.id] != observed {
                library.observedTitles[title.id] = observed
                save()
                rebuild()
            }
            return KinoDetail(title: observed, description: result.description, episodes: result.episodes)
        }
        guard let url = title.url else { throw KinoStoreError("Der Titel hat keine Videoadresse.") }
        return KinoDetail(title: title, description: "", episodes: [
            KinoEpisode(id: title.id, season: 1, number: 1, links: [url])
        ])
    }

    func play(_ detail: KinoDetail, episode: KinoEpisode) async {
        guard !isBusy else { return }
        let scope = owner?.id
        let request = UUID()
        playRequest = request
        isBusy = true
        defer { isBusy = false }
        do {
            let url: URL
            if let id = detail.title.catalogID, let catalog = catalogs.first(where: { $0.id == id }) {
                url = try await client.playable(episode, in: catalog)
            } else {
                guard let first = episode.links.first else { throw KinoStoreError("Die Folge hat keine Videoadresse.") }
                url = first
            }
            guard scope == owner?.id, playRequest == request, !Task.isCancelled else { return }
            let entry = library.rows["progress:" + episode.id]?.value
            let seconds = entry?.finished == true ? 0 : entry?.time ?? 0
            playback = KinoPlayback(title: detail.title, episode: episode, url: url, resumeTime: seconds)
            status = nil
        } catch {
            if playRequest == request, !(error is CancellationError) { status = error.localizedDescription }
        }
    }

    func resume(_ item: KinoResume) async {
        do {
            let detail = try await detail(item.title)
            guard let episode = detail.episodes.first(where: { $0.id == item.id }) else {
                throw KinoStoreError("Die gespeicherte Folge ist im Katalog gerade nicht verfügbar.")
            }
            await play(detail, episode: episode)
        } catch {
            if !(error is CancellationError) { status = error.localizedDescription }
        }
    }

    func closePlayback() {
        playRequest = UUID()
        playback = nil
        scheduleSync()
    }

    func record(_ current: KinoPlayback, seconds: Double, duration: Double, finished: Bool) {
        guard playback?.id == current.id, seconds.isFinite, duration.isFinite,
              duration > 0, duration <= 86_400, seconds > 0, seconds <= duration + 0.5 else { return }
        let previous = library.rows["progress:" + current.episode.id]?.value
        if previous?.finished == finished, abs((previous?.time ?? -10) - seconds) < 0.4 { return }
        let reference = current.title.catalogID == nil ? nil : KinoCatalogReference(
            url: current.title.id, title: current.title.name, season: current.episode.season,
            episode: current.episode.number, isSeries: current.title.isSeries
        )
        let share = reference != nil || current.title.url.map(KinoAddress.shareable) == true
        library.observedTitles[current.title.id] = withKnownCover(current.title)
        store("progress", current.episode.id,
              KinoSyncValue(time: min(seconds, duration), duration: duration, finished: finished, catalog: reference),
              share: share)
    }

    func add(_ address: String, name: String?) async {
        guard !isBusy else { return }
        guard let url = KinoAddress.https(address.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            status = "Gib eine vollständige HTTPS-Adresse ein."
            return
        }
        let scope = owner?.id
        isBusy = true
        defer { isBusy = false }
        do {
            let ext = url.pathExtension.lowercased()
            if ["mp4", "m4v", "mov", "m3u8", "webm", "ogv"].contains(ext) {
                let title = mediaTitle(url, name: name)
                if owner != nil, KinoAddress.shareable(url) {
                    store("media", title.id, KinoSyncValue(url: url, title: title.name))
                } else {
                    library.localItems[title.id] = title
                    save()
                    rebuild()
                }
            } else {
                let catalog = try await client.discover(url)
                guard scope == owner?.id else { return }
                try addCatalog(catalog)
                await refreshCatalogs()
            }
            status = "Quelle hinzugefügt."
        } catch {
            status = error.localizedDescription
        }
    }

    func importFile(_ url: URL) async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            if url.pathExtension.lowercased() == "json" {
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size > 0 && size <= 65_536 else { throw KinoStoreError("Katalogdateien dürfen höchstens 64 KB groß sein.") }
                try addCatalog(KinoCatalogClient.decodeCatalog(Data(contentsOf: url)))
                await refreshCatalogs()
            } else {
                let files = folder.appending(path: "videos", directoryHint: .isDirectory)
                try FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
                let destination = files.appending(path: UUID().uuidString + "." + url.pathExtension)
                try FileManager.default.copyItem(at: url, to: destination)
                let title = mediaTitle(destination, name: url.deletingPathExtension().lastPathComponent)
                library.localItems[title.id] = title
                save()
                rebuild()
            }
            status = "Datei hinzugefügt."
        } catch {
            status = (error as? DecodingError) == nil ? error.localizedDescription : "Die Datei ist kein gültiger KinoTix-Katalog."
        }
    }

    private func addCatalog(_ catalog: KinoCatalog) throws {
        try KinoCatalogClient.validate(catalog)
        if let existing = catalogs.first(where: { $0.id == catalog.id }), existing.origin.host != catalog.origin.host {
            throw KinoStoreError("Diese Katalogkennung gehört bereits zu einer anderen Adresse.")
        }
        store("catalog", catalog.id, KinoSyncValue(source: catalog))
    }

    func removeCatalog(_ catalog: KinoCatalog) async {
        store("catalog", catalog.id, KinoSyncValue(removed: true))
        await refreshCatalogs()
    }

    func toggleFavorite(_ title: KinoTitle) {
        if library.favorites.removeValue(forKey: title.id) == nil { library.favorites[title.id] = withKnownCover(title) }
        save()
        rebuild()
    }

    private func refreshCatalogs() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        let snapshot = catalogs
        let scope = owner?.id
        var result: [KinoTitle] = []
        var succeeded = false
        await withTaskGroup(of: [KinoTitle]?.self) { group in
            for catalog in snapshot {
                group.addTask { [client] in try? await client.listing(catalog) }
            }
            for await items in group {
                if let items {
                    result.append(contentsOf: items)
                    succeeded = true
                }
            }
        }
        if scope == owner?.id, snapshot == catalogs {
            homeTitles = result
            rebuild()
            if !snapshot.isEmpty, !succeeded { status = "Die Kataloge konnten gerade nicht geladen werden." }
        } else {
            Task { [weak self] in await self?.refreshCatalogs() }
        }
    }

    private func store(_ kind: String, _ id: String, _ value: KinoSyncValue, share: Bool = true) {
        let key = kind + ":" + id
        let previous = library.rows[key]?.updatedAt ?? 0
        let row = KinoSyncRow(kind: kind, itemID: id, updatedAt: max(now(), previous + 1), value: value)
        guard valid(row) else { return }
        library.rows[key] = row
        if owner != nil, share { library.outbox[key] = row }
        save()
        rebuild()
        if share { scheduleSync() }
    }

    private func scheduleSync() {
        guard owner != nil, !library.outbox.isEmpty, pendingSync == nil else { return }
        pendingSync = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.pendingSync = nil
            await self?.syncNow()
        }
    }

    private func select(_ identity: KinoAccountIdentity?) {
        pendingSync?.cancel()
        pendingSync = nil
        playback = nil
        homeTitles = []
        coverScope = UUID()
        for task in coverTasks.values { task.cancel() }
        coverTasks.removeAll()
        coverRetryAfter.removeAll()
        owner = identity
        accountEmail = identity?.email
        library = (try? JSONDecoder().decode(Library.self, from: Data(contentsOf: file()))) ?? Library()
        rebuild()
    }

    private func file() -> URL {
        let id = owner.flatMap { UUID(uuidString: $0.id) }?.uuidString ?? "guest"
        return folder.appending(path: id + ".json")
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try JSONEncoder().encode(library).write(to: file(), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            status = "Änderungen konnten auf diesem Gerät nicht gespeichert werden."
        }
    }

    private func rebuild() {
        catalogs = library.rows.values.compactMap { $0.kind == "catalog" ? $0.value.source : nil }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        let direct = library.rows.values.compactMap { row -> KinoTitle? in
            guard row.kind == "media", let url = row.value.url else { return nil }
            return mediaTitle(url, name: row.value.title)
        }
        let ids = Set(catalogs.map(\.id))
        var byID = library.localItems
        var order = Array(library.localItems.keys.sorted())
        for item in direct + homeTitles.filter({ $0.catalogID.map(ids.contains) == true }) {
            if byID[item.id] == nil { order.append(item.id) }
            byID[item.id] = withKnownCover(item)
        }
        let visibleFavorites = library.favorites.values.filter { $0.catalogID.map(ids.contains) ?? true }.map { title in
            if let cover = byID[title.id]?.poster { return replacingPoster(of: title, with: cover) }
            return withKnownCover(title)
        }
        favoriteTitles = visibleFavorites.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        favorites = Set(favoriteTitles.map(\.id))
        titles = order.compactMap { byID[$0] }

        var resumedTitles = Set<String>()
        continueWatching = library.rows.values
            .filter { $0.kind == "progress" && $0.value.finished == false && ($0.value.time ?? 0) > 0 }
            .sorted { $0.updatedAt > $1.updatedAt }
            .compactMap { row in
                guard let seconds = row.value.time else { return nil }
                if let reference = row.value.catalog,
                   let catalog = catalogs.first(where: { reference.url.hasPrefix("catalog:" + $0.id + ":") }),
                   let path = KinoAddress.catalogPath(reference.url, for: catalog),
                   let url = URL(string: path, relativeTo: catalog.origin)?.absoluteURL {
                    let title = withKnownCover(byID[reference.url] ?? library.observedTitles[reference.url]
                        ?? KinoTitle(id: reference.url, name: reference.title, poster: nil, provider: catalog.name,
                                     isSeries: reference.isSeries, catalogID: catalog.id, url: url))
                    guard resumedTitles.insert(title.id).inserted else { return nil }
                    return KinoResume(id: row.itemID, title: title, season: reference.season,
                                      episode: reference.episode, seconds: seconds)
                }
                guard let title = byID[row.itemID], resumedTitles.insert(title.id).inserted else { return nil }
                return KinoResume(id: row.itemID, title: title, season: 1, episode: 1, seconds: seconds)
            }
    }

    private func withKnownCover(_ title: KinoTitle) -> KinoTitle {
        guard title.poster == nil, let poster = poster(for: title) else { return title }
        return replacingPoster(of: title, with: poster)
    }

    private func replacingPoster(of title: KinoTitle, with url: URL) -> KinoTitle {
        KinoTitle(id: title.id, name: title.name, poster: url, provider: title.provider,
                  isSeries: title.isSeries, catalogID: title.catalogID, url: title.url)
    }

    private func mediaTitle(_ url: URL, name: String?) -> KinoTitle {
        let value = (name ?? url.deletingPathExtension().lastPathComponent)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .filter { !$0.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) }
        return KinoTitle(id: KinoAddress.mediaID(url.absoluteString),
                         name: value.isEmpty ? "Video" : String(value.unicodeScalars.prefix(150)),
                         poster: nil, provider: url.isFileURL ? "Lokale Datei" : "Videolink",
                         isSeries: false, catalogID: nil, url: url)
    }

    private func valid(_ row: KinoSyncRow) -> Bool {
        guard row.updatedAt > 0, row.updatedAt <= now() + 300_000 else { return false }
        if row.kind == "catalog" {
            guard row.itemID.range(of: #"^[a-z0-9][a-z0-9-]{0,30}$"#, options: .regularExpression) != nil else { return false }
            if row.value.removed == true { return row.value.source == nil }
            guard let source = row.value.source, source.id == row.itemID else { return false }
            return (try? KinoCatalogClient.validate(source)) != nil
        }
        guard row.itemID.range(of: #"^media:[a-f0-9]{64}$"#, options: .regularExpression) != nil else { return false }
        if row.kind == "media" {
            if row.value.removed == true { return row.value.url == nil }
            guard let url = row.value.url, let title = row.value.title else { return false }
            return KinoAddress.shareable(url) && KinoAddress.mediaID(url.absoluteString) == row.itemID &&
                !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && title.unicodeScalars.count <= 150
        }
        guard row.kind == "progress", let time = row.value.time, let duration = row.value.duration,
              row.value.finished != nil, time.isFinite, duration.isFinite,
              (0...86_400).contains(duration), (0...(duration + 0.5)).contains(time) else { return false }
        if let reference = row.value.catalog {
            return reference.url.hasPrefix("catalog:") && reference.title.count <= 180 &&
                (1...999).contains(reference.season) && (1...9_999).contains(reference.episode) &&
                KinoAddress.episodeID(reference.url, reference.season, reference.episode) == row.itemID
        }
        return true
    }

    private func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

private struct KinoStoreError: LocalizedError {
    let errorDescription: String?
    init(_ description: String) { errorDescription = description }
}
