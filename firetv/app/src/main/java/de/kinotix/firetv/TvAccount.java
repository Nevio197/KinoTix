package de.kinotix.firetv;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;

final class TvAccount implements AutoCloseable {
    private static final String AUTH = "/auth/v1/";
    private static final String TV_AUTH = "/functions/v1/kinotix-tv-auth";
    private static final String SYNC_TABLE = "/rest/v1/kinotix_sync?";
    private static final String MERGE_RPC = "/rest/v1/rpc/kinotix_merge";
    private static final String LOOPBACK = "127.0.0.1";
    private static final String SILK_PACKAGE = "com.amazon.cloud9";
    private static final String KEY_ALIAS = "kinotix-firetv-account-v1";
    private static final String CIPHER = "AES/GCM/NoPadding";
    private static final String UUID = "[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}";
    private static final String SIGN_IN_ERROR = "Die Google-Anmeldung ist gerade nicht möglich.";
    private static final Object SESSION_LOCK = new Object();
    private static final int MAX_RESPONSE = 4 * 1024 * 1024;
    private static final int REQUEST_TIMEOUT_MS = 8_000;
    private static final int SIGN_IN_TIMEOUT_MS = 180_000;
    private static final int QR_TIMEOUT_MS = 300_000;
    private static final int QR_POLL_INTERVAL_MS = 2_500;

    private enum Phase { UNCONFIGURED, SIGNED_OUT, RESTORING, SIGNING_IN, CONFIRMING, CONNECTED, SIGNING_OUT }

    interface Listener {
        void onAccount(State state);
    }

    static final class State {
        final boolean configured;
        final boolean connected;
        final boolean signingIn;
        final boolean awaitingConfirmation;
        final boolean restoring;
        final boolean signingOut;
        final String id;
        final String email;
        final String message;
        final String qrUrl;

        private State(Phase phase, Session owner, String message, String qrUrl) {
            configured = phase != Phase.UNCONFIGURED;
            connected = phase == Phase.CONNECTED;
            awaitingConfirmation = phase == Phase.CONFIRMING;
            signingIn = phase == Phase.SIGNING_IN || awaitingConfirmation;
            restoring = phase == Phase.RESTORING;
            signingOut = phase == Phase.SIGNING_OUT;
            id = owner == null || !connected ? "" : owner.id;
            email = owner == null ? "" : owner.email;
            this.message = message;
            this.qrUrl = qrUrl;
        }
    }

    private static final class Config {
        final String origin;
        final String key;

        Config(String origin, String key) {
            this.origin = origin;
            this.key = key;
        }
    }

    private static final class Session {
        final String id;
        final String email;
        final String refresh;
        final String access;
        final long expiresAt;

        Session(String id, String email, String refresh, String access, long expiresAt) {
            this.id = id;
            this.email = email;
            this.refresh = refresh;
            this.access = access;
            this.expiresAt = expiresAt;
        }
    }

    private static final class PhoneCode {
        final String code;
        final long deadline;

        PhoneCode(String code, long deadline) {
            this.code = code;
            this.deadline = deadline;
        }
    }

    private static final class Confirmation {
        final long deadline;
        final CountDownLatch signal = new CountDownLatch(1);
        boolean accepted;

        Confirmation(long deadline) {
            this.deadline = deadline;
        }
    }

    private static final class HttpError extends IOException {
        private static final long serialVersionUID = 1L;
        final int status;

        HttpError(int status) {
            super("KinoTix-Konto nicht erreichbar (HTTP " + status + ").");
            this.status = status;
        }
    }

    private static final class SignInError extends IOException {
        private static final long serialVersionUID = 1L;

        SignInError(String message) {
            super(message);
        }
    }

    private final Activity activity;
    private final Listener listener;
    private final Config config;
    private final AtomicFile credentials;
    private final ExecutorService control = Executors.newSingleThreadExecutor();
    private final SecureRandom random = new SecureRandom();
    private volatile State state;
    private volatile boolean closed;
    private volatile long generation;
    private volatile ServerSocket callbackServer;
    private volatile String browserIssue;
    private volatile Confirmation confirmation;
    private Session session;
    private long signedInGeneration = -1;
    private boolean started;

