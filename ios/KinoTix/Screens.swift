import AVKit
import SwiftUI
import UniformTypeIdentifiers

private enum KinoColors {
    static let background = Color(red: 0.041, green: 0.049, blue: 0.075)
    static let surface = Color(red: 0.085, green: 0.099, blue: 0.146)
    static let raised = Color(red: 0.135, green: 0.155, blue: 0.216)
    static let accent = Color(red: 0.71, green: 0.86, blue: 1)
    static let muted = Color(red: 0.71, green: 0.75, blue: 0.83)
}

@MainActor
struct KinoTixRootView: View {
    @ObservedObject var store: KinoStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var addingSource = false

    var body: some View {
        TabView {
            NavigationStack {
                destinations(home)
                    .navigationTitle("KinoTix")
                    .toolbar { addToolbar }
            }
            .tabItem { Label("Start", systemImage: "house") }

            NavigationStack {
                destinations(KinoSearchView(store: store))
                    .navigationTitle("Suche")
                    .toolbar { addToolbar }
            }
            .tabItem { Label("Suche", systemImage: "magnifyingglass") }

            NavigationStack {
                destinations(favorites)
                    .navigationTitle("Merkliste")
            }
            .tabItem { Label("Merkliste", systemImage: "bookmark") }

            NavigationStack {
                KinoSettingsView(store: store, add: { addingSource = true })
                    .navigationTitle("Einstellungen")
            }
            .tabItem { Label("Einstellungen", systemImage: "gearshape") }
        }
        .tint(KinoColors.accent)
        .preferredColorScheme(.dark)
        .sheet(isPresented: $addingSource) { KinoAddSourceView(store: store) }
        .fullScreenCover(isPresented: Binding(
            get: { store.playback != nil },
            set: { if !$0 { store.closePlayback() } }
        )) {
            KinoPlayerHost(store: store)
        }
        .task { await store.start() }
        .onChange(of: scenePhase, initial: true) { _, phase in
            store.sceneChanged(isActive: phase == .active)
        }
    }

    private var addToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button("Quelle hinzufügen", systemImage: "plus") {
                addingSource = true
            }
        }
    }

    private func destinations<Content: View>(_ content: Content) -> some View {
        content.navigationDestination(for: KinoTitle.self) { KinoDetailView(title: $0, store: store) }
    }

    private var home: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if !store.continueWatching.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Weiterschauen").font(.title2.bold())
                        ForEach(store.continueWatching, id: \.id) { entry in
                            Button {
                                Task { await store.resume(entry) }
                            } label: {
                                KinoResumeRow(entry: entry)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                if store.titles.isEmpty {
                    if store.isBusy {
                        ProgressView("Mediathek wird geladen …")
                            .frame(maxWidth: .infinity, minHeight: 170)
                    } else {
                        KinoEmptyView(title: "Deine Mediathek ist leer", icon: "play.rectangle.on.rectangle",
                                      message: "Füge einen Videolink oder einen KinoTix-Katalog hinzu.") {
                            Button("Quelle hinzufügen", systemImage: "plus") { addingSource = true }
                                .buttonStyle(.borderedProminent)
                        }
                    }
                } else {
                    VStack(alignment: .leading, spacing: 13) {
                        Text("Mediathek").font(.title2.bold())
                        KinoTitleGrid(titles: store.titles)
                    }
                }
                if let text = store.status, !text.isEmpty {
                    Label(text, systemImage: "info.circle")
                        .font(.footnote)
                        .foregroundStyle(KinoColors.muted)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
        }
        .background(KinoColors.background.ignoresSafeArea())
        .refreshable { await store.syncNow() }
    }

    private var favorites: some View {
        ScrollView {
            let titles = store.favoriteTitles
            Group {
                if titles.isEmpty {
                    KinoEmptyView(title: "Deine Merkliste ist leer", icon: "bookmark",
                                  message: "Merke Filme oder Serien auf ihrer Titelseite.") { EmptyView() }
                } else {
                    KinoTitleGrid(titles: titles)
                }
            }
            .padding(18)
        }
        .background(KinoColors.background.ignoresSafeArea())
    }
}

private struct KinoSearchView: View {
    @ObservedObject var store: KinoStore
    @State private var query = ""
    @State private var result: [KinoTitle] = []
    @State private var loading = false

