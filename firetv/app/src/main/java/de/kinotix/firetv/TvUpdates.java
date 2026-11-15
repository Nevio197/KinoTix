package de.kinotix.firetv;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.provider.OpenableColumns;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;

final class TvUpdates implements AutoCloseable {
    private static final String REPOSITORY = "Nevio197/KinoTix";
    private static final String RELEASES = "https://api.github.com/repos/" + REPOSITORY + "/releases";
    private static final int RELEASE_PAGE_SIZE = 30;
    private static final int MAX_RELEASE_PAGES = 2;
    private static final String TAG_PREFIX = "firetv-v";
    private static final String APK_TYPE = "application/vnd.android.package-archive";
    private static final String APK_NAME = "KinoTix-Update.apk";
    private static final String VERSION_PATTERN = "(0|[1-9][0-9]{0,8})(\\.(0|[1-9][0-9]{0,8})){2}";
    private static final int MAX_METADATA = 1024 * 1024;
    private static final long MAX_APK = 128L * 1024 * 1024;

    enum Phase { IDLE, CHECKING, CURRENT, NO_APK, AVAILABLE, DOWNLOADING, READY, ERROR }

    interface Listener {
        void onUpdate(State state);
    }

    static final class State {
        final Phase phase;
        final String message;
        final String version;
        final int percent;

        State(Phase phase, String message, String version, int percent) {
            this.phase = phase;
            this.message = message;
            this.version = version;
            this.percent = percent;
        }
    }

    private static final class Asset {
        final String version;
        final URL url;
        final long size;
        final byte[] digest;

        Asset(String version, URL url, long size, byte[] digest) {
            this.version = version;
            this.url = url;
            this.size = size;
            this.digest = digest;
        }
    }

    private final Activity activity;
    private final Listener listener;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean closed;
    private volatile HttpsURLConnection activeRequest;
    private State state = new State(Phase.IDLE, "KinoTix sucht beim Start auf GitHub nach Updates.", null, 0);
    private Asset offered;

    TvUpdates(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
    }

    State state() {
        return state;
    }

    void check() {
        if (closed || state.phase == Phase.CHECKING || state.phase == Phase.DOWNLOADING) return;
        offered = null;
        publish(Phase.CHECKING, "Suche auf GitHub nach einem Fire-TV-Update …", null, 0);
        worker.execute(this::checkRelease);
    }

    private void checkRelease() {
        try {
            Asset asset = readLatestAsset();
            if (asset == null) {
                post(() -> publish(Phase.NO_APK, "Auf GitHub ist keine Fire-TV-APK verfügbar.", null, 0));
                return;
            }
            String current = currentPackage(0).versionName;
            if (compare(asset.version, current) <= 0) {
                post(() -> publish(Phase.CURRENT, "KinoTix ist aktuell.", asset.version, 0));
                return;
            }
            post(() -> {
                offered = asset;
                publish(Phase.AVAILABLE, "Version " + asset.version + " ist verfügbar.", asset.version, 0);
            });
        } catch (IOException | JSONException | PackageManager.NameNotFoundException error) {
            post(() -> publish(Phase.ERROR, "GitHub konnte gerade nicht auf Updates geprüft werden.", null, 0));
        }
    }

    void download() {
        if (closed || offered == null || state.phase != Phase.AVAILABLE) return;
        Asset asset = offered;
        publish(Phase.DOWNLOADING, "Update wird heruntergeladen …", asset.version, 0);
        worker.execute(() -> downloadAsset(asset));
    }

    private void downloadAsset(Asset asset) {
        File temporary = null;
        try {
            File ready = apkFile(activity);
            File directory = ready.getParentFile();
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Update cache");
            temporary = File.createTempFile("pending-", ".apk", directory);
            copyAndVerifyDigest(asset, temporary);
            verifyApk(temporary, asset.version);
            if (closed || !temporary.renameTo(ready)) throw new IOException("Update cache");
            post(() -> publish(Phase.READY, "Version " + asset.version + " ist bereit zur Installation.", asset.version, 100));
        } catch (IOException | PackageManager.NameNotFoundException | SecurityException error) {
            post(() -> publish(Phase.ERROR, "Das Update konnte nicht geladen oder verifiziert werden.", asset.version, 0));
        } finally {
            if (temporary != null && temporary.isFile()) temporary.delete();
        }
    }