    TvAccount(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
        config = loadConfig(activity);
        credentials = new AtomicFile(new File(activity.getNoBackupFilesDir(), "kinotix-supabase-session"));
        state = config == null
                ? new State(Phase.UNCONFIGURED, null, "Google-Anmeldung ist für diesen Build noch nicht eingerichtet.", null)
                : new State(Phase.SIGNED_OUT, null, "", null);
    }

    State state() {
        return state;
    }

    void start() {
        if (started || closed) return;
        started = true;
        if (config == null || state.signingIn || state.connected) return;
        long attempt = generation;
        publish(Phase.RESTORING, null, "Gespeicherte Anmeldung wird geladen …");
        control.execute(() -> restore(attempt));
    }

    private void restore(long attempt) {
        try {
            Session saved;
            synchronized (SESSION_LOCK) {
                if (!isCurrent(attempt)) return;
                saved = readSession();
                session = saved;
            }
            post(attempt, () -> publish(Phase.CONNECTED, saved, ""));
        } catch (FileNotFoundException error) {
            post(attempt, () -> publish(Phase.SIGNED_OUT, null, ""));
        } catch (IOException | JSONException | GeneralSecurityException error) {
            post(attempt, () -> publish(Phase.SIGNED_OUT, null, "Die gespeicherte Anmeldung konnte nicht geöffnet werden."));
        }
    }

    void signIn() {
        signIn(false);
    }

    void signInQr() {
        signIn(true);
    }

    private void signIn(boolean qr) {
        State status = state;
        if (closed || !status.configured || status.connected || status.signingIn || status.restoring || status.signingOut) return;
        long attempt = ++generation;
        browserIssue = null;
        publish(Phase.SIGNING_IN, null, qr ? "QR-Code wird geladen …" : "Öffne die Google-Anmeldung im Browser …");
        control.execute(() -> authorize(attempt, qr));
    }

    private void authorize(long attempt, boolean qr) {
        Session verified = null;
        String issuedAccess = null;
        boolean retained = false;
        try {
            if (!isCurrent(attempt)) return;
            // Prove that secure storage is available before asking the user to sign in.
            secureKey(true);
            String verifier = randomValue();
            PhoneCode phoneCode = qr ? awaitPhoneCode(attempt, verifier) : null;
            String code = phoneCode != null ? phoneCode.code : awaitCode(attempt, verifier);
            if (!isCurrent(attempt)) return;
            JSONObject data = new JSONObject().put("auth_code", code).put("code_verifier", verifier);
            JSONObject granted = token("pkce", data);
            issuedAccess = tokenValue(granted, "access_token");
            verified = verifySession(granted, null);
            if (phoneCode != null) awaitConfirmation(attempt, verified, phoneCode.deadline);
            synchronized (SESSION_LOCK) {
                if (!isCurrent(attempt)) return;
                storeSession(verified);
                if (attempt != generation) {
                    credentials.delete();
                    return;
                }
                session = verified;
                signedInGeneration = attempt;
                retained = true;
            }
            Session owner = verified;
            post(attempt, () -> publish(Phase.CONNECTED, owner, ""));
        } catch (SignInError error) {
            post(attempt, () -> publish(Phase.SIGNED_OUT, null, error.getMessage()));
        } catch (GeneralSecurityException error) {
            post(attempt, () -> publish(Phase.SIGNED_OUT, null, "Der sichere Gerätespeicher ist gerade nicht verfügbar."));
        } catch (IOException | JSONException error) {
            post(attempt, () -> publish(Phase.SIGNED_OUT, null, SIGN_IN_ERROR));
        } finally {
            if (!retained && verified != null) revoke(verified);
            else if (!retained && issuedAccess != null) revokeAccess(issuedAccess);
        }
    }

    void cancelSignIn() {
        if (closed || !state.signingIn) return;
        long cancelled = generation;
        ++generation;
        closeCallback();
        wakeConfirmation();
        control.execute(() -> {
            Session ended;
            synchronized (SESSION_LOCK) {
                if (signedInGeneration != cancelled || session == null) return;
                ended = session;
                session = null;
                credentials.delete();
            }
            revoke(ended);
        });
        publish(Phase.SIGNED_OUT, null, "Anmeldung abgebrochen.");
    }