    private var term: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        ScrollView {
            Group {
                if term.isEmpty {
                    KinoEmptyView(title: "Film oder Serie suchen", icon: "magnifyingglass",
                                  message: "Durchsuche deine Mediathek und Kataloge.") { EmptyView() }
                } else if result.isEmpty && loading {
                    ProgressView("Suche läuft …").frame(maxWidth: .infinity, minHeight: 180)
                } else if result.isEmpty {
                    KinoEmptyView(title: "Keine Treffer", icon: "magnifyingglass",
                                  message: "Versuche es mit einem anderen Suchbegriff.") { EmptyView() }
                } else {
                    KinoTitleGrid(titles: result)
                }
            }
            .padding(18)
        }
        .background(KinoColors.background.ignoresSafeArea())
        .searchable(text: $query, prompt: "Film oder Serie")
        .task(id: term) {
            let search = term
            result = []
            guard !search.isEmpty else { loading = false; return }
            loading = true
            do { try await Task.sleep(for: .milliseconds(230)) } catch { return }
            let titles = await store.search(search)
            guard !Task.isCancelled, search == term else { return }
            result = titles
            loading = false
        }
    }
}

private struct KinoDetailView: View {
    let title: KinoTitle
    @ObservedObject var store: KinoStore
    @State private var detail: KinoDetail?
    @State private var error: String?
    @State private var chosenSeason: Int?
    @State private var retry = 0
    @State private var launching = false

