package de.kinotix.firetv;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import javax.net.ssl.HttpsURLConnection;

final class TvLibrary {
    private static final String FIRST_PROFILE = "Mein Profil";
    private static final String CATALOG_TYPE = "application/vnd.kinotix.catalog+json";
    private static final String[] MARKERS = {"intro", "recap", "outro", "post_credits"};
    private static final long MAX_DURATION = 86_400_000;
    private static final int MAX_INPUT = 2 * 1024 * 1024;
    private static final int MAX_SNAPSHOT = 12 * 1024 * 1024;
    private static final int MAX_ACCOUNT_CATALOGS = 30;
    private static final int MAX_REMOTE_PROGRESS = 5000;
    private static final String PENDING = "sync-pending:";
    private static final String CATALOG_CLOCK = "sync-clock:";
    private static final String CATALOG_REFRESH = "sync-refresh:";
    private static final Pattern MEDIA_PATH = Pattern.compile(".*\\.(mp4|m4v|webm|mov|ogv|m3u8|mkv|ts)$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern CATALOG_ID = Pattern.compile("[a-z0-9][a-z0-9-]{0,30}");
    private static final Pattern LIST_ID = Pattern.compile("[\\w.-]{1,120}");
    private static final Pattern HOST = Pattern.compile("[a-z0-9.-]{1,253}");
    private static final Pattern OWNER_ID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern MEDIA_ID = Pattern.compile("media:[a-f0-9]{64}");
    private static final Pattern TITLE_ID = Pattern.compile("catalog:([a-z0-9][a-z0-9-]{0,30}):([A-Za-z0-9_-]{2,1400})");

    static final class Title {
        final String id, title, poster, provider, description;
        final boolean isSeries;
        final List<Episode> episodes;
        private final String catalogId, address;

        private Title(String id, String title, String poster, String provider, String description,
                      boolean isSeries, List<Episode> episodes, String catalogId, String address) {
            this.id = id;
            this.title = title;
            this.poster = poster;
            this.provider = provider;
            this.description = description;
            this.isSeries = isSeries;
            this.episodes = immutable(episodes);
            this.catalogId = catalogId;
            this.address = address;
        }
    }

    static final class Episode {
        final String id;
        final int season, episode;
        final List<Source> sources;
        final Map<String, Segment> segments;
        private final String titleId;
        private final List<String> links;

        private Episode(String id, String titleId, int season, int episode, List<Source> sources,
                        Map<String, Segment> segments, List<String> links) {
            this.id = id;
            this.titleId = titleId;
            this.season = season;
            this.episode = episode;
            this.sources = immutable(sources);
            this.segments = segments;
            this.links = immutable(links);
        }
    }

    static final class Source {
        final String name;
        final List<Variant> variants;

        private Source(String name, List<Variant> variants) {
            this.name = name;
            this.variants = immutable(variants);
        }
    }

    static final class Variant {
        final String url;
        final int height;
        final Map<String, Segment> segments;

        private Variant(String url, int height, Map<String, Segment> segments) {
            this.url = url;
            this.height = height;
            this.segments = segments;
        }
    }

    static final class Segment {
        final long startMs, endMs;

        private Segment(long startMs, long endMs) {
            this.startMs = startMs;
            this.endMs = endMs;
        }
    }

    static final class Progress {
        final int season, episode;
        final long positionMs, durationMs, updatedAt;
        final boolean finished;

        private Progress(int season, int episode, long positionMs, long durationMs, long updatedAt,
                         boolean finished) {
            this.season = season;
            this.episode = episode;
            this.positionMs = positionMs;
            this.durationMs = durationMs;
            this.updatedAt = updatedAt;
            this.finished = finished;
        }
    }

    static final class Catalog {
        final String id, name, origin;
        private final JSONObject config;
        private final Set<String> catalogHosts, playerHosts, mediaHosts;
        private final JSONObject listing, detail;

        private Catalog(JSONObject data) throws JSONException, IOException {
            id = data.getString("id");
            if (exactInt(data.opt("version"), 1, 1) != 1 || !CATALOG_ID.matcher(id).matches()) {
                throw new IOException("Eine KinoTix-Katalogdatei braucht Version 1 und eine gültige Kennung.");
            }
            name = requiredText(data, "name", 80);
            URI base = https(data.getString("origin"));
            if (!"/".equals(base.getRawPath()) || base.getRawQuery() != null) {
                throw new IOException("Die Katalog-Adresse muss auf eine HTTPS-Startseite zeigen.");
            }
            origin = base.toString();
            catalogHosts = hostSet(data.optJSONArray("catalogHosts"));
            catalogHosts.add(base.getHost());
            playerHosts = hostSet(data.optJSONArray("playerHosts"));
            mediaHosts = hostSet(data.getJSONArray("mediaHosts"));
            config = data;
            listing = data.getJSONObject("listing");
            detail = data.getJSONObject("detail");
            selector(listing, "root", false);
            selector(listing, "items", true);
            selector(detail, "title", true);
            selector(detail, "groups", true);
            for (String field : new String[]{"description", "poster", "controls", "iframe"}) {
                selector(detail, field, false);
            }
        }
    }

    private final Context context;
    private final String ownerKey;
    private final SharedPreferences library;
    private final SharedPreferences profileSettings;
    private final List<String> profiles = new ArrayList<>();
    private LinkedHashMap<String, Title> titles = new LinkedHashMap<>();
    private LinkedHashMap<String, Catalog> catalogs = new LinkedHashMap<>();
    private final Map<String, RemoteProgress> downloaded = new LinkedHashMap<>();
    private String activeProfile;
    private String activeSyncEpisodeId;

    TvLibrary(Context context) {
        this(context, null);
    }

    TvLibrary(Context context, String ownerUuid) {
        if (ownerUuid != null && !OWNER_ID.matcher(ownerUuid).matches()) {
            throw new IllegalArgumentException("Ungültige KinoTix-Kennung.");
        }
        this.context = context.getApplicationContext();
        ownerKey = ownerUuid == null ? "" : "_" + digest(ownerUuid.toLowerCase(Locale.ROOT));
        library = this.context.getSharedPreferences("kinotix_library" + ownerKey, Context.MODE_PRIVATE);
        profileSettings = this.context.getSharedPreferences("kinotix_profiles" + ownerKey, Context.MODE_PRIVATE);
        profiles.add(FIRST_PROFILE);
        restore();
    }

    boolean isAccountLibrary() {
        return !ownerKey.isEmpty();
    }

    private void restore() {
        try {
            JSONObject state = new JSONObject(library.getString("content", "{}"));
            JSONArray sources = state.optJSONArray("catalogs");
            for (int index = 0; sources != null && index < sources.length(); index++) {
                try {
                    Catalog source = new Catalog(sources.getJSONObject(index));
                    catalogs.put(source.id, source);
                } catch (IOException | JSONException | IllegalArgumentException ignored) {
                    // A damaged catalog must not hide the rest of the library.
                }
            }
            JSONArray items = state.optJSONArray("titles");
            for (int index = 0; items != null && index < items.length(); index++) {
                try {
                    Title title = restoreTitle(items.getJSONObject(index));
                    if (title.catalogId == null || catalogs.containsKey(title.catalogId)) {
                        titles.put(title.id, title);
                    }
                } catch (IOException | JSONException | IllegalArgumentException ignored) {}
            }
        } catch (JSONException ignored) {}
        try {
            JSONArray input = new JSONArray(profileSettings.getString("names", "[]"));
            for (int index = 0; index < input.length() && profiles.size() < 8; index++) {
                String name = input.getString(index).trim();
                if (!name.isEmpty() && name.length() <= 30 && !profiles.contains(name)) {
                    profiles.add(name);
                }
            }
        } catch (JSONException ignored) {}
        String saved = profileSettings.getString("active", FIRST_PROFILE);
        activeProfile = profiles.contains(saved) ? saved : FIRST_PROFILE;
    }

    synchronized List<Title> titles() {
        List<Title> result = new ArrayList<>(titles.values());
        Collections.reverse(result);
        return result;
    }

    synchronized List<Catalog> catalogs() {
        return new ArrayList<>(catalogs.values());
    }

    synchronized List<Catalog> catalogsNeedingRefresh() {
        List<Catalog> result = new ArrayList<>();
        for (Catalog catalog : catalogs.values()) {
            if (library.getBoolean(CATALOG_REFRESH + catalog.id, false)) result.add(catalog);
        }
        return result;
    }

    synchronized List<String> profiles() {
        return new ArrayList<>(profiles);
    }

    synchronized String activeProfile() {
        return activeProfile;
    }

    synchronized void selectProfile(String name) {
        if (!profiles.contains(name)) throw new IllegalArgumentException("Dieses Profil fehlt.");
        activeProfile = name;
        profileSettings.edit().putString("active", name).apply();
    }

    synchronized void addProfile(String name) {
        String clean = name == null ? "" : name.trim();
        if (clean.isEmpty() || clean.length() > 30) {
            throw new IllegalArgumentException("Der Profilname muss 1 bis 30 Zeichen lang sein.");
        }
        for (String existing : profiles) {
            if (existing.equalsIgnoreCase(clean)) throw new IllegalArgumentException("Dieses Profil gibt es schon.");
        }
        if (profiles.size() >= 8) throw new IllegalArgumentException("Du kannst bis zu acht Profile anlegen.");
        profiles.add(clean);
        activeProfile = clean;
        profileSettings.edit().putString("names", new JSONArray(profiles).toString())
                .putString("active", clean).apply();
    }

    synchronized Progress progress(Episode episode) {
        Progress local = readProgress(profile().getString("progress:" + episode.id, ""));
        RemoteProgress remote = FIRST_PROFILE.equals(activeProfile) && !episode.id.equals(activeSyncEpisodeId) ?
                downloaded.get(episode.id) : null;
        return local != null || remote == null ? local : remote.forEpisode(episode);
    }

    synchronized Progress latest(Title title) {
        Progress latest = readProgress(profile().getString("latest:" + title.id, ""));
        if (!FIRST_PROFILE.equals(activeProfile) || downloaded.isEmpty() || title.catalogId != null) return latest;
        for (Episode episode : title.episodes) {
            if (episode.id.equals(activeSyncEpisodeId)) continue;
            RemoteProgress remote = downloaded.get(episode.id);
            if (remote != null && (latest == null || remote.updatedAt > latest.updatedAt)) {
                latest = remote.forEpisode(episode);
            }
        }
        return latest;
    }

    synchronized void saveProgress(Episode episode, long positionMs, long durationMs, boolean finished) {
        if (durationMs < 0 || durationMs > MAX_DURATION || positionMs < 0) return;
        long position = Math.min(positionMs, durationMs);
        SharedPreferences storage = profile();
        boolean synchronize = isAccountLibrary() && FIRST_PROFILE.equals(activeProfile) && MEDIA_ID.matcher(episode.id).matches();
        try {
            Progress prior = readProgress(storage.getString("progress:" + episode.id, ""));
            RemoteProgress remote = synchronize ? downloaded.get(episode.id) : null;
            long oldest = Math.max(prior == null ? 0 : prior.updatedAt, remote == null ? 0 : remote.updatedAt);
            Progress latest = readProgress(storage.getString("latest:" + episode.titleId, ""));
            if (latest != null) oldest = Math.max(oldest, latest.updatedAt);
            long updatedAt = nextTimestamp(oldest);
            Progress checkpoint = new Progress(episode.season, episode.episode, position, durationMs, updatedAt, finished);
            SharedPreferences.Editor edit = storage.edit();
            writeProgress(edit, episode, checkpoint, true);
            if (synchronize) {
                JSONObject value = new JSONObject().put("time", position / 1000d)
                        .put("duration", durationMs / 1000d).put("finished", finished);
                Title title = titles.get(episode.titleId);
                if (title != null && title.catalogId != null && episode.id.equals(catalogEpisodeId(
                        title.id, episode.season, episode.episode))) {
                    value.put("catalog", new JSONObject().put("url", title.id).put("title", title.title)
                            .put("season", episode.season).put("episode", episode.episode)
                            .put("isSeries", title.isSeries));
                }
                edit.putString(PENDING + episode.id, syncRow("progress", episode.id, updatedAt, value).toString());
            }
            edit.apply();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private static void writeProgress(SharedPreferences.Editor edit, Episode episode, Progress checkpoint,
                                      boolean latest) throws JSONException {
        String row = new JSONObject().put("season", checkpoint.season).put("episode", checkpoint.episode)
                .put("position", checkpoint.positionMs).put("duration", checkpoint.durationMs)
                .put("at", checkpoint.updatedAt).put("finished", checkpoint.finished).toString();
        edit.putString("progress:" + episode.id, row);
        if (latest) edit.putString("latest:" + episode.titleId, row);
    }

    private static Progress readProgress(String value) {
        try {
            JSONObject row = new JSONObject(value);
            return new Progress(row.getInt("season"), row.getInt("episode"), row.getLong("position"),
                    row.getLong("duration"), row.getLong("at"), row.getBoolean("finished"));
        } catch (JSONException ignored) {
            return null;
        }
    }

    synchronized boolean isSaved(Title title) {
        return profile().getBoolean("saved:" + title.id, false);
    }

    synchronized boolean toggleSaved(Title title) {
        SharedPreferences store = profile();
        String key = "saved:" + title.id;
        boolean next = !store.getBoolean(key, false);
        store.edit().putBoolean(key, next).apply();
        return next;
    }

    private SharedPreferences profile() {
        return profile(activeProfile);
    }

    private SharedPreferences profile(String name) {
        return context.getSharedPreferences("kinotix_profile_" + digest(name) + ownerKey, Context.MODE_PRIVATE);
    }

    synchronized JSONArray pendingSyncRows(int limit) {
        if (!isAccountLibrary() || limit <= 0) return new JSONArray();
        List<JSONObject> pending = new ArrayList<>();
        collectPending(library, pending);
        collectPending(profile(FIRST_PROFILE), pending);
        pending.sort(Comparator.comparingLong(row -> row.optLong("updated_at")));
        JSONArray batch = new JSONArray();
        for (int i = 0; i < pending.size() && i < Math.min(limit, 1000); i++) batch.put(pending.get(i));
        return batch;
    }

    private static void collectPending(SharedPreferences storage, List<JSONObject> result) {
        for (Map.Entry<String, ?> entry : storage.getAll().entrySet()) {
            if (entry.getKey().startsWith(PENDING) && entry.getValue() instanceof String) {
                JSONObject row = readObject((String) entry.getValue());
                if (row != null) result.add(row);
            }
        }
    }

    synchronized void acknowledgeSyncRows(JSONArray sent) {
        if (!isAccountLibrary() || sent == null) return;
        SharedPreferences primary = profile(FIRST_PROFILE);
        SharedPreferences.Editor catalogEdit = library.edit(), progressEdit = primary.edit();
        for (int index = 0; index < sent.length() && index < 1000; index++) {
            JSONObject row = sent.optJSONObject(index);
            if (row == null) continue;
            String key = PENDING + row.optString("item_id", "");
            boolean catalog = "catalog".equals(row.optString("kind", ""));
            SharedPreferences storage = catalog ? library : primary;
            JSONObject pending = readObject(storage.getString(key, ""));
            if (pending != null && pending.optLong("updated_at") == row.optLong("updated_at")) {
                (catalog ? catalogEdit : progressEdit).remove(key);
            }
        }
        catalogEdit.apply();
        progressEdit.apply();
    }

    synchronized boolean applySyncRows(JSONArray catalogRows, JSONArray progressRows, String activeEpisodeId)
            throws IOException, JSONException {
        if (!isAccountLibrary()) return false;
        activeSyncEpisodeId = activeEpisodeId;
        boolean catalogsChanged = applyCatalogRows(catalogRows);
        return applyProgressRows(progressRows, activeEpisodeId) || catalogsChanged;
    }

    private boolean applyCatalogRows(JSONArray rows) throws IOException, JSONException {
        if (rows == null || rows.length() == 0) return false;
        LinkedHashMap<String, Catalog> next = new LinkedHashMap<>(catalogs);
        LinkedHashMap<String, Title> items = new LinkedHashMap<>(titles);
        Map<String, Long> clocks = new LinkedHashMap<>();
        SharedPreferences.Editor edit = library.edit();
        boolean changed = false;
        for (int i = 0; i < rows.length() && i < 100; i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null || !"catalog".equals(row.optString("kind"))) continue;
            String id = row.optString("item_id", "");
            long timestamp = syncTimestamp(row);
            JSONObject value = row.optJSONObject("value");
            if (!CATALOG_ID.matcher(id).matches() || timestamp <= 0 || value == null ||
                    timestamp <= clocks.getOrDefault(id, library.getLong(CATALOG_CLOCK + id, 0))) continue;
            Catalog prior = next.get(id);
            Catalog source = null;
            if (!Boolean.TRUE.equals(value.opt("removed"))) {
                JSONObject descriptor = value.optJSONObject("source");
                if (descriptor == null || (prior == null && next.size() >= catalogLimit())) continue;
                try {
                    source = portableCopy(new Catalog(descriptor));
                    if (!source.id.equals(id)) continue;
                } catch (IOException | JSONException | IllegalArgumentException invalid) {
                    continue;
                }
            }
            clocks.put(id, timestamp);
            edit.putLong(CATALOG_CLOCK + id, timestamp);
            if (source == null) {
                next.remove(id);
                edit.remove(CATALOG_REFRESH + id);
            } else if (prior == null || !prior.config.toString().equals(source.config.toString())) {
                next.put(id, source);
                edit.putBoolean(CATALOG_REFRESH + id, true);
            } else {
                continue;
            }
            if (prior != null || source != null) {
                items.entrySet().removeIf(item -> id.equals(item.getValue().catalogId));
                changed = true;
            }
        }
        if (!clocks.isEmpty()) {
            if (changed) store(items, next, edit);
            else edit.apply();
        }
        return changed;
    }

    private boolean applyProgressRows(JSONArray rows, String activeEpisodeId) throws IOException, JSONException {
        if (rows == null || rows.length() == 0) return false;
        SharedPreferences primary = profile(FIRST_PROFILE);
        SharedPreferences.Editor edit = primary.edit();
        Map<String, Episode> episodes = new LinkedHashMap<>();
        for (Title title : titles.values()) {
            for (Episode episode : title.episodes) episodes.put(episode.id, episode);
        }
        Map<String, Progress> checkpoints = new LinkedHashMap<>(), latest = new LinkedHashMap<>();
        LinkedHashMap<String, Title> items = new LinkedHashMap<>(titles);
        boolean changed = false;
        for (int i = 0; i < rows.length() && i < MAX_REMOTE_PROGRESS; i++) {
            RemoteProgress remote = RemoteProgress.parse(rows.optJSONObject(i));
            if (remote == null) continue;
            RemoteProgress cached = downloaded.get(remote.id);
            if (cached == null || cached.updatedAt < remote.updatedAt) downloaded.put(remote.id, remote);
            if (remote.id.equals(activeEpisodeId)) continue;
            Episode episode = episodes.get(remote.id);
            CatalogReference reference = remote.catalog;
            if (reference != null && catalogs.containsKey(reference.catalogId)) {
                if (!items.containsKey(reference.id)) {
                    Catalog source = catalogs.get(reference.catalogId);
                    String address = address(reference.path, https(source.origin));
                    if (address == null) continue;
                    items.put(reference.id, new Title(reference.id, reference.title, "", source.name, "",
                            reference.series, Collections.emptyList(), source.id, address));
                }
                episode = new Episode(remote.id, reference.id, reference.season, reference.episode,
                        Collections.emptyList(), Collections.emptyMap(), Collections.emptyList());
            }
            if (episode == null) continue;
            Progress existing = checkpoints.get(episode.id);
            if (existing == null) existing = readProgress(primary.getString("progress:" + episode.id, ""));
            if (existing != null && existing.updatedAt >= remote.updatedAt) continue;
            Progress last = latest.get(episode.titleId);
            if (last == null) last = readProgress(primary.getString("latest:" + episode.titleId, ""));
            Progress checkpoint = remote.forEpisode(episode);
            boolean newest = last == null || last.updatedAt <= checkpoint.updatedAt;
            writeProgress(edit, episode, checkpoint, newest);
            checkpoints.put(episode.id, checkpoint);
            if (newest) latest.put(episode.titleId, checkpoint);
            changed = true;
        }
        while (downloaded.size() > MAX_REMOTE_PROGRESS) {
            downloaded.remove(downloaded.keySet().iterator().next());
        }
        boolean added = items.size() > titles.size();
        if (added) store(items, catalogs);
        if (changed) edit.apply();
        return changed || added;
    }

    int copyGuestCatalogs(TvLibrary guest) throws IOException, JSONException {
        if (!isAccountLibrary() || guest == null || guest.isAccountLibrary()) return 0;
        List<Catalog> offered;
        List<Title> imported;
        synchronized (guest) {
            offered = guest.catalogs();
            imported = guest.titles();
        }
        synchronized (this) {
            LinkedHashMap<String, Catalog> next = new LinkedHashMap<>(catalogs);
            LinkedHashMap<String, Title> items = new LinkedHashMap<>(titles);
            SharedPreferences.Editor edit = library.edit();
            List<String> added = new ArrayList<>();
            for (Catalog source : offered) {
                if (next.size() >= catalogLimit()) break;
                if (next.containsKey(source.id) || library.contains(CATALOG_CLOCK + source.id)) continue;
                Catalog portable = portableCopy(source);
                next.put(portable.id, portable);
                queueCatalog(edit, portable.id, portable);
                added.add(source.id);
            }
            if (added.isEmpty()) return 0;
            for (Title title : imported) if (added.contains(title.catalogId)) items.put(title.id, title);
            store(items, next, edit);
            return added.size();
        }
    }

    private void queueCatalog(SharedPreferences.Editor edit, String id, Catalog source)
            throws JSONException, IOException {
        if (!isAccountLibrary()) return;
        long timestamp = nextTimestamp(library.getLong(CATALOG_CLOCK + id, 0));
        JSONObject value = source == null ? new JSONObject().put("removed", true) :
                new JSONObject().put("source", source.config);
        if (value.toString().getBytes(StandardCharsets.UTF_8).length > 16_000) {
            throw new IOException("Die Katalogdatei ist zu groß für die Synchronisierung.");
        }
        edit.putLong(CATALOG_CLOCK + id, timestamp)
                .putString(PENDING + id, syncRow("catalog", id, timestamp, value).toString());
    }

    private static JSONObject syncRow(String kind, String id, long at, JSONObject value) throws JSONException {
        return new JSONObject().put("kind", kind).put("item_id", id).put("updated_at", at).put("value", value);
    }

    private static JSONObject readObject(String encoded) {
        try {
            return new JSONObject(encoded);
        } catch (JSONException invalid) {
            return null;
        }
    }

    private static long nextTimestamp(long previous) {
        return Math.max(System.currentTimeMillis(), previous + 1);
    }

    private static long syncTimestamp(JSONObject row) {
        Object input = row.opt("updated_at");
        if (!(input instanceof Number)) return -1;
        long at = ((Number) input).longValue();
        return at > 0 && at <= System.currentTimeMillis() + 300_000 &&
                ((Number) input).doubleValue() == at ? at : -1;
    }

    private static String catalogEpisodeId(String titleId, int season, int episode) {
        return "media:" + digest(titleId + "|" + season + "|" + episode);
    }

    private static final class CatalogReference {
        final String id, catalogId, path, title;
        final int season, episode;
        final boolean series;

        private CatalogReference(String id, String catalogId, String path, String title, int season,
                                 int episode, boolean series) {
            this.id = id;
            this.catalogId = catalogId;
            this.path = path;
            this.title = title;
            this.season = season;
            this.episode = episode;
            this.series = series;
        }

        static CatalogReference parse(JSONObject row, String episodeId) {
            if (row == null) return null;
            String id = row.optString("url", "");
            java.util.regex.Matcher match = TITLE_ID.matcher(id);
            if (!match.matches()) return null;
            String encoded = match.group(2);
            int flags = Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP;
            try {
                String path = new String(Base64.decode(encoded, flags), StandardCharsets.UTF_8);
                if (!path.startsWith("/") || path.startsWith("//") || !encoded.equals(Base64.encodeToString(
                        path.getBytes(StandardCharsets.UTF_8), flags))) return null;
                for (int i = 0; i < path.length(); i++) {
                    char value = path.charAt(i);
                    if (value <= 0x20 || value == '?' || value == '#' || value == '\\') return null;
                }
                Object titleValue = row.opt("title");
                if (!(titleValue instanceof String)) return null;
                String title = ((String) titleValue).trim();
                int season = exactInt(row.opt("season"), 1, 999), episode = exactInt(row.opt("episode"), 1, 9999);
                if (title.isEmpty() || title.length() > 180 || season < 0 || episode < 0 ||
                        !episodeId.equals(catalogEpisodeId(id, season, episode))) return null;
                return new CatalogReference(id, match.group(1), path, title, season, episode,
                        Boolean.TRUE.equals(row.opt("isSeries")));
            } catch (IllegalArgumentException invalid) {
                return null;
            }
        }
    }

    private static final class RemoteProgress {
        final String id;
        final long position, duration, updatedAt;
        final boolean finished;
        final CatalogReference catalog;

        private RemoteProgress(String id, long position, long duration, long updatedAt, boolean finished,
                               CatalogReference catalog) {
            this.id = id;
            this.position = position;
            this.duration = duration;
            this.updatedAt = updatedAt;
            this.finished = finished;
            this.catalog = catalog;
        }

        static RemoteProgress parse(JSONObject row) {
            if (row == null || !"progress".equals(row.optString("kind"))) return null;
            String id = row.optString("item_id", "");
            long at = syncTimestamp(row);
            JSONObject value = row.optJSONObject("value");
            if (at <= 0 || !MEDIA_ID.matcher(id).matches() || value == null) return null;
            Object positionValue = value.opt("time"), durationValue = value.opt("duration");
            Object status = value.opt("finished");
            if (!(positionValue instanceof Number) || !(durationValue instanceof Number) || !(status instanceof Boolean)) {
                return null;
            }
            double position = ((Number) positionValue).doubleValue(), duration = ((Number) durationValue).doubleValue();
            if (!(position >= 0 && duration >= 0 && duration <= MAX_DURATION / 1000d && position <= duration + .5)) {
                return null;
            }
            return new RemoteProgress(id, Math.round(Math.min(position, duration) * 1000), Math.round(duration * 1000),
                    at, (Boolean) status, CatalogReference.parse(value.optJSONObject("catalog"), id));
        }

        Progress forEpisode(Episode episode) {
            return new Progress(episode.season, episode.episode, position, duration, updatedAt, finished);
        }
    }

    List<Title> importUrl(String input) throws IOException, JSONException {
        String address = input == null ? "" : input.trim();
        if (!address.isEmpty() && !address.contains("://")) address = "https://" + address;
        URI requested = directHttps(address);
        Reply reply = download(requested, null, true);
        if (reply.video) {
            String label = requested.getPath();
            label = label.substring(label.lastIndexOf('/') + 1).replaceFirst("(?i)\\.[a-z0-9]{2,5}$", "");
            Title title = single(requested.toString(), label.isEmpty() ? requested.getHost() : label);
            return addTitles(Collections.singletonList(title));
        }
        String html = reply.body;
        if (reply.type.contains("json") || html.trim().startsWith("{") || html.trim().startsWith("[")) {
            return importJson(html);
        }
        if (reply.type.contains("html") || html.trim().startsWith("<")) {
            URI catalogUri = discoverCatalog(reply);
            if (catalogUri != null) {
                Reply manifest = download(catalogUri, Collections.singleton(reply.uri.getHost()), false);
                if (sameOrigin(manifest.uri, reply.uri)) return importJson(manifest.body);
            }
        }
        throw new IOException("Kein Video und kein KinoTix-Katalog gefunden. Verwende einen direkten HTTPS-Link.");
    }

    List<Title> importJson(String json) throws IOException, JSONException {
        if (json == null || json.length() > MAX_INPUT) throw new IOException("Die JSON-Datei ist zu groß.");
        JSONTokener input = new JSONTokener(stripBom(json));
        Object value = input.nextValue();
        if (input.nextClean() != 0) throw new JSONException("Ungültiges JSON.");
        if (!(value instanceof JSONObject)) throw new IOException("Die JSON-Datei braucht ein KinoTix-Objekt.");
        JSONObject data = (JSONObject) value;
        if (data.has("origin") && data.has("listing")) return importCatalog(new Catalog(data));
        JSONArray rows = data.optJSONArray("titles");
        if (rows == null) return addTitles(Collections.singletonList(mediaList(data)));
        if (rows.length() < 1 || rows.length() > 200) {
            throw new IOException("Eine Sammlung braucht ein bis 200 Medienlisten.");
        }
        LinkedHashMap<String, Title> parsed = new LinkedHashMap<>();
        for (int index = 0; index < rows.length(); index++) {
            Title title = mediaList(rows.getJSONObject(index));
            if (parsed.put(title.id, title) != null) {
                throw new IOException("Jede Medienliste braucht eine eindeutige Kennung.");
            }
        }
        return addTitles(new ArrayList<>(parsed.values()));
    }

    Title addFile(String contentUri, String name) throws IOException, JSONException {
        Uri uri = Uri.parse(contentUri);
        if (!"content".equals(uri.getScheme()) || uri.getAuthority() == null) {
            throw new IOException("Wähle eine Videodatei im Fire-TV-Dateidialog aus.");
        }
        Title title = single(contentUri, name == null ? "Lokales Video" : name);
        addTitles(Collections.singletonList(title));
        return title;
    }

    private static Title single(String address, String name) {
        String id = "media:" + digest(address);
        Variant variant = new Variant(address, 0, Collections.emptyMap());
        Source source = new Source("Originalquelle", Collections.singletonList(variant));
        Episode episode = new Episode(id, id, 1, 1, Collections.singletonList(source),
                Collections.emptyMap(), Collections.emptyList());
        String title = shorten(name, 150);
        return new Title(id, title.isEmpty() ? "Video" : title, "", "", "", false,
                Collections.singletonList(episode), null, null);
    }

    private static Title mediaList(JSONObject input) throws IOException, JSONException {
        String name = requiredText(input, "title", 150);
        String listId = input.getString("id");
        if (!LIST_ID.matcher(listId).matches()) throw new IOException("Die Medienliste braucht eine gültige id.");
        String id = "media:" + digest("list:" + listId);
        boolean isSeries = input.has("episodes");
        String description = shorten(input.optString("description", ""), 600);
        List<Episode> episodes = mediaEpisodes(input, id, isSeries, false);
        String poster = address(input.optString("poster", ""), null);
        return new Title(id, name, poster == null ? "" : poster, "", description, isSeries, episodes, null, null);
    }

    private static List<Episode> mediaEpisodes(JSONObject input, String id, boolean isSeries, boolean stored)
            throws JSONException, IOException {
        JSONArray rows = isSeries || stored ? input.getJSONArray("episodes") : null;
        if (rows != null && (rows.length() < 1 || rows.length() > 500)) {
            throw new IOException("Eine Medienliste braucht ein bis 500 Folgen.");
        }
        Set<String> seen = new HashSet<>();
        List<Episode> result = new ArrayList<>();
        for (int i = 0; i < (rows == null ? 1 : rows.length()); i++) {
            JSONObject row = rows == null ? input : rows.getJSONObject(i);
            int season = rows == null ? 1 : exactInt(row.opt("season"), 1, 999);
            int number = rows == null ? 1 : exactInt(row.opt("episode"), 1, 9999);
            String key = season + ":" + number;
            if (season < 1 || number < 1 || !seen.add(key)) {
                throw new IOException("Staffel- und Folgennummern müssen positiv und eindeutig sein.");
            }
            String episodeId = isSeries ? "media:" + digest(id + ":" + key) : id;
            result.add(new Episode(episodeId, id, season, number,
                    parseSources(row.getJSONArray("sources"), stored), parseSegments(row.optJSONObject("segments")),
                    Collections.emptyList()));
        }
        result.sort(Comparator.comparingInt((Episode row) -> row.season).thenComparingInt(row -> row.episode));
        return result;
    }

    private static List<Source> parseSources(JSONArray rows, boolean stored) throws JSONException, IOException {
        if (rows.length() < 1 || rows.length() > 12) throw new IOException("Ein Video braucht ein bis zwölf Quellen.");
        List<Source> result = new ArrayList<>();
        for (int index = 0; index < rows.length(); index++) {
            JSONObject row = rows.getJSONObject(index);
            JSONArray variants = row.has("variants") ? row.getJSONArray("variants") : new JSONArray().put(row);
            if (variants.length() < 1 || variants.length() > 10) {
                throw new IOException("Eine Quelle braucht ein bis zehn Qualitätsstufen.");
            }
            Set<Integer> heights = new HashSet<>();
            List<Variant> clean = new ArrayList<>();
            for (int i = 0; i < variants.length(); i++) {
                JSONObject variant = variants.getJSONObject(i);
                if (variant.has("file") || !variant.has("url")) {
                    throw new IOException("Medienlisten auf dem Fernseher brauchen HTTPS-URLs statt lokaler Dateinamen.");
                }
                String url = variant.getString("url");
                if (!(stored && url.startsWith("content://"))) url = directHttps(url).toString();
                int height = variant.has("height") ? exactInt(variant.opt("height"), 0, 4320) : 0;
                if (height < 0 || !heights.add(height)) {
                    throw new IOException("Jede Auflösung darf je Quelle nur einmal angegeben werden.");
                }
                clean.add(new Variant(url, height, parseSegments(variant.optJSONObject("segments"))));
            }
            clean.sort(Comparator.comparingInt((Variant rowVariant) -> rowVariant.height).reversed());
            String name = shorten(row.optString("name", ""), 60);
            result.add(new Source(name.isEmpty() ? "Quelle " + (index + 1) : name, clean));
        }
        return result;
    }

    private static Map<String, Segment> parseSegments(JSONObject raw) throws IOException {
        Map<String, Segment> result = new LinkedHashMap<>();
        for (String name : MARKERS) {
            if (raw == null || raw.isNull(name)) continue;
            JSONArray endpoints = raw.optJSONArray(name);
            Object startValue = endpoints == null ? null : endpoints.opt(0);
            Object endValue = endpoints == null ? null : endpoints.opt(1);
            double start = startValue instanceof Number ? ((Number) startValue).doubleValue() : Double.NaN;
            double end = endValue instanceof Number ? ((Number) endValue).doubleValue() : Double.NaN;
            if (!(start >= 0 && end > start && end <= 86400)) {
                throw new IOException("Ungültige Zeitmarke für " + name + ". Verwende [Start, Ende] in Sekunden.");
            }
            result.put(name, new Segment(Math.round(start * 1000), Math.round(end * 1000)));
        }
        return Collections.unmodifiableMap(result);
    }

    private List<Title> importCatalog(Catalog source) throws IOException, JSONException {
        if (isAccountLibrary()) source = portableCopy(source);
        List<Title> found = listing(source);
        synchronized (this) {
            Catalog previous = catalogs.get(source.id);
            if (previous != null && !previous.origin.equals(source.origin)) {
                throw new IOException("Ein anderer Katalog verwendet diese Kennung bereits.");
            }
            if (previous == null && catalogs.size() >= catalogLimit()) {
                throw new IOException("Bis zu " + catalogLimit() + " Kataloge sind möglich.");
            }
            SharedPreferences.Editor edit = library.edit().remove(CATALOG_REFRESH + source.id);
            queueCatalog(edit, source.id, source);
            replaceCatalog(source, found, edit);
        }
        return found;
    }

    List<Title> refresh(Catalog source) throws IOException, JSONException {
        List<Title> found = listing(source);
        synchronized (this) {
            if (catalogs.get(source.id) != source) throw new IOException("Dieser Katalog wurde geändert.");
            replaceCatalog(source, found, library.edit().remove(CATALOG_REFRESH + source.id));
        }
        return found;
    }

    private void replaceCatalog(Catalog source, List<Title> found, SharedPreferences.Editor edit)
            throws JSONException, IOException {
        LinkedHashMap<String, Catalog> nextCatalogs = new LinkedHashMap<>(catalogs);
        LinkedHashMap<String, Title> nextTitles = withoutCatalog(source.id);
        LinkedHashMap<String, Title> listing = new LinkedHashMap<>();
        for (Title title : found) listing.put(title.id, title);
        for (Title title : titles.values()) {
            if (source.id.equals(title.catalogId) && !listing.containsKey(title.id) && retainTitle(title)) {
                nextTitles.put(title.id, title);
            }
        }
        nextCatalogs.put(source.id, source);
        nextTitles.putAll(listing);
        store(nextTitles, nextCatalogs, edit);
    }

    synchronized void removeCatalog(Catalog source) throws IOException, JSONException {
        if (catalogs.get(source.id) != source) throw new IOException("Dieser Katalog wurde geändert.");
        LinkedHashMap<String, Catalog> next = new LinkedHashMap<>(catalogs);
        next.remove(source.id);
        SharedPreferences.Editor edit = library.edit().remove(CATALOG_REFRESH + source.id);
        queueCatalog(edit, source.id, null);
        store(withoutCatalog(source.id), next, edit);
    }

    private int catalogLimit() {
        return isAccountLibrary() ? MAX_ACCOUNT_CATALOGS : 15;
    }

    private boolean retainTitle(Title title) {
        for (String name : profiles) {
            SharedPreferences profile = profile(name);
            if (profile.contains("latest:" + title.id) || profile.getBoolean("saved:" + title.id, false)) {
                return true;
            }
        }
        return false;
    }

    private LinkedHashMap<String, Title> withoutCatalog(String id) {
        LinkedHashMap<String, Title> result = new LinkedHashMap<>();
        for (Title title : titles.values()) {
            if (!id.equals(title.catalogId)) result.put(title.id, title);
        }
        return result;
    }

    private static List<Title> listing(Catalog source) throws IOException {
        Reply reply = download(https(source.origin), source.catalogHosts, false);
        Document document = Jsoup.parse(reply.body, reply.uri.toString());
        String root = selector(source.listing, "root", false);
        if (!root.isEmpty() && document.selectFirst(root) == null) {
            throw new IOException("Die Webseite liefert nicht die erwartete Katalogstruktur.");
        }
        LinkedHashMap<String, Title> found = new LinkedHashMap<>();
        String prefix = source.detail.optString("seriesPrefix", "");
        for (Element item : document.select(selector(source.listing, "items", true))) {
            String address = address(item.attr("href"), reply.uri);
            if (address == null) continue;
            URI uri = https(address);
            String path = uri.getRawPath();
            if (!source.catalogHosts.contains(uri.getHost()) || path.startsWith("//") || path.length() > 1000) continue;
            String name = shorten(item.text(), 180);
            if (name.isEmpty()) name = shorten(item.attr("title"), 180);
            Element image = item.selectFirst("img");
            if (name.isEmpty() && image != null) name = shorten(image.attr("alt"), 180);
            if (name.isEmpty()) continue;
            String poster = poster(item, name, reply.uri);
            String id = "catalog:" + source.id + ":" + Base64.encodeToString(path.getBytes(StandardCharsets.UTF_8),
                    Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
            boolean series = !prefix.isEmpty() && path.startsWith(prefix);
            found.putIfAbsent(id, new Title(id, name, poster, source.name, "", series,
                    Collections.emptyList(), source.id, address));
            if (found.size() >= 200) break;
        }
        if (found.isEmpty()) throw new IOException("Der Katalog enthält keine passenden Titel.");
        return new ArrayList<>(found.values());
    }

    Title details(Title title) throws IOException {
        if (title.catalogId == null || !title.episodes.isEmpty()) return title;
        Catalog source = catalogFor(title);
        Reply reply = download(https(title.address), source.catalogHosts, false);
        Document document = Jsoup.parse(reply.body, reply.uri.toString());
        JSONObject rules = source.detail;
        String name = shorten(elementText(document, selector(rules, "title", true)), 180);
        if (name.isEmpty()) throw new IOException("Der Katalog hat keinen Titel geliefert.");
        String description = shorten(elementText(document, selector(rules, "description", false)), 600);
        String posterSelector = selector(rules, "poster", false);
        Element detailImage = posterSelector.isEmpty() ? null : document.selectFirst(posterSelector);
        String poster = imageAddress(detailImage, reply.uri);
        if (poster == null) poster = title.poster;
        Map<String, EpisodeLinks> episodes = new LinkedHashMap<>();
        Set<String> permitted = new HashSet<>(source.playerHosts);
        permitted.addAll(source.mediaHosts);
        String controls = selector(rules, "controls", false);
        String iframe = selector(rules, "iframe", false);
        int groups = 0;
        for (Element group : document.select(selector(rules, "groups", true))) {
            if (++groups > 24) break;
            List<Element> buttons = controls.isEmpty() ? Collections.emptyList() : group.select(controls);
            if (buttons.isEmpty()) {
                Element embedded = iframe.isEmpty() ? null : group.selectFirst(iframe);
                if (embedded == null) embedded = group.selectFirst("video[src], source[src]");
                if (embedded != null) addLink(episodes, permitted, 1, 1, embedded.attr("src"), reply.uri);
                continue;
            }
            int count = 0;
            for (Element button : buttons) {
                if (++count > 500) break;
                String[] coordinates = button.attr(rules.optString("episodeAttribute", "data-episode"))
                        .split("[-:]", 3);
                if (coordinates.length != 2) continue;
                try {
                    int season = Integer.parseInt(coordinates[0]);
                    int number = Integer.parseInt(coordinates[1]);
                    String raw = button.attr(rules.optString("sourceAttribute", "data-source"));
                    if (raw.trim().startsWith("<")) {
                        Element frame = Jsoup.parseBodyFragment(raw).selectFirst("iframe[src], video[src], source[src]");
                        raw = frame == null ? "" : frame.attr("src");
                    }
                    addLink(episodes, permitted, season, number, raw, reply.uri);
                } catch (NumberFormatException ignored) {}
            }
        }
        List<Episode> found = new ArrayList<>();
        for (EpisodeLinks row : episodes.values()) {
            String id = catalogEpisodeId(title.id, row.season, row.episode);
            found.add(new Episode(id, title.id, row.season, row.episode, Collections.emptyList(),
                    Collections.emptyMap(), row.links));
        }
        found.sort(Comparator.comparingInt((Episode row) -> row.season).thenComparingInt(row -> row.episode));
        if (found.isEmpty()) throw new IOException("Der Katalog hat keine verfügbaren Folgen oder Videos geliefert.");
        return new Title(title.id, name, poster, title.provider, description, title.isSeries || found.size() > 1,
                found, source.id, title.address);
    }

    Episode resolve(Title title, Episode episode) throws IOException {
        if (!episode.sources.isEmpty()) return episode;
        Catalog source = catalogFor(title);
        Set<String> allowed = new HashSet<>(source.playerHosts);
        allowed.addAll(source.mediaHosts);
        List<Source> found = new ArrayList<>();
        IOException lastFailure = null;
        long deadline = SystemClock.elapsedRealtime() + 16_000;
        for (int index = 0; index < episode.links.size() && SystemClock.elapsedRealtime() < deadline; index++) {
            URI uri = https(episode.links.get(index));
            List<Variant> variants;
            try {
                variants = videoVariants(source, allowed, uri, deadline);
            } catch (IOException failure) {
                lastFailure = failure;
                continue;
            }
            if (!variants.isEmpty()) found.add(new Source("Quelle " + (index + 1), variants));
        }
        if (found.isEmpty()) {
            if (lastFailure != null) throw lastFailure;
            throw new IOException("Keine der Katalogquellen enthält einen direkt abspielbaren Stream.");
        }
        return new Episode(episode.id, title.id, episode.season, episode.episode, found, episode.segments,
                episode.links);
    }

    private static List<Variant> videoVariants(Catalog source, Set<String> allowed, URI uri, long deadline)
            throws IOException {
        if (source.mediaHosts.contains(uri.getHost()) && isMediaPath(uri)) {
            return Collections.singletonList(new Variant(uri.toString(), 0, Collections.emptyMap()));
        }
        Reply reply = download(uri, allowed, true, deadline);
        if (reply.video && source.mediaHosts.contains(reply.uri.getHost())) {
            return Collections.singletonList(new Variant(reply.uri.toString(), 0, Collections.emptyMap()));
        }
        if (reply.video) return Collections.emptyList();
        Document player = Jsoup.parse(reply.body, reply.uri.toString());
        List<Variant> variants = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Element video : player.select("video[src], video source[src]")) {
            String url = address(video.attr("src"), reply.uri);
            if (url == null || !seen.add(url)) continue;
            URI candidate = https(url);
            if (!source.mediaHosts.contains(candidate.getHost())) continue;
            int height = height(video);
            variants.add(new Variant(url, height, Collections.emptyMap()));
            if (variants.size() >= 10) break;
        }
        variants.sort(Comparator.comparingInt((Variant item) -> item.height).reversed());
        return variants;
    }

    private static int height(Element video) {
        for (String attribute : new String[]{"data-height", "height", "label"}) {
            String value = video.attr(attribute).replaceFirst("[pP]$", "");
            try {
                int parsed = Integer.parseInt(value);
                if (parsed > 0 && parsed <= 4320) return parsed;
            } catch (NumberFormatException ignored) {}
        }
        return 0;
    }

    private synchronized Catalog catalogFor(Title title) throws IOException {
        Catalog source = catalogs.get(title.catalogId);
        if (source == null) throw new IOException("Dieser Katalog ist nicht mehr vorhanden.");
        return source;
    }

    private static final class EpisodeLinks {
        final int season, episode;
        final List<String> links = new ArrayList<>();

        EpisodeLinks(int season, int episode) {
            this.season = season;
            this.episode = episode;
        }
    }

    private static void addLink(Map<String, EpisodeLinks> episodes, Set<String> hosts, int season, int episode,
                                String raw, URI base) throws IOException {
        if (season < 1 || season > 999 || episode < 1 || episode > 9999 || episodes.size() >= 500) return;
        String address = address(raw, base);
        if (address == null || !hosts.contains(https(address).getHost())) return;
        String key = season + ":" + episode;
        EpisodeLinks row = episodes.get(key);
        if (row == null) {
            row = new EpisodeLinks(season, episode);
            episodes.put(key, row);
        }
        if (row.links.size() < 6 && !row.links.contains(address)) row.links.add(address);
    }

    private static URI discoverCatalog(Reply website) throws IOException {
        Document document = Jsoup.parse(website.body, website.uri.toString());
        for (Element link : document.select("link[rel][type][href]")) {
            if (!CATALOG_TYPE.equalsIgnoreCase(link.attr("type")) ||
                    !(" " + link.attr("rel").toLowerCase(Locale.ROOT) + " ").contains(" alternate ")) continue;
            String value = address(link.attr("href"), website.uri);
            if (value == null) continue;
            URI result = https(value);
            if (sameOrigin(result, website.uri)) return result;
        }
        return null;
    }

    private static boolean sameOrigin(URI first, URI second) {
        return first.getHost().equals(second.getHost()) && first.getPort() == second.getPort();
    }

    private static String elementText(Element root, String selector) {
        Element element = selector.isEmpty() ? null : root.selectFirst(selector);
        return element == null ? "" : element.text();
    }

    private static String poster(Element item, String title, URI base) {
        Element card = item.closest("article, .short");
        if (card == null) card = item;
        String best = "";
        int highest = -1;
        int checked = 0;
        for (Element image : card.select("img")) {
            if (++checked > 24) break;
            String address = imageAddress(image, base);
            if (address == null) continue;
            int score = image.attr("alt").trim().equalsIgnoreCase(title) ? 8 : 0;
            try {
                int width = Integer.parseInt(image.attr("width"));
                int height = Integer.parseInt(image.attr("height"));
                if (Math.max(width, height) < 64 && score == 0) continue;
                if (height > width) score += 2;
            } catch (NumberFormatException ignored) {}
            if (score > highest) {
                best = address;
                highest = score;
            }
        }
        return best;
    }

    private static final Pattern DECORATIVE_IMAGE = Pattern.compile(
            "(^|[_.-])(logo|icon|placeholder|spacer|blank|spinner|no[-_]?image)([_.-]|$)",
            Pattern.CASE_INSENSITIVE);

    private static String imageAddress(Element image, URI base) {
        if (image == null) return null;
        for (String attribute : new String[]{"data-src", "data-lazy-src", "data-original", "src"}) {
            String url = address(image.attr(attribute), base);
            if (url == null) continue;
            String path = URI.create(url).getPath();
            if (!DECORATIVE_IMAGE.matcher(path.substring(path.lastIndexOf('/') + 1)).find()) return url;
        }
        return null;
    }

    synchronized List<Title> search(String query) {
        String value = normalize(query == null ? "" : query).trim();
        if (value.isEmpty()) return Collections.emptyList();
        String[] terms = value.split("\\s+");
        List<Title> result = new ArrayList<>();
        for (Title title : titles()) {
            String name = normalize(title.title);
            boolean found = true;
            for (String term : terms) found &= name.contains(term);
            if (found) result.add(title);
            if (result.size() >= 100) break;
        }
        return result;
    }

    private static String normalize(String value) {
        return Normalizer.normalize(value.toLowerCase(Locale.GERMAN), Normalizer.Form.NFD).replaceAll("\\p{M}", "");
    }

    private synchronized List<Title> addTitles(List<Title> imported) throws IOException, JSONException {
        LinkedHashMap<String, Title> next = new LinkedHashMap<>(titles);
        for (Title title : imported) {
            next.remove(title.id);
            next.put(title.id, title);
        }
        store(next, catalogs);
        return imported;
    }

    synchronized void remove(Title title) throws IOException, JSONException {
        LinkedHashMap<String, Title> next = new LinkedHashMap<>(titles);
        next.remove(title.id);
        store(next, catalogs);
    }

    private void store(LinkedHashMap<String, Title> nextTitles, LinkedHashMap<String, Catalog> nextCatalogs)
            throws IOException, JSONException {
        store(nextTitles, nextCatalogs, library.edit());
    }

    private void store(LinkedHashMap<String, Title> nextTitles, LinkedHashMap<String, Catalog> nextCatalogs,
                       SharedPreferences.Editor edit) throws IOException, JSONException {
        JSONArray storedTitles = new JSONArray();
        for (Title title : nextTitles.values()) storedTitles.put(storeTitle(title));
        JSONArray storedCatalogs = new JSONArray();
        for (Catalog catalog : nextCatalogs.values()) storedCatalogs.put(catalog.config);
        String encoded = new JSONObject().put("titles", storedTitles).put("catalogs", storedCatalogs).toString();
        if (encoded.length() > MAX_SNAPSHOT) throw new IOException("Die Mediathek hat ihre Speichergrenze erreicht.");
        edit.putString("content", encoded).apply();
        titles = nextTitles;
        catalogs = nextCatalogs;
    }

    private static JSONObject storeTitle(Title title) throws JSONException {
        JSONObject row = new JSONObject().put("id", title.id).put("title", title.title)
                .put("series", title.isSeries).put("poster", title.poster).put("description", title.description);
        if (title.catalogId != null) {
            return row.put("catalog", title.catalogId).put("address", title.address).put("provider", title.provider);
        }
        JSONArray episodes = new JSONArray();
        for (Episode episode : title.episodes) {
            JSONArray sources = new JSONArray();
            for (Source source : episode.sources) {
                JSONArray variants = new JSONArray();
                for (Variant variant : source.variants) {
                    variants.put(new JSONObject().put("url", variant.url).put("height", variant.height)
                            .put("segments", storeSegments(variant.segments)));
                }
                sources.put(new JSONObject().put("name", source.name).put("variants", variants));
            }
            episodes.put(new JSONObject().put("season", episode.season).put("episode", episode.episode)
                    .put("sources", sources).put("segments", storeSegments(episode.segments)));
        }
        return row.put("episodes", episodes);
    }

    private static JSONObject storeSegments(Map<String, Segment> markers) throws JSONException {
        JSONObject result = new JSONObject();
        for (Map.Entry<String, Segment> entry : markers.entrySet()) {
            Segment value = entry.getValue();
            result.put(entry.getKey(), new JSONArray().put(value.startMs / 1000d).put(value.endMs / 1000d));
        }
        return result;
    }

    private static Title restoreTitle(JSONObject row) throws IOException, JSONException {
        String id = row.getString("id");
        String title = row.getString("title");
        String poster = row.optString("poster", "");
        String description = row.optString("description", "");
        boolean series = row.optBoolean("series", false);
        if (row.has("catalog")) {
            return new Title(id, title, poster, row.optString("provider", ""), description, series,
                    Collections.emptyList(), row.getString("catalog"), https(row.getString("address")).toString());
        }
        return new Title(id, title, poster, "", description, series, mediaEpisodes(row, id, series, true), null, null);
    }

    private static final class Reply {
        final URI uri;
        final String type, body;
        final boolean video;

        Reply(URI uri, String type, String body, boolean video) {
            this.uri = uri;
            this.type = type;
            this.body = body;
            this.video = video;
        }
    }

    private static Reply download(URI input, Set<String> allowed, boolean detectMedia) throws IOException {
        return download(input, allowed, detectMedia, SystemClock.elapsedRealtime() + 12_000);
    }

    private static Reply download(URI input, Set<String> allowed, boolean detectMedia, long deadline)
            throws IOException {
        URI uri = input;
        for (int redirects = 0; redirects < 6; redirects++) {
            if (allowed != null && !allowed.contains(uri.getHost())) {
                throw new IOException("Die Quelle verweist auf einen Host außerhalb des Katalogs.");
            }
            int remaining = remaining(deadline);
            HttpsURLConnection connection = (HttpsURLConnection) uri.toURL().openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(Math.min(5000, remaining));
            connection.setReadTimeout(Math.min(6000, remaining));
            connection.setRequestProperty("Accept", "application/json, text/html, video/*, */*;q=0.5");
            connection.setRequestProperty("User-Agent", "KinoTix Fire TV");
            try {
                int code = connection.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    String redirect = address(connection.getHeaderField("Location"), uri);
                    if (redirect == null) throw new IOException("Die Quelle leitet auf eine ungültige Webadresse weiter.");
                    uri = https(redirect);
                    continue;
                }
                if (code < 200 || code >= 300) {
                    throw new IOException("Die Quelle antwortet mit HTTP " + code + ".");
                }
                String type = connection.getContentType();
                type = type == null ? "" : type.toLowerCase(Locale.ROOT).split(";", 2)[0].trim();
                if (detectMedia && isVideoType(type, uri)) return new Reply(uri, type, "", true);
                long size = connection.getContentLengthLong();
                if (size > MAX_INPUT) throw new IOException("Die Quelle liefert mehr als 2 MB Katalogdaten.");
                try (InputStream stream = connection.getInputStream()) {
                    return new Reply(uri, type, body(stream, deadline), false);
                }
            } catch (javax.net.ssl.SSLException error) {
                throw new IOException("Die HTTPS-Verbindung zur Quelle konnte nicht bestätigt werden.", error);
            } catch (java.net.SocketTimeoutException error) {
                throw new IOException("Die Quelle antwortet zu langsam.", error);
            } catch (java.net.UnknownHostException error) {
                throw new IOException("Der Name der Quelle konnte nicht gefunden werden.", error);
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("Die Quelle leitet zu oft weiter.");
    }

    private static String body(InputStream stream, long deadline) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        for (int count; (count = stream.read(chunk)) >= 0;) {
            remaining(deadline);
            if (buffer.size() + count > MAX_INPUT) {
                throw new IOException("Die Quelle liefert mehr als 2 MB Katalogdaten.");
            }
            buffer.write(chunk, 0, count);
        }
        return stripBom(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
    }

    private static int remaining(long deadline) throws IOException {
        long delay = deadline - SystemClock.elapsedRealtime();
        if (delay <= 0) throw new IOException("Die Quelle antwortet zu langsam.");
        return (int) delay;
    }

    private static boolean isVideoType(String type, URI uri) {
        return type.startsWith("video/") || type.equals("application/vnd.apple.mpegurl") ||
                type.equals("application/x-mpegurl") || type.equals("audio/mpegurl") ||
                type.equals("audio/x-mpegurl") ||
                ((type.isEmpty() || type.equals("application/octet-stream")) && isMediaPath(uri));
    }

    private static boolean isMediaPath(URI uri) {
        return MEDIA_PATH.matcher(uri.getPath()).matches();
    }

    private static URI directHttps(String value) throws IOException {
        int hash = value.indexOf('#');
        return https(hash >= 0 ? value.substring(0, hash) : value);
    }

    private static URI https(String value) throws IOException {
        if (value == null || value.isEmpty() || value.length() > 2048 || value.indexOf('\\') >= 0) {
            throw new IOException("Gib eine vollständige HTTPS-Adresse ein.");
        }
        try {
            URI raw = new URI(value).normalize();
            String host = raw.getHost();
            if (!"https".equalsIgnoreCase(raw.getScheme()) || host == null || raw.getRawUserInfo() != null ||
                    raw.getRawFragment() != null || !HOST.matcher(host.toLowerCase(Locale.ROOT)).matches() ||
                    raw.getPort() > 65535 || raw.getPort() == 0) {
                throw new IOException("Kataloge und Videos brauchen HTTPS-Adressen ohne Zugangsdaten.");
            }
            String port = raw.getPort() == -1 || raw.getPort() == 443 ? "" : ":" + raw.getPort();
            String path = raw.getRawPath().isEmpty() ? "/" : raw.getRawPath();
            String query = raw.getRawQuery() == null ? "" : "?" + raw.getRawQuery();
            URI address = URI.create("https://" + host.toLowerCase(Locale.ROOT) + port + path + query);
            return URI.create(address.toASCIIString());
        } catch (URISyntaxException | IllegalArgumentException error) {
            throw new IOException("Die HTTPS-Adresse ist ungültig.", error);
        }
    }

    private static String address(String input, URI base) {
        if (input == null || input.trim().isEmpty() || input.length() > 2048) return null;
        try {
            URI uri = base == null ? new URI(input.trim()) : base.resolve(input.trim());
            return https(uri.toString()).toString();
        } catch (URISyntaxException | IllegalArgumentException | IOException error) {
            return null;
        }
    }

    private static Set<String> hostSet(JSONArray array) throws IOException, JSONException {
        Set<String> hosts = new HashSet<>();
        if (array == null) return hosts;
        if (array.length() > 20) throw new IOException("Die Hostliste des Katalogs ist zu lang.");
        for (int index = 0; index < array.length(); index++) {
            Object value = array.opt(index);
            if (!(value instanceof String)) throw new IOException("Die Hostliste des Katalogs ist ungültig.");
            String host = ((String) value).toLowerCase(Locale.ROOT);
            if (!HOST.matcher(host).matches()) throw new IOException("Die Hostliste des Katalogs ist ungültig.");
            hosts.add(host);
        }
        return hosts;
    }

    private static Catalog portableCopy(Catalog input) throws IOException, JSONException {
        JSONObject source = input.config;
        URI base = https(input.origin);
        JSONObject result = new JSONObject().put("version", 1).put("id", source.getString("id"))
                .put("name", requiredText(source, "name", 80))
                .put("origin", base.toString().substring(0, base.toString().length() - 1));
        for (String field : new String[]{"catalogHosts", "playerHosts", "mediaHosts", "resourceHosts"}) {
            Object raw = source.opt(field);
            if (raw != null && raw != JSONObject.NULL && !(raw instanceof JSONArray)) {
                throw new IOException("Die Hostliste des Katalogs ist ungültig.");
            }
            JSONArray hosts = raw instanceof JSONArray ? (JSONArray) raw : null;
            Set<String> allowed = hostSet(hosts);
            List<String> sorted = new ArrayList<>(allowed);
            Collections.sort(sorted);
            result.put(field, new JSONArray(sorted));
        }
        if (!source.isNull("index")) {
            URI index = https(source.getString("index"));
            Set<String> hosts = hostSet(result.getJSONArray("catalogHosts"));
            hosts.add(base.getHost());
            if (!hosts.contains(index.getHost()) || index.getRawQuery() != null) {
                throw new IOException("Der Suchindex muss zum Katalog gehören.");
            }
            result.put("index", index.toString());
        }
        JSONObject listing = portableRules(source.getJSONObject("listing"), "root", "items");
        JSONObject detail = portableRules(source.getJSONObject("detail"), "title", "description", "poster",
                "imdb", "groups", "controls", "episodeAttribute", "sourceAttribute", "iframe", "seriesPrefix",
                "embedPattern");
        JSONObject player = portableRules(source.optJSONObject("player"), "variants");
        return new Catalog(result.put("listing", listing).put("detail", detail).put("player", player));
    }

    private static JSONObject portableRules(JSONObject input, String... keys) throws IOException, JSONException {
        JSONObject result = new JSONObject();
        if (input == null) return result;
        for (String key : keys) {
            Object raw = input.opt(key);
            if (raw == null || raw == JSONObject.NULL) continue;
            if (!(raw instanceof String) || ((String) raw).length() > 450) {
                throw new IOException("Der Katalog enthält eine ungültige Auswahlregel.");
            }
            String rule = ((String) raw).trim();
            if (!rule.isEmpty()) result.put(key, rule);
        }
        return result;
    }

    private static String selector(JSONObject object, String key, boolean required) throws IOException {
        String value = object.optString(key, "").trim();
        if (value.isEmpty() && !required) return value;
        if (value.isEmpty() || value.length() > 450 ||
                value.toLowerCase(Locale.ROOT).contains(":matches") || value.contains("~=")) {
            throw new IOException("Der Katalog verwendet eine nicht unterstützte Auswahlregel.");
        }
        try {
            org.jsoup.select.QueryParser.parse(value);
        } catch (IllegalArgumentException | org.jsoup.select.Selector.SelectorParseException error) {
            throw new IOException("Die Auswahlregel des Katalogs ist ungültig.", error);
        }
        return value;
    }

    private static String requiredText(JSONObject input, String key, int maximum) throws JSONException {
        Object raw = input.opt(key);
        if (!(raw instanceof String) || ((String) raw).trim().isEmpty()) {
            throw new JSONException("Der Eintrag braucht " + key + ".");
        }
        return shorten((String) raw, maximum);
    }

    private static int exactInt(Object value, int minimum, int maximum) {
        if (!(value instanceof Number)) return -1;
        double number = ((Number) value).doubleValue();
        int rounded = ((Number) value).intValue();
        return number == rounded && rounded >= minimum && rounded <= maximum ? rounded : -1;
    }

    private static String shorten(String value, int maximum) {
        String text = value.trim();
        return text.length() > maximum ? text.substring(0, maximum) : text;
    }

    private static String stripBom(String text) {
        return !text.isEmpty() && text.charAt(0) == 0xfeff ? text.substring(1) : text;
    }

    private static <T> List<T> immutable(Collection<T> list) {
        return Collections.unmodifiableList(new ArrayList<>(list));
    }

    private static String digest(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            char[] result = new char[bytes.length * 2];
            char[] hex = "0123456789abcdef".toCharArray();
            for (int index = 0; index < bytes.length; index++) {
                int b = bytes[index] & 255;
                result[index * 2] = hex[b >>> 4];
                result[index * 2 + 1] = hex[b & 15];
            }
            return new String(result);
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }
}