    void confirmSignIn() {
        Confirmation pending = confirmation;
        if (closed || !state.awaitingConfirmation || pending == null) return;
        if (SystemClock.elapsedRealtime() < pending.deadline) {
            pending.accepted = true;
            publish(Phase.SIGNING_IN, null, "Das Google-Konto wird verbunden …");
        }
        pending.signal.countDown();
    }

    void signOut() {
        if (closed || !state.connected) return;
        long attempt = ++generation;
        publish(Phase.SIGNING_OUT, null, "Das Konto wird auf diesem Gerät abgemeldet …");
        control.execute(() -> {
            Session ended;
            synchronized (SESSION_LOCK) {
                ended = session;
                session = null;
                credentials.delete();
            }
            post(attempt, () -> publish(Phase.SIGNED_OUT, null, ""));
            if (ended != null) revoke(ended);
        });
    }

    private void revoke(Session ended) {
        try {
            String access = ended.access;
            if (access.isEmpty() || ended.expiresAt < SystemClock.elapsedRealtime()) {
                JSONObject refreshed = token("refresh_token", new JSONObject().put("refresh_token", ended.refresh));
                access = tokenValue(refreshed, "access_token");
            }
            revokeAccess(access);
        } catch (IOException | JSONException ignored) {
            // A failed network request must not restore the local sign-in.
        }
    }

    private void revokeAccess(String access) {
        try {
            api("POST", AUTH + "logout?scope=local", null, access);
        } catch (IOException ignored) {
            // A failed network request must not restore the local sign-in.
        }
    }