    void install() {
        if (closed || state.phase != Phase.READY) return;
        final String version = state.version;
        if (!apkFile(activity).isFile()) {
            publish(Phase.AVAILABLE, "Der Download muss wiederholt werden.", version, 0);
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.fromParts("package", activity.getPackageName(), null));
                activity.startActivity(settings);
                publish(Phase.READY, "Erlaube KinoTix als Installationsquelle und wähle erneut Installieren.", version, 100);
                return;
            }
            Uri uri = apkUri(activity);
            Intent install = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, APK_TYPE);
            install.setClipData(ClipData.newRawUri(APK_NAME, uri));
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(install);
            publish(Phase.READY, "Bestätige die Installation im Fire-TV-Installer.", version, 100);
        } catch (ActivityNotFoundException | SecurityException error) {
            publish(Phase.READY, "Der Fire-TV-Installer ist hier nicht verfügbar. Lade die APK von GitHub und installiere sie über ADB.", version, 100);
        }
    }

    @Override public void close() {
        closed = true;
        HttpsURLConnection request = activeRequest;
        if (request != null) request.disconnect();
        worker.shutdownNow();
    }

    private void publish(Phase phase, String message, String version, int percent) {
        if (closed) return;
        state = new State(phase, message, version, percent);
        listener.onUpdate(state);
    }

    private void post(Runnable work) {
        activity.runOnUiThread(() -> {
            if (!closed) work.run();
        });
    }

    private Asset readLatestAsset() throws IOException, JSONException {
        Asset latest = null;
        for (int page = 1; page <= MAX_RELEASE_PAGES; page++) {
            JSONArray releases = readReleasePage(page);
            Asset candidate = findAsset(releases);
            if (candidate != null && (latest == null || compare(candidate.version, latest.version) > 0)) {
                latest = candidate;
            }
            if (releases.length() < RELEASE_PAGE_SIZE) break;
        }
        return latest;
    }

    private JSONArray readReleasePage(int page) throws IOException, JSONException {
        HttpsURLConnection connection = request(new URL(releasePage(page)), true);
        try (InputStream input = connection.getInputStream()) {
            long deadline = SystemClock.elapsedRealtime() + 30_000;
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] bytes = new byte[8192];
            for (int count; (count = input.read(bytes)) != -1;) {
                ensureTimeRemaining(deadline);
                if (buffer.size() + count > MAX_METADATA) throw new IOException("GitHub response too large");
                buffer.write(bytes, 0, count);
            }
            return new JSONArray(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            disconnect(connection);
        }
    }

    private static Asset findAsset(JSONArray releases) throws IOException {
        Asset latest = null;
        for (int i = 0; i < releases.length(); i++) {
            JSONObject release = releases.optJSONObject(i);
            if (release == null || release.optBoolean("draft", true)) continue;
            Asset candidate = findReleaseAsset(release);
            if (candidate != null && (latest == null || compare(candidate.version, latest.version) > 0)) {
                latest = candidate;
            }
        }
        return latest;
    }

    private static Asset findReleaseAsset(JSONObject release) throws IOException {
        String tag = release.optString("tag_name");
        if (!tag.matches(TAG_PREFIX + VERSION_PATTERN)) return null;
        String version = tag.substring(TAG_PREFIX.length());
        String name = "KinoTix-" + version + "-FireTV.apk";
        String expectedUrl = "https://github.com/" + REPOSITORY + "/releases/download/" + tag + "/" + name;
        JSONArray assets = release.optJSONArray("assets");
        if (assets == null) return null;
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.optJSONObject(i);
            if (asset == null || !name.equals(asset.optString("name"))) continue;
            long size = asset.optLong("size", -1);
            String checksum = asset.optString("digest");
            if (!"uploaded".equals(asset.optString("state")) || !expectedUrl.equals(asset.optString("browser_download_url"))
                    || size <= 0 || size > MAX_APK || !checksum.matches("sha256:[a-fA-F0-9]{64}")) {
                continue;
            }
            byte[] digest = new byte[32];
            for (int j = 0; j < digest.length; j++) {
                int index = 7 + j * 2;
                digest[j] = (byte) Integer.parseInt(checksum.substring(index, index + 2), 16);
            }
            return new Asset(version, new URL(expectedUrl), size, digest);
        }
        return null;
    }

    private void copyAndVerifyDigest(Asset asset, File target) throws IOException {
        HttpsURLConnection connection = request(asset.url, false);
        try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(target)) {
            MessageDigest digest = sha256();
            byte[] bytes = new byte[32 * 1024];
            long size = 0;
            long deadline = SystemClock.elapsedRealtime() + 300_000;
            int lastPercent = 0;
            for (int count; (count = input.read(bytes)) != -1;) {
                ensureTimeRemaining(deadline);
                size += count;
                if (size > asset.size) throw new IOException("APK size mismatch");
                digest.update(bytes, 0, count);
                output.write(bytes, 0, count);
                int percent = (int) (size * 100 / asset.size);
                if (percent != lastPercent) {
                    lastPercent = percent;
                    post(() -> publish(Phase.DOWNLOADING, "Update wird heruntergeladen …", asset.version, percent));
                }
            }
            if (size != asset.size || !MessageDigest.isEqual(asset.digest, digest.digest())) {
                throw new IOException("APK checksum mismatch");
            }
        } finally {
            disconnect(connection);
        }
    }

    private void verifyApk(File file, String version) throws PackageManager.NameNotFoundException, IOException {
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo current = currentPackage(flags);
        PackageInfo candidate = activity.getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), flags);
        if (candidate == null || !current.packageName.equals(candidate.packageName) || !version.equals(candidate.versionName)
                || versionCode(candidate) <= versionCode(current)) throw new IOException("APK identity or version mismatch");
        Signature[] currentSigners = signers(current);
        Signature[] candidateSigners = signers(candidate);
        if (currentSigners == null || candidateSigners == null || currentSigners.length == 0
                || !new HashSet<>(Arrays.asList(currentSigners)).equals(new HashSet<>(Arrays.asList(candidateSigners)))) {
            throw new IOException("APK signature mismatch");
        }
    }

    private PackageInfo currentPackage(int flags) throws PackageManager.NameNotFoundException {
        return activity.getPackageManager().getPackageInfo(activity.getPackageName(), flags);
    }

    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    private static Signature[] signers(PackageInfo info) {
        if (Build.VERSION.SDK_INT < 28) return info.signatures;
        return info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners();
    }

    private HttpsURLConnection request(URL url, boolean metadata) throws IOException {
        for (int redirects = 0; redirects < 6; redirects++) {
            ensureAllowedUrl(url, metadata);
            if (closed) throw new IOException("Update stopped");
            HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
            activeRequest = connection;
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(8_000);
            connection.setReadTimeout(15_000);
            connection.setRequestProperty("User-Agent", "KinoTix-FireTV");
            connection.setRequestProperty("Accept", metadata ? "application/vnd.github+json" : "application/octet-stream");
            if (metadata) connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
            try {
                int status = connection.getResponseCode();
                if (status == 200) return connection;
                String location = connection.getHeaderField("Location");
                if (metadata || location == null || (status != 301 && status != 302 && status != 303 && status != 307 && status != 308)) {
                    throw new IOException("GitHub status " + status);
                }
                url = new URL(url, location);
            } catch (IOException | RuntimeException error) {
                disconnect(connection);
                throw error;
            }
            disconnect(connection);
        }
        throw new IOException("Too many GitHub redirects");
    }

    private static void ensureAllowedUrl(URL url, boolean metadata) throws IOException {
        String host = url.getHost();
        boolean allowed = metadata ? isReleasePage(url.toExternalForm())
                : "github.com".equals(host) || "release-assets.githubusercontent.com".equals(host)
                        || "objects.githubusercontent.com".equals(host);
        if (!allowed || !"https".equals(url.getProtocol()) || url.getUserInfo() != null
                || (url.getPort() != -1 && url.getPort() != 443)) throw new IOException("Non-GitHub update URL");
    }

    private static boolean isReleasePage(String url) {
        for (int page = 1; page <= MAX_RELEASE_PAGES; page++) {
            if (releasePage(page).equals(url)) return true;
        }
        return false;
    }

    private static String releasePage(int page) {
        return RELEASES + "?per_page=" + RELEASE_PAGE_SIZE + "&page=" + page;
    }

    private void disconnect(HttpsURLConnection connection) {
        connection.disconnect();
        if (activeRequest == connection) activeRequest = null;
    }

    private void ensureTimeRemaining(long deadline) throws IOException {
        if (closed || SystemClock.elapsedRealtime() > deadline) throw new IOException("Update stopped or expired");
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static int compare(String candidate, String installed) throws IOException {
        if (installed == null || !installed.matches(VERSION_PATTERN)) throw new IOException("Installed version format");
        String[] newer = candidate.split("\\.");
        String[] current = installed.split("\\.");
        for (int i = 0; i < newer.length; i++) {
            int order = Integer.compare(Integer.parseInt(newer[i]), Integer.parseInt(current[i]));
            if (order != 0) return order;
        }
        return 0;
    }

    private static File apkFile(Context context) {
        return new File(new File(context.getCacheDir(), "kinotix-update"), APK_NAME);
    }

    private static Uri apkUri(Context context) {
        return new Uri.Builder().scheme("content").authority(context.getPackageName() + ".updates").appendPath(APK_NAME).build();
    }

    public static final class ApkProvider extends ContentProvider {
        @Override public boolean onCreate() { return true; }

        @Override public String getType(Uri uri) {
            return apkUri(getContext()).equals(uri) ? APK_TYPE : null;
        }

        @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
            if (!"r".equals(mode) || getType(uri) == null) throw new FileNotFoundException("Unknown APK");
            return ParcelFileDescriptor.open(apkFile(getContext()), ParcelFileDescriptor.MODE_READ_ONLY);
        }

        @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
            if (getType(uri) == null) throw new IllegalArgumentException("Unknown APK");
            String[] columns = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
            File file = apkFile(getContext());
            MatrixCursor cursor = new MatrixCursor(columns, 1);
            MatrixCursor.RowBuilder row = cursor.newRow();
            for (String column : columns) {
                if (OpenableColumns.DISPLAY_NAME.equals(column)) row.add(APK_NAME);
                else if (OpenableColumns.SIZE.equals(column)) row.add(file.length());
                else row.add(null);
            }
            return cursor;
        }

        @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
        @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
        @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
    }
}