    private var allEpisodes: [KinoEpisode] {
        (detail?.episodes ?? []).sorted { ($0.season, $0.number) < ($1.season, $1.number) }
    }
    private var seasons: [Int] { Array(Set(allEpisodes.map(\.season))).sorted() }
    private var currentSeason: Int { chosenSeason ?? seasons.first ?? 1 }
    private var seasonEpisodes: [KinoEpisode] { allEpisodes.filter { $0.season == currentSeason } }
    private var resumeEntry: KinoResume? {
        store.continueWatching.first { entry in
            entry.title.id == title.id && entry.season == currentSeason &&
                seasonEpisodes.contains(where: { $0.number == entry.episode })
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                KinoDetailHeader(title: detail?.title ?? title)

                if let error {
                    KinoEmptyView(title: "Titel konnte nicht geladen werden", icon: "wifi.exclamationmark", message: error) {
                        Button("Erneut versuchen") { retry += 1 }.buttonStyle(.bordered)
                    }
                } else if let detail {
                    if let entry = resumeEntry {
                        Button {
                            guard !launching else { return }
                            launching = true
                            Task {
                                defer { launching = false }
                                await store.resume(entry)
                            }
                        } label: {
                            Label("Fortsetzen bei \(kinoTime(entry.seconds))", systemImage: "play.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .controlSize(.large)
                        .buttonStyle(.borderedProminent)
                        .disabled(launching)
                    } else if let episode = seasonEpisodes.first {
                        Button {
                            play(detail, episode)
                        } label: {
                            Label(title.isSeries ? "Staffel \(episode.season), Folge \(episode.number) abspielen" : "Abspielen",
                                  systemImage: "play.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .controlSize(.large)
                        .buttonStyle(.borderedProminent)
                        .disabled(launching)
                    }

                    if !detail.description.isEmpty {
                        Text(detail.description).foregroundStyle(KinoColors.muted)
                    }

                    if title.isSeries && !allEpisodes.isEmpty {
                        episodeList(detail)
                    } else if allEpisodes.isEmpty {
                        KinoEmptyView(title: "Keine abspielbaren Folgen", icon: "play.slash",
                                      message: "Prüfe die Quelle und lade den Titel erneut.") {
                            Button("Erneut versuchen") { retry += 1 }.buttonStyle(.bordered)
                        }
                    }
                    if let status = store.status, !status.isEmpty {
                        Text(status).font(.footnote).foregroundStyle(KinoColors.muted)
                    }
                } else {
                    ProgressView("Titel wird geladen …").frame(maxWidth: .infinity, minHeight: 110)
                }
            }
            .padding(18)
        }
        .background(KinoColors.background.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                let favorite = store.favorites.contains(title.id)
                Button(favorite ? "Von Merkliste entfernen" : "Auf Merkliste setzen",
                       systemImage: favorite ? "bookmark.fill" : "bookmark") {
                    store.toggleFavorite(detail?.title ?? title)
                }
            }
        }
        .task(id: retry) {
            error = nil
            do {
                detail = try await store.detail(title)
                try Task.checkCancellation()
                if let position = store.continueWatching.first(where: { $0.title.id == title.id }),
                   seasons.contains(position.season) {
                    chosenSeason = position.season
                }
            } catch is CancellationError {
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func episodeList(_ detail: KinoDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Folgen").font(.title2.bold())
                Spacer()
                if seasons.count > 1 {
                    Picker("Staffel", selection: Binding(get: { currentSeason }, set: { chosenSeason = $0 })) {
                        ForEach(seasons, id: \.self) { Text("Staffel \($0)").tag($0) }
                    }
                    .pickerStyle(.menu)
                }
            }
            ForEach(seasonEpisodes, id: \.id) { episode in
                Button {
                    play(detail, episode)
                } label: {
                    HStack {
                        Text("Folge \(episode.number)").font(.body.weight(.semibold))
                        Spacer()
                        Image(systemName: "play.circle").foregroundStyle(KinoColors.accent)
                    }
                    .padding(13)
                    .background(KinoColors.surface, in: RoundedRectangle(cornerRadius: 11))
                }
                .buttonStyle(.plain)
                .disabled(launching)
            }
        }
    }

    private func play(_ detail: KinoDetail, _ episode: KinoEpisode) {
        guard !launching else { return }
        launching = true
        Task {
            defer { launching = false }
            await store.play(detail, episode: episode)
        }
    }
}

private struct KinoDetailHeader: View {
    let title: KinoTitle

    var body: some View {
        HStack(alignment: .bottom, spacing: 16) {
            KinoCover(title: title)
                .frame(width: 110, height: 156)
                .clipShape(RoundedRectangle(cornerRadius: 15))
            VStack(alignment: .leading, spacing: 7) {
                Text(title.name).font(.title.bold())
                    .foregroundStyle(.primary)
                Text(title.provider.isEmpty ? (title.isSeries ? "Serie" : "Video") : title.provider)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(KinoColors.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 23).fill(
                LinearGradient(colors: [KinoColors.raised, KinoColors.surface],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
            )
        }
    }
}

private struct KinoTitleGrid: View {
    let titles: [KinoTitle]
    private let columns = [GridItem(.adaptive(minimum: 130, maximum: 240), spacing: 12, alignment: .top)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 13) {
            ForEach(titles, id: \.id) { title in
                NavigationLink(value: title) {
                    VStack(alignment: .leading, spacing: 0) {
                        KinoCover(title: title)
                            .aspectRatio(0.78, contentMode: .fit)
                        Text(title.name)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2, reservesSpace: true)
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .background(KinoColors.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 15))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

private struct KinoCover: View {
    let title: KinoTitle

    var body: some View {
        GeometryReader { geometry in
            AsyncImage(url: title.poster) { phase in
                if let image = phase.image {
                    image.resizable()
                        .scaledToFill()
                } else {
                    ZStack {
                        LinearGradient(colors: [KinoColors.raised, KinoColors.surface],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                        Image(systemName: title.isSeries ? "rectangle.stack" : "play.rectangle")
                            .font(.title.weight(.light))
                            .foregroundStyle(KinoColors.accent.opacity(0.82))
                    }
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
        }
        .accessibilityHidden(true)
    }
}

private struct KinoResumeRow: View {
    let entry: KinoResume

    var body: some View {
        HStack(spacing: 12) {
            KinoCover(title: entry.title)
                .frame(width: 48, height: 62)
                .clipShape(RoundedRectangle(cornerRadius: 7))
            VStack(alignment: .leading, spacing: 4) {
                Text(entry.title.name).font(.headline).lineLimit(2)
                if entry.title.isSeries {
                    Text("Staffel \(entry.season) · Folge \(entry.episode)")
                        .font(.caption)
                }
                Text("Fortsetzen bei \(kinoTime(entry.seconds))")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(KinoColors.accent)
            }
            Spacer(minLength: 0)
            Image(systemName: "play.circle.fill").font(.title2).foregroundStyle(KinoColors.accent)
                .accessibilityHidden(true)
        }
        .padding(9)
        .padding(.trailing, 5)
        .background(KinoColors.surface, in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct KinoEmptyView<Actions: View>: View {
    let title: String
    let icon: String
    let message: String
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        VStack(spacing: 11) {
            Image(systemName: icon).font(.title2).foregroundStyle(KinoColors.accent)
                .accessibilityHidden(true)
            Text(title).font(.headline)
            Text(message).font(.subheadline).foregroundStyle(KinoColors.muted)
            actions()
        }
        .padding(22)
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .background(KinoColors.surface, in: RoundedRectangle(cornerRadius: 17))
    }
}

private func kinoTime(_ time: Double) -> String {
    guard time.isFinite, time >= 0, time < 172_800 else { return "0:00" }
    let seconds = Int(time)
    let hours = seconds / 3600
    let minutes = seconds / 60 % 60
    let remainder = seconds % 60
    return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, remainder) :
        String(format: "%d:%02d", minutes, remainder)
}

private struct KinoSettingsView: View {
    @ObservedObject var store: KinoStore
    let add: () -> Void
    @State private var removing: KinoCatalog?

    var body: some View {
        List {
            Section {
                account
            } header: {
                Text("Google-Konto")
            } footer: {
                Text("Kataloge, direkte Videolinks und Wiedergabestände werden über dein KinoTix-Konto abgeglichen. Die Merkliste und lokale Dateien bleiben auf diesem Gerät.")
            }

            Section("Kataloge") {
                if store.catalogs.isEmpty {
                    Text("Du hast noch keinen Katalog hinzugefügt.")
                        .font(.subheadline).foregroundStyle(KinoColors.muted)
                }
                ForEach(store.catalogs, id: \.id) { catalog in
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(catalog.name)
                            Text(catalog.origin.host() ?? catalog.origin.absoluteString)
                                .font(.caption).foregroundStyle(KinoColors.muted).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        Button(role: .destructive) { removing = catalog } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Katalog \(catalog.name) entfernen")
                    }
                }
                Button("Quelle hinzufügen", systemImage: "plus", action: add)
            }

            if let status = store.status, !status.isEmpty {
                Section {
                    Label(status, systemImage: "info.circle")
                        .font(.footnote)
                        .foregroundStyle(KinoColors.muted)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(KinoColors.background.ignoresSafeArea())
        .confirmationDialog("Katalog entfernen?", isPresented: Binding(
            get: { removing != nil },
            set: { if !$0 { removing = nil } }
        ), titleVisibility: .visible, presenting: removing) { catalog in
            Button("„\(catalog.name)“ entfernen", role: .destructive) {
                Task { await store.removeCatalog(catalog) }
            }
            Button("Abbrechen", role: .cancel) {}
        }
    }

    @ViewBuilder private var account: some View {
        if let email = store.accountEmail {
            LabeledContent("Angemeldet", value: email)
            Button("Jetzt synchronisieren", systemImage: "arrow.clockwise") {
                Task { await store.syncNow() }
            }
            .disabled(store.isBusy)
            Button("Abmelden", role: .destructive) { Task { await store.signOut() } }
        } else if let email = store.accountCandidate {
            LabeledContent("Ausgewähltes Konto", value: email)
            Button("Mit diesem Konto verbinden", systemImage: "person.crop.circle.badge.checkmark") {
                Task { await store.confirmAccount() }
            }
            .disabled(store.isBusy)
            Button("Abbrechen", role: .cancel) { Task { await store.cancelSignIn() } }
        } else if store.accountPending {
            ProgressView("Warte auf die Google-Anmeldung …")
            Text("Kehre nach der Bestätigung im Browser zu KinoTix zurück. Hier kannst du dein Konto dann verbinden.")
                .font(.footnote).foregroundStyle(KinoColors.muted)
            Button("Abbrechen", role: .cancel) { Task { await store.cancelSignIn() } }
        } else {
            Text("Gastmodus").foregroundStyle(KinoColors.muted)
            Button("Mit Google anmelden", systemImage: "person.crop.circle") {
                Task { await store.signIn() }
            }
        }
    }
}

private struct KinoAddSourceView: View {
    @ObservedObject var store: KinoStore
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var name = ""
    @State private var feedback: String?
    @State private var submitting = false
    @State private var openingFiles = false
    @FocusState private var editing: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("HTTPS-Adresse", text: $address)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($editing)
                    TextField("Name (optional)", text: $name)
                    Button("Quelle übernehmen", systemImage: "plus.circle") { submit() }
                        .disabled(submitting || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } header: {
                    Text("Webadresse")
                } footer: {
                    Text("Füge ein direktes HTTPS-Video oder die Adresse eines KinoTix-Katalogs hinzu.")
                }

                Section {
                    Button("Datei auswählen", systemImage: "folder") { openingFiles = true }
                        .disabled(submitting)
                } footer: {
                    Text("Wähle eine KinoTix-Katalogdatei oder ein Video.")
                }

                if submitting {
                    ProgressView("Quelle wird geprüft …")
                } else if let feedback {
                    Text(feedback).font(.footnote).foregroundStyle(KinoColors.muted)
                }
            }
            .scrollContentBackground(.hidden)
            .background(KinoColors.background.ignoresSafeArea())
            .navigationTitle("Quelle hinzufügen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Schließen") { dismiss() } }
            }
            .fileImporter(isPresented: $openingFiles, allowedContentTypes: [.movie, .json, .video]) { result in
                switch result {
                case .success(let url):
                    importFile(url)
                case .failure(let error):
                    feedback = error.localizedDescription
                }
            }
        }
        .tint(KinoColors.accent)
    }

    private func submit() {
        guard !submitting else { return }
        editing = false
        submitting = true
        feedback = nil
        let input = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = name.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            defer { submitting = false }
            await store.add(input, name: label.isEmpty ? nil : label)
            if let status = store.status, !status.isEmpty { feedback = status } else { dismiss() }
        }
    }

    private func importFile(_ url: URL) {
        guard !submitting else { return }
        submitting = true
        feedback = nil
        Task {
            let scoped = url.startAccessingSecurityScopedResource()
            defer {
                if scoped { url.stopAccessingSecurityScopedResource() }
                submitting = false
            }
            await store.importFile(url)
            if let status = store.status, !status.isEmpty { feedback = status } else { dismiss() }
        }
    }
}

private struct KinoPlayerHost: View {
    @ObservedObject var store: KinoStore
    @State private var sleepMode: Int?
    @State private var sleepDeadline: Date?

    var body: some View {
        if let item = store.playback {
            KinoTixPlayerView(playback: item, store: store, sleepMode: $sleepMode, sleepDeadline: $sleepDeadline)
                .id(item.id)
        }
    }
}

@MainActor
private struct KinoTixPlayerView: View {
    let playback: KinoPlayback
    @ObservedObject var store: KinoStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var session: KinoPlayerSession
    @State private var nextEpisode: KinoEpisode?
    @State private var loadedDetail: KinoDetail?
    @State private var countdown: Int?
    @State private var nextTask: Task<Void, Never>?
    @State private var loadingNext = false
    @Binding private var sleepMode: Int?
    @Binding private var sleepDeadline: Date?
    @State private var notice: String?

    init(playback: KinoPlayback, store: KinoStore, sleepMode: Binding<Int?>, sleepDeadline: Binding<Date?>) {
        self.playback = playback
        self.store = store
        _sleepMode = sleepMode
        _sleepDeadline = sleepDeadline
        _session = StateObject(wrappedValue: KinoPlayerSession(url: playback.url, resumeTime: playback.resumeTime))
    }

    var body: some View {
        VStack(spacing: 9) {
            header
            ZStack {
                Color.black
                PlayerController(player: session.player)
                if let error = session.error {
                    KinoEmptyView(title: "Wiedergabe fehlgeschlagen", icon: "play.slash", message: error) {
                        Button("Erneut versuchen") { begin() }.buttonStyle(.bordered)
                    }
                    .padding(.horizontal, 18)
                } else if session.loading {
                    ProgressView("Video wird geladen …")
                        .padding(12)
                        .background(KinoColors.surface, in: RoundedRectangle(cornerRadius: 12))
                        .allowsHitTesting(false)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let countdown {
                HStack {
                    Text("Nächste Folge in \(countdown) s").font(.subheadline.bold())
                    Spacer(minLength: 4)
                    Button("Abbrechen") { cancelNext() }.buttonStyle(.bordered)
                }
                .padding(.horizontal, 16)
            } else if let notice {
                Text(notice).font(.footnote).foregroundStyle(KinoColors.muted)
                    .padding(.vertical, 4)
                    .padding(.horizontal, 12)
            }
        }
        .padding(.vertical, 8)
        .background(Color.black.ignoresSafeArea())
        .tint(KinoColors.accent)
        .task {
            begin()
            guard playback.title.isSeries else { return }
            let detail = try? await store.detail(playback.title)
            guard !Task.isCancelled, let detail else { return }
            let episodes = detail.episodes.sorted { ($0.season, $0.number) < ($1.season, $1.number) }
            if let current = episodes.firstIndex(where: { $0.id == playback.episode.id }),
               episodes.indices.contains(current + 1) {
                loadedDetail = detail
                nextEpisode = episodes[current + 1]
            }
        }
        .task(id: sleepDeadline) {
            guard let deadline = sleepDeadline else { return }
            do { try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow))) } catch { return }
            if !Task.isCancelled && sleepDeadline == deadline { stopForSleep() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { session.save() }
            if phase == .active, let deadline = sleepDeadline, deadline <= .now { stopForSleep() }
        }
        .onDisappear {
            cancelNext()
            session.stop()
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button {
                session.stop()
                store.closePlayback()
            } label: {
                Image(systemName: "xmark")
                    .frame(width: 42, height: 42)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Player schließen")

            VStack(alignment: .leading, spacing: 3) {
                Text(playback.title.name).font(.headline).lineLimit(1)
                if playback.title.isSeries {
                    Text("Staffel \(playback.episode.season) · Folge \(playback.episode.number)")
                        .font(.caption).foregroundStyle(KinoColors.muted)
                }
            }

            Spacer(minLength: 0)

            if nextEpisode != nil {
                Button {
                    advance()
                } label: {
                    Image(systemName: "forward.end.fill").frame(width: 42, height: 42)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Nächste Folge")
                .disabled(loadingNext)
            }

            Menu {
                Button("Aus") { setSleep(nil) }
                ForEach([15, 30, 45, 60, 90], id: \.self) { minutes in
                    Button("\(minutes) Minuten") { setSleep(minutes) }
                }
                Button("Nach diesem Video") { setSleep(0) }
            } label: {
                Image(systemName: sleepMode == nil ? "moon.zzz" : "moon.zzz.fill")
                    .frame(width: 42, height: 42)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel("Schlaftimer")
        }
        .padding(.horizontal, 12)
    }

    private func begin() {
        session.start { seconds, duration, finished in
            store.record(playback, seconds: seconds, duration: duration, finished: finished)
            if finished { finishedPlaying() }
        }
    }

    private func finishedPlaying() {
        if sleepMode == 0 || sleepDeadline.map({ $0 <= .now }) == true {
            stopForSleep()
            return
        }
        guard nextEpisode != nil else { return }
        cancelNext()
        nextTask = Task {
            for seconds in (1...8).reversed() {
                countdown = seconds
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
            }
            guard !Task.isCancelled else { return }
            advance()
        }
    }

    private func cancelNext() {
        nextTask?.cancel()
        nextTask = nil
        countdown = nil
    }

    private func advance() {
        guard let nextEpisode, let loadedDetail, !loadingNext else { return }
        cancelNext()
        loadingNext = true
        session.save()
        Task {
            defer { loadingNext = false }
            await store.play(loadedDetail, episode: nextEpisode)
            if let status = store.status, store.playback?.id == playback.id { notice = status }
        }
    }

    private func setSleep(_ minutes: Int?) {
        sleepMode = minutes
        sleepDeadline = minutes.flatMap { $0 > 0 ? .now.addingTimeInterval(Double($0 * 60)) : nil }
        if let minutes, minutes > 0 {
            notice = "Schlaftimer · \(minutes) Min."
        } else {
            notice = minutes == nil ? nil : "Schlaftimer · Nach diesem Video"
        }
    }

    private func stopForSleep() {
        cancelNext()
        sleepMode = nil
        sleepDeadline = nil
        session.player.pause()
        session.save()
        notice = "Schlaftimer · Wiedergabe angehalten"
    }
}

private struct PlayerController: UIViewControllerRepresentable {
    let player: AVPlayer

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.videoGravity = .resizeAspect
        controller.allowsPictureInPicturePlayback = true
        controller.entersFullScreenWhenPlaybackBegins = false
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player { controller.player = player }
    }
}

@MainActor
private final class KinoPlayerSession: ObservableObject {
    @Published private(set) var loading = true
    @Published private(set) var error: String?

    let player = AVPlayer()
    private let url: URL
    private var resumeTime: Double
    private var token = UUID()
    private var ready = false
    private var preparing = false
    private var didEnd = false
    private var lastReport: Double?
    private var periodic: Any?
    private var status: NSKeyValueObservation?
    private var paused: NSKeyValueObservation?
    private var ended: NSObjectProtocol?
    private var failed: NSObjectProtocol?
    private var onProgress: ((Double, Double, Bool) -> Void)?

    init(url: URL, resumeTime: Double) {
        self.url = url
        self.resumeTime = resumeTime
    }

    func start(progress: @escaping (Double, Double, Bool) -> Void) {
        stop()
        ready = false
        preparing = false
        didEnd = false
        lastReport = nil
        loading = true
        error = nil
        onProgress = progress
        let current = token
        let item = AVPlayerItem(url: url)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        player.replaceCurrentItem(with: item)
        status = item.observe(\.status, options: [.initial, .new]) { [weak self] _, _ in
            Task { @MainActor [weak self] in self?.updateStatus(current) }
        }
        paused = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            Task { @MainActor [weak self] in
                guard let self, token == current, player.timeControlStatus == .paused else { return }
                save()
            }
        }
        ended = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, token == current, !didEnd else { return }
                didEnd = true
                report(finished: true)
            }
        }
        failed = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.showFailure(current) }
        }
        periodic = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 2, preferredTimescale: 600), queue: .main
        ) { [weak self] time in
            Task { @MainActor [weak self] in
                guard let self, token == current, time.seconds.isFinite,
                      abs(time.seconds - (lastReport ?? 0)) >= 4 else { return }
                save()
            }
        }
    }

    func save() {
        if !didEnd { report(finished: false) }
    }

    func stop() {
        save()
        token = UUID()
        ready = false
        player.pause()
        if let periodic { player.removeTimeObserver(periodic) }
        if let ended { NotificationCenter.default.removeObserver(ended) }
        if let failed { NotificationCenter.default.removeObserver(failed) }
        status?.invalidate()
        paused?.invalidate()
        periodic = nil
        ended = nil
        failed = nil
        status = nil
        paused = nil
        onProgress = nil
        player.replaceCurrentItem(with: nil)
    }

    private func updateStatus(_ current: UUID) {
        guard token == current, let item = player.currentItem else { return }
        if item.status == .failed {
            showFailure(current)
            return
        }
        guard item.status == .readyToPlay, !preparing else { return }
        preparing = true
        let duration = item.duration.seconds
        let position = duration.isFinite ? min(resumeTime, max(0, duration - 0.25)) : 0
        if position > 0.5 {
            player.seek(to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) {
                [weak self] completed in
                Task { @MainActor [weak self] in
                    guard let self, token == current else { return }
                    if completed { play(current) } else { showFailure(current) }
                }
            }
        } else {
            play(current)
        }
    }

    private func play(_ current: UUID) {
        guard token == current, error == nil else { return }
        lastReport = player.currentTime().seconds
        ready = true
        loading = false
        player.play()
    }

    private func showFailure(_ current: UUID) {
        guard token == current else { return }
        save()
        ready = false
        loading = false
        error = "Die Datei oder der Videolink ist gerade nicht abspielbar."
    }

    private func report(finished: Bool) {
        guard ready, let item = player.currentItem, item.status == .readyToPlay else { return }
        let duration = item.duration.seconds
        let seconds = finished ? duration : player.currentTime().seconds
        guard duration.isFinite, duration > 0, seconds.isFinite, seconds >= 0 else { return }
        let position = min(seconds, duration)
        if !finished, let lastReport, abs(lastReport - position) < 0.15 { return }
        guard finished || position >= 1 || resumeTime >= 1 else { return }
        lastReport = position
        resumeTime = finished ? 0 : position
        onProgress?(position, duration, finished)
    }
}