    private PhoneCode awaitPhoneCode(long attempt, String verifier) throws IOException, JSONException, GeneralSecurityException {
        long deadline = SystemClock.elapsedRealtime() + QR_TIMEOUT_MS;
        String readToken = randomValue();
        JSONObject start = new JSONObject()
                .put("challenge", sha256Base64Url(verifier))
                .put("readHash", sha256Base64Url(readToken));
        JSONObject ticket = new JSONObject(api("POST", TV_AUTH + "/start", start, null));
        String id = requiredString(ticket, "id");
        String url = requiredString(ticket, "url");
        long expiresIn = ticket.optLong("expiresIn", -1);
        if (!validQrUrl(config.origin, id, url) || expiresIn <= 0 || expiresIn > QR_TIMEOUT_MS / 1000) {
            throw new SignInError("Der Anmeldedienst hat keinen gültigen QR-Code geliefert.");
        }
        deadline = Math.min(deadline, SystemClock.elapsedRealtime() + expiresIn * 1000);
        requireActiveQr(attempt, deadline);
        post(attempt, () -> publish(Phase.SIGNING_IN, null, "Scanne den QR-Code mit deinem Handy.", url));
        JSONObject poll = new JSONObject().put("id", id).put("readToken", readToken);
        while (isCurrent(attempt)) {
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0) break;
            try {
                TimeUnit.MILLISECONDS.sleep(Math.min(remaining, QR_POLL_INTERVAL_MS));
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new SignInError("Anmeldung abgebrochen.");
            }
            requireActiveQr(attempt, deadline);
            JSONObject response;
            try {
                response = new JSONObject(api("POST", TV_AUTH + "/poll", poll, null));
            } catch (HttpError error) {
                if (error.status == 429) continue;
                if (error.status == 410) throw new SignInError("Der QR-Code ist abgelaufen.");
                throw error;
            }
            requireActiveQr(attempt, deadline);
            String status = response.optString("status");
            if ("pending".equals(status)) continue;
            if ("expired".equals(status)) break;
            if ("ready".equals(status)) {
                String code = requiredString(response, "code");
                if (!code.matches("[A-Za-z0-9._~-]{8,512}")) throw new SignInError(SIGN_IN_ERROR);
                post(attempt, () -> publish(Phase.SIGNING_IN, null, "Das Google-Konto wird geprüft …"));
                return new PhoneCode(code, deadline);
            }
            throw new SignInError(SIGN_IN_ERROR);
        }
        requireActiveQr(attempt, deadline);
        throw new SignInError("Der QR-Code ist abgelaufen.");
    }

    private static boolean validQrUrl(String origin, String id, String url) {
        if (!id.matches("[A-Za-z0-9_-]{22}")) return false;
        String prefix = origin + TV_AUTH + "/login/" + id + "/";
        return url.startsWith(prefix) && url.substring(prefix.length()).matches("[A-Za-z0-9_-]{43}");
    }

    private void requireActiveQr(long attempt, long deadline) throws SignInError {
        if (!isCurrent(attempt)) throw new SignInError("Anmeldung abgebrochen.");
        if (SystemClock.elapsedRealtime() >= deadline) throw new SignInError("Der QR-Code ist abgelaufen.");
    }

    private void awaitConfirmation(long attempt, Session verified, long deadline) throws SignInError {
        requireActiveQr(attempt, deadline);
        Confirmation pending = new Confirmation(deadline);
        confirmation = pending;
        try {
            post(attempt, () -> publish(Phase.CONFIRMING, verified, "Bestätige dieses Google-Konto am Fernseher."));
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (!isCurrent(attempt) || remaining <= 0
                    || !pending.signal.await(remaining, TimeUnit.MILLISECONDS) || !pending.accepted) {
                requireActiveQr(attempt, deadline);
                throw new SignInError("Das Google-Konto wurde nicht bestätigt.");
            }
            requireActiveQr(attempt, deadline);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new SignInError("Anmeldung abgebrochen.");
        } finally {
            confirmation = null;
        }
    }

    private void wakeConfirmation() {
        Confirmation pending = confirmation;
        if (pending != null) pending.signal.countDown();
    }

    /** Called by the sync worker with the account ID it is currently processing. */
    String request(String ownerId, String method, String route, JSONObject body) throws IOException {
        if (!isSyncRoute(method, route) || ("POST".equals(method) != (body != null))) {
            throw new IOException("Ungültige KinoTix-Synchronisierungsanfrage.");
        }
        long attempt = generation;
        Session owner = activeSession(ownerId, attempt, null);
        try {
            return requestWithSession(owner, attempt, method, route, body);
        } catch (HttpError error) {
            if (error.status != 401) throw error;
            Session refreshed = activeSession(ownerId, attempt, owner);
            return requestWithSession(refreshed, attempt, method, route, body);
        }
    }

    private String requestWithSession(Session owner, long attempt, String method, String route, JSONObject body) throws IOException {
        if (!isCurrent(attempt)) throw new IOException("Die Sitzung wurde beendet.");
        String result = api(method, route, body, owner.access);
        if (!isCurrent(attempt)) throw new IOException("Die Sitzung wurde beendet.");
        return result;
    }

    private Session activeSession(String ownerId, long attempt, Session rejected) throws IOException {
        synchronized (SESSION_LOCK) {
            if (!isCurrent(attempt) || !state.connected || session == null || !session.id.equals(ownerId)) {
                throw new IOException("Die Sitzung wurde beendet.");
            }
            Session owner = session;
            if (owner.expiresAt - 60_000 > SystemClock.elapsedRealtime() && owner != rejected) return owner;
            try {
                JSONObject data = token("refresh_token", new JSONObject().put("refresh_token", owner.refresh));
                Session refreshed = verifySession(data, owner.id);
                if (attempt != generation) throw new IOException("Die Sitzung wurde beendet.");
                storeSession(refreshed);
                session = refreshed;
                return refreshed;
            } catch (HttpError error) {
                if (attempt == generation && (error.status == 400 || error.status == 401 || error.status == 403)) {
                    session = null;
                    credentials.delete();
                    post(attempt, () -> publish(Phase.SIGNED_OUT, null, "Die Anmeldung ist abgelaufen. Melde dich erneut an."));
                }
                throw error;
            } catch (JSONException | GeneralSecurityException error) {
                throw new IOException("Die Anmeldung konnte nicht erneuert werden.");
            }
        }
    }

    private static boolean isSyncRoute(String method, String route) {
        if (route == null || route.indexOf('#') != -1 || route.length() > 4096) return false;
        if ("POST".equals(method)) return MERGE_RPC.equals(route);
        if (!"GET".equals(method) || !route.startsWith(SYNC_TABLE)) return false;
        try {
            new URI(route);
            return true;
        } catch (URISyntaxException error) {
            return false;
        }
    }

    private JSONObject token(String grant, JSONObject data) throws IOException, JSONException {
        return new JSONObject(api("POST", AUTH + "token?grant_type=" + grant, data, null));
    }

    private Session verifySession(JSONObject data, String expectedOwner) throws IOException, JSONException {
        String refresh = tokenValue(data, "refresh_token");
        String access = tokenValue(data, "access_token");
        long seconds = data.optLong("expires_in", -1);
        if (seconds <= 0 || seconds > 86_400) throw new IOException("Ungültige Sitzungsdauer.");
        JSONObject user = new JSONObject(api("GET", AUTH + "user", null, access));
        String id = requiredString(user, "id");
        String email = requiredString(user, "email");
        checkOwner(id, email);
        if (expectedOwner != null && !expectedOwner.equals(id)) throw new IOException("Konto konnte nicht bestätigt werden.");
        return new Session(id, email, refresh, access, SystemClock.elapsedRealtime() + seconds * 1000);
    }

    private String api(String method, String route, JSONObject body, String access) throws IOException {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(config.origin + route).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setConnectTimeout(REQUEST_TIMEOUT_MS);
            connection.setReadTimeout(REQUEST_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("apikey", config.key);
            connection.setRequestProperty("Accept", "application/json");
            if (access != null) connection.setRequestProperty("Authorization", "Bearer " + access);
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_RESPONSE) throw new IOException("Synchronisierungsanfrage zu groß.");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(bytes);
                }
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new HttpError(status);
            if (status == 204) return "";
            try (InputStream input = connection.getInputStream()) {
                return new String(readLimited(input, MAX_RESPONSE), StandardCharsets.UTF_8);
            }
        } finally {
            connection.disconnect();
        }
    }

    private String awaitCode(long attempt, String verifier) throws IOException, GeneralSecurityException {
        try (ServerSocket server = new ServerSocket(0, 6, InetAddress.getByName(LOOPBACK))) {
            if (!isCurrent(attempt)) throw new SignInError("Anmeldung abgebrochen.");
            callbackServer = server;
            server.setSoTimeout(1000);
            String path = "/kinotix/auth/" + randomValue();
            String host = LOOPBACK + ":" + server.getLocalPort();
            Uri target = Uri.parse(config.origin + AUTH + "authorize").buildUpon()
                    .appendQueryParameter("provider", "google")
                    .appendQueryParameter("redirect_to", "http://" + host + path)
                    .appendQueryParameter("code_challenge", sha256Base64Url(verifier))
                    .appendQueryParameter("code_challenge_method", "s256").build();
            post(attempt, () -> openBrowser(target));
            long deadline = SystemClock.elapsedRealtime() + SIGN_IN_TIMEOUT_MS;
            while (isCurrent(attempt) && SystemClock.elapsedRealtime() < deadline) {
                if (browserIssue != null) throw new SignInError(browserIssue);
                Socket incoming;
                try {
                    incoming = server.accept();
                } catch (SocketTimeoutException error) {
                    continue;
                }
                try (Socket socket = incoming) {
                    socket.setSoTimeout(1000);
                    String query = readCallback(socket, host, path);
                    if (query == null) {
                        respond(socket, "404 Not Found", "Diese Adresse gehört nicht zur laufenden Anmeldung.");
                        continue;
                    }
                    String code = parseCode(query);
                    if (code == null) {
                        respond(socket, "400 Bad Request", "Die Anmeldung wurde abgebrochen. Kehre zu KinoTix zurück.");
                        throw new SignInError("Die Google-Anmeldung wurde abgebrochen.");
                    }
                    try {
                        respond(socket, "200 OK", "Die Antwort ist angekommen. Drücke Zurück, um zu KinoTix zu wechseln.");
                    } catch (IOException ignored) {
                        // The code was received even if the browser already closed its connection.
                    }
                    return code;
                } catch (SignInError error) {
                    throw error;
                } catch (IOException ignored) {
                    // An incomplete request does not consume the single-use callback.
                }
            }
            throw new SignInError("Die Google-Anmeldung ist abgelaufen.");
        } finally {
            callbackServer = null;
        }
    }

    private void openBrowser(Uri uri) {
        if (activity.isFinishing() || activity.isDestroyed()) {
            browserIssue = "Anmeldung abgebrochen.";
            return;
        }
        Intent view = new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            activity.startActivity(new Intent(view).setPackage(SILK_PACKAGE));
        } catch (ActivityNotFoundException | SecurityException noSilk) {
            try {
                activity.startActivity(view);
            } catch (ActivityNotFoundException | SecurityException noBrowser) {
                browserIssue = "Für die Google-Anmeldung ist ein Browser auf diesem Gerät erforderlich.";
            }
        }
    }

    private static String readCallback(Socket socket, String host, String path) throws IOException {
        InputStream input = new BufferedInputStream(socket.getInputStream());
        long deadline = SystemClock.elapsedRealtime() + 1800;
        String[] request = readLine(input, deadline).split(" ", -1);
        if (request.length != 3 || !"GET".equals(request[0]) || !request[1].startsWith("/")
                || !("HTTP/1.1".equals(request[2]) || "HTTP/1.0".equals(request[2]))) return null;
        String requestHost = null;
        for (int i = 0; i < 32; i++) {
            String line = readLine(input, deadline);
            if (line.isEmpty()) break;
            if (line.regionMatches(true, 0, "Host:", 0, 5)) {
                if (requestHost != null) return null;
                requestHost = line.substring(5).trim();
            }
            if (i == 31) return null;
        }
        if (!host.equals(requestHost)) return null;
        try {
            URI target = new URI(request[1]);
            if (target.getRawAuthority() != null || target.getRawFragment() != null || !path.equals(target.getRawPath())) return null;
            return target.getRawQuery() != null ? target.getRawQuery() : "";
        } catch (URISyntaxException error) {
            return null;
        }
    }

    private static String readLine(InputStream input, long deadline) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        while (output.size() < 4096 && SystemClock.elapsedRealtime() < deadline) {
            int next = input.read();
            if (next == '\r' && input.read() == '\n') return output.toString("US-ASCII");
            if (next < 32 || next > 126) throw new IOException("Ungültige Anmeldeantwort.");
            output.write(next);
        }
        throw new IOException("Ungültige Anmeldeantwort.");
    }

    private static String parseCode(String query) throws IOException {
        String code = null;
        for (String part : query.split("&")) {
            int separator = part.indexOf('=');
            if (separator < 0) continue;
            try {
                String name = URLDecoder.decode(part.substring(0, separator), "UTF-8");
                if ("error".equals(name)) return null;
                if (!"code".equals(name)) continue;
                if (code != null) return null;
                code = URLDecoder.decode(part.substring(separator + 1), "UTF-8");
            } catch (IllegalArgumentException error) {
                return null;
            }
        }
        return code != null && code.matches("[A-Za-z0-9._~-]{1,500}") ? code : null;
    }

    private static void respond(Socket socket, String status, String message) throws IOException {
        byte[] content = message.getBytes(StandardCharsets.UTF_8);
        String headers = "HTTP/1.1 " + status + "\r\nContent-Type: text/plain; charset=utf-8\r\n"
                + "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n"
                + "Content-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: " + content.length + "\r\n\r\n";
        OutputStream output = socket.getOutputStream();
        output.write(headers.getBytes(StandardCharsets.US_ASCII));
        output.write(content);
        output.flush();
    }

    private Session readSession() throws IOException, JSONException, GeneralSecurityException {
        byte[] bytes;
        try (InputStream input = credentials.openRead()) {
            bytes = readLimited(input, 32_768);
        }
        if (bytes.length < 30 || bytes[0] != 1) throw new IOException("Ungültiger Sitzungsspeicher.");
        Cipher cipher = Cipher.getInstance(CIPHER);
        SecretKey key = secureKey(false);
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, bytes, 1, 12));
        cipher.updateAAD(config.origin.getBytes(StandardCharsets.US_ASCII));
        byte[] decoded = cipher.doFinal(bytes, 13, bytes.length - 13);
        try {
            JSONObject data = new JSONObject(new String(decoded, StandardCharsets.UTF_8));
            String id = requiredString(data, "id");
            String email = requiredString(data, "email");
            checkOwner(id, email);
            return new Session(id, email, tokenValue(data, "refresh"), "", 0);
        } finally {
            Arrays.fill(decoded, (byte) 0);
        }
    }

    private void storeSession(Session owner) throws IOException, JSONException, GeneralSecurityException {
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(Cipher.ENCRYPT_MODE, secureKey(true));
        cipher.updateAAD(config.origin.getBytes(StandardCharsets.US_ASCII));
        byte[] iv = cipher.getIV();
        if (iv.length != 12) throw new IOException("Der sichere Gerätespeicher ist nicht verfügbar.");
        JSONObject data = new JSONObject().put("id", owner.id).put("email", owner.email).put("refresh", owner.refresh);
        byte[] plaintext = data.toString().getBytes(StandardCharsets.UTF_8);
        byte[] encrypted;
        try {
            encrypted = cipher.doFinal(plaintext);
        } finally {
            Arrays.fill(plaintext, (byte) 0);
        }
        FileOutputStream output = credentials.startWrite();
        try {
            output.write(1);
            output.write(iv);
            output.write(encrypted);
            credentials.finishWrite(output);
        } catch (IOException error) {
            credentials.failWrite(output);
            throw error;
        }
    }

    private static SecretKey secureKey(boolean create) throws IOException, GeneralSecurityException {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            java.security.Key found = keyStore.getKey(KEY_ALIAS, null);
            if (found instanceof SecretKey) return (SecretKey) found;
        }
        if (!create) throw new GeneralSecurityException("Sitzungsschlüssel nicht verfügbar.");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(128).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    private static Config loadConfig(Activity activity) {
        try (InputStream input = activity.getAssets().open("supabase.json")) {
            JSONObject value = new JSONObject(new String(readLimited(input, 8192), StandardCharsets.UTF_8));
            String origin = requiredString(value, "url");
            String key = requiredString(value, "publishableKey");
            if (!origin.matches("https://[a-z0-9-]+\\.supabase\\.co/?")
                    || !key.matches("sb_publishable_[A-Za-z0-9_-]{1,300}")) return null;
            return new Config(origin.endsWith("/") ? origin.substring(0, origin.length() - 1) : origin, key);
        } catch (IOException | JSONException error) {
            return null;
        }
    }

    private static byte[] readLimited(InputStream input, int limit) throws IOException {
        long deadline = SystemClock.elapsedRealtime() + 15_000;
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        for (int count; (count = input.read(buffer)) != -1;) {
            if (output.size() + count > limit || SystemClock.elapsedRealtime() > deadline) {
                throw new IOException("Die Kontoantwort ist zu groß oder dauerte zu lange.");
            }
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private static String requiredString(JSONObject data, String field) throws IOException {
        Object value = data.opt(field);
        if (!(value instanceof String)) throw new IOException("Ungültige Kontoantwort.");
        return (String) value;
    }

    private static String tokenValue(JSONObject data, String field) throws IOException {
        String value = requiredString(data, field);
        if (!value.matches("[\\x21-\\x7e]{1,16384}")) throw new IOException("Ungültige Kontoantwort.");
        return value;
    }

    private static void checkOwner(String id, String email) throws IOException {
        if (!id.matches(UUID) || email.isEmpty() || email.length() > 320) {
            throw new IOException("Konto konnte nicht bestätigt werden.");
        }
        for (int i = 0; i < email.length(); i++) {
            if (Character.isISOControl(email.charAt(i))) throw new IOException("Konto konnte nicht bestätigt werden.");
        }
    }

    private String randomValue() {
        byte[] bytes = new byte[32];
        random.nextBytes(bytes);
        return base64Url(bytes);
    }

    private static String base64Url(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static String sha256Base64Url(String value) throws GeneralSecurityException {
        return base64Url(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.US_ASCII)));
    }

    private void publish(Phase phase, Session owner, String message) {
        publish(phase, owner, message, null);
    }

    private void publish(Phase phase, Session owner, String message, String qrUrl) {
        if (closed) return;
        state = new State(phase, owner, message, qrUrl);
        listener.onAccount(state);
    }

    private void post(long attempt, Runnable action) {
        activity.runOnUiThread(() -> {
            if (isCurrent(attempt)) action.run();
        });
    }

    private boolean isCurrent(long attempt) {
        return !closed && attempt == generation;
    }

    private void closeCallback() {
        ServerSocket server = callbackServer;
        if (server != null) {
            try {
                server.close();
            } catch (IOException ignored) {
                // The listener also closes in the sign-in task.
            }
        }
    }

    @Override public void close() {
        closed = true;
        closeCallback();
        wakeConfirmation();
        control.shutdown();
    }
}
