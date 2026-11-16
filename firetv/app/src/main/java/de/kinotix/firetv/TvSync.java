package de.kinotix.firetv;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

final class TvSync implements AutoCloseable {
    interface Listener {
        void onSync(String owner, boolean changed, long lastSyncMs, String issue);
    }

    private static final String ITEMS = "/rest/v1/kinotix_sync?select=kind,item_id,updated_at,value";
    private static final String MERGE = "/rest/v1/rpc/kinotix_merge";
    private final TvAccount account;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ScheduledExecutorService worker = Executors.newSingleThreadScheduledExecutor();
    private ScheduledFuture<?> scheduled;
    private String owner;
    private TvLibrary library;
    private String activeEpisode;
    private long generation;
    private long due;
    private long lastSync;
    private boolean rerun;
    private boolean running;
    private boolean closed;

    TvSync(TvAccount account, Listener listener) {
        this.account = account;
        this.listener = listener;
    }

    synchronized void bind(String owner, TvLibrary library) {
        if (closed) return;
        generation++;
        if (scheduled != null) scheduled.cancel(false);
        scheduled = null;
        this.owner = owner;
        this.library = library;
        activeEpisode = null;
        lastSync = 0;
        rerun = false;
        schedule(0);
    }

    synchronized void setActiveEpisode(String id) {
        activeEpisode = id;
    }

    synchronized void changed() {
        if (running) rerun = true;
        else schedule(1000);
    }

    synchronized void now() {
        if (running) rerun = true;
        else schedule(0);
    }

    private void schedule(long delayMs) {
        if (closed || owner == null || library == null) return;
        long next = SystemClock.elapsedRealtime() + delayMs;
        if (scheduled != null) {
            if (due <= next) return;
            scheduled.cancel(false);
        }
        long ticket = generation;
        due = next;
        scheduled = worker.schedule(() -> exchange(ticket), delayMs, TimeUnit.MILLISECONDS);
    }

    private void exchange(long ticket) {
        String user;
        TvLibrary data;
        synchronized (this) {
            if (!current(ticket)) return;
            scheduled = null;
            running = true;
            user = owner;
            data = library;
        }
        boolean changed = false;
        boolean more = false;
        String issue = "";
        try {
            JSONArray pending = data.pendingSyncRows(100);
            if (pending.length() > 0) {
                account.request(user, "POST", MERGE, new JSONObject().put("p_items", pending));
                data.acknowledgeSyncRows(pending);
                more = pending.length() == 100;
            }
            JSONArray catalogs = read(user, "catalog", 100, 100);
            JSONArray progress = read(user, "progress", 500, 5000);
            String playing;
            synchronized (this) {
                if (!current(ticket)) return;
                playing = activeEpisode;
            }
            changed = data.applySyncRows(catalogs, progress, playing);
            for (TvLibrary.Catalog catalog : data.catalogsNeedingRefresh()) {
                synchronized (this) {
                    if (!current(ticket)) return;
                }
                try {
                    data.refresh(catalog);
                    changed = true;
                } catch (Exception ignored) {
                    // Local data and other sources remain usable; subsequent exchanges retry.
                }
            }
        } catch (Exception failure) {
            issue = "Synchronisierung gerade nicht verfügbar. Änderungen bleiben auf diesem Gerät gespeichert.";
        } finally {
            finish(ticket, user, changed, more, issue);
        }
    }

    private JSONArray read(String user, String kind, int count, int max) throws Exception {
        JSONArray rows = new JSONArray();
        for (int offset = 0; offset < max; offset += count) {
            String route = ITEMS + "&kind=eq." + kind + "&order=updated_at.desc,item_id.asc&limit="
                + count + "&offset=" + offset;
            JSONArray page = new JSONArray(account.request(user, "GET", route, null));
            if (page.length() > count) throw new IOException("Unexpected account record count");
            for (int i = 0; i < page.length(); i++) {
                JSONObject row = page.optJSONObject(i);
                if (row != null && kind.equals(row.optString("kind"))) rows.put(row);
            }
            if (page.length() < count) break;
        }
        return rows;
    }

    private boolean current(long ticket) {
        return !closed && owner != null && ticket == generation;
    }

    private void finish(long ticket, String user, boolean changed, boolean more, String issue) {
        long time;
        synchronized (this) {
            running = false;
            if (!current(ticket)) {
                schedule(0);
                return;
            }
            if (issue.isEmpty()) lastSync = System.currentTimeMillis();
            time = lastSync;
            schedule(issue.isEmpty() && (more || rerun) ? 1000 : 30000);
            rerun = false;
        }
        main.post(() -> {
            synchronized (this) {
                if (!current(ticket)) return;
            }
            listener.onSync(user, changed, time, issue);
        });
    }

    @Override public synchronized void close() {
        closed = true;
        generation++;
        if (scheduled != null) scheduled.cancel(true);
        worker.shutdownNow();
    }
}
