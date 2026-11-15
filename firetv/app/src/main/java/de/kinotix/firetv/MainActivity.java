package de.kinotix.firetv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.InputType;
import android.util.LruCache;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int BACKGROUND = 0xff12101a;
    private static final int SURFACE = 0xff211c30;
    private static final int ACCENT = 0xffc3b0ff;
    private static final int TEXT = 0xfff8f3ff;
    private static final int MUTED = 0xffc2b8d0;
    private static final int PICK_FILE = 18;
    private static final int POSTER_LIMIT = 3 * 1024 * 1024;
    private enum Page { HOME, SAVED, SEARCH, DETAIL, SOURCES, PROFILES, SETTINGS, PLAYER }
    private interface Task<T> { T run() throws Exception; }
    private interface Result<T> { void accept(T result); }
    private static final class Choice {
        final TvLibrary.Source source;
        final TvLibrary.Variant variant;
        Choice(TvLibrary.Source source, TvLibrary.Variant variant) {
            this.source = source;
            this.variant = variant;
        }
        String label() {
            return source.name + " · " + (variant.height > 0 ? variant.height + "p" : "Auto / Original");
        }
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService artwork = Executors.newFixedThreadPool(2);
    private final LruCache<String, Bitmap> images = new LruCache<>(20);
    private TvLibrary library;
    private TvUpdates updates;
    private String downloadedVersion;
    private LinearLayout screen;
    private LinearLayout body;
    private Page page;
    private Page returnPage = Page.HOME;
    private TvLibrary.Title detail;
    private int pageToken;
    private String focusTag;
    private String search = "";
    private Button updateButton;
    private TextView updateReport;
    private ProgressBar updateProgress;
    private TvPlayer player;
    private TvLibrary.Episode playingEpisode;
    private List<Choice> choices = Collections.emptyList();
    private int choiceIndex;
    private final Set<Integer> tried = new HashSet<>();
    private boolean playWhenReady;
    private long lastPosition;
    private long lastDuration;
    private long savedAt;
    private long sleepEnd;
    private boolean sleepAfterEpisode;
    private boolean foreground;
    private int season = 1;
    private Runnable nextEpisodeJob;
    private AlertDialog nextEpisodeDialog;
    private final Runnable sleepJob = () -> {
        sleepEnd = 0;
        if (player != null) {
            player.pauseForBackground();
            android.widget.Toast.makeText(this, "Schlaftimer · Wiedergabe angehalten", android.widget.Toast.LENGTH_SHORT).show();
        }
    };

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        enterImmersive();
        library = new TvLibrary(this);
        updates = new TvUpdates(this, this::renderUpdate);
        showHome();
        updates.check();
    }

    @Override protected void onResume() {
        super.onResume();
        foreground = true;
        enterImmersive();
        if (player != null) player.resumeFromBackground();
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) enterImmersive();
    }

    private void enterImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override protected void onPause() {
        foreground = false;
        cancelNextEpisode();
        if (player != null) player.pauseForBackground();
        super.onPause();
    }

    @Override protected void onStop() {
        if (player != null) player.stopForBackground();
        super.onStop();
    }

    @Override protected void onDestroy() {
        cancelNextEpisode();
        if (player != null) player.release();
        if (updates != null) updates.close();
        worker.shutdownNow();
        artwork.shutdownNow();
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (player != null && player.handleKey(event)) return true;
        return super.dispatchKeyEvent(event);
    }

    @Override public void onBackPressed() {
        if (player != null) {
            closePlayer();
        } else if (page == Page.DETAIL) {
            backFromDetail();
        } else if (page == Page.SOURCES || page == Page.PROFILES) {
            showSettings();
        } else if (page != Page.HOME) {
            showHome();
        } else {
            super.onBackPressed();
        }
    }

    private int dp(float size) {
        return (int)(size * getResources().getDisplayMetrics().density + .5f);
    }

    private LinearLayout column() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        return view;
    }

    private LinearLayout row() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.HORIZONTAL);
        view.setGravity(Gravity.CENTER_VERTICAL);
        return view;
    }

    private TextView text(String value, float size, int color, boolean strong) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
        view.setTextColor(color);
        if (strong) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private GradientDrawable panel(int color, int stroke, int radius) {
        GradientDrawable background = new GradientDrawable();
        background.setCornerRadius(dp(radius));
        background.setColor(color);
        background.setStroke(dp(2), stroke);
        return background;
    }

    private void focusBackground(View view, int color) {
        StateListDrawable background = new StateListDrawable();
        background.addState(new int[]{android.R.attr.state_focused}, panel(0xff3b2c59, ACCENT, 12));
        background.addState(new int[]{android.R.attr.state_pressed}, panel(0xff34274d, ACCENT, 12));
        background.addState(new int[]{}, panel(color, Color.TRANSPARENT, 12));
        view.setBackground(background);
    }

    private Button button(String label, Runnable action) {
        Button view = new Button(this);
        view.setText(label);
        view.setAllCaps(false);
        view.setTextSize(16);
        view.setTextColor(TEXT);
        view.setMinHeight(dp(50));
        view.setMinimumWidth(0);
        view.setMinWidth(0);
        view.setPadding(dp(14), dp(5), dp(14), dp(5));
        view.setFocusable(true);
        focusBackground(view, SURFACE);
        view.setOnClickListener(clicked -> action.run());
        return view;
    }

    private void buttonRow(LinearLayout parent, Button... buttons) {
        LinearLayout bar = row();
        for (Button button : buttons) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, dp(50));
            lp.rightMargin = dp(8);
            bar.addView(button, lp);
        }
        margin(parent, bar, 10);
    }

    private void actionLine(LinearLayout parent, Button button) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(53));
        lp.topMargin = dp(8);
        button.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        parent.addView(button, lp);
    }

    private void margin(LinearLayout parent, View view, int above) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(above);
        parent.addView(view, lp);
    }

    private void createPage(Page next, String label) {
        page = next;
        pageToken++;
        updateButton = null;
        updateReport = null;
        updateProgress = null;
        screen = column();
        screen.setPadding(dp(34), dp(20), dp(34), dp(18));
        screen.setBackgroundColor(BACKGROUND);
        LinearLayout navbar = row();
        ImageView icon = new ImageView(this);
        icon.setImageResource(R.drawable.kinotix_icon);
        navbar.addView(icon, new LinearLayout.LayoutParams(dp(36), dp(36)));
        TextView wordmark = text("KinoTix", 25, TEXT, true);
        wordmark.setPadding(dp(9), 0, dp(12), 0);
        navbar.addView(wordmark);
        navbar.addView(new View(this), new LinearLayout.LayoutParams(0, 1, 1));
        addNav(navbar, "Mediathek", this::showHome);
        addNav(navbar, "Merkliste", this::showSaved);
        addNav(navbar, "Suche", () -> prompt("Mediathek durchsuchen", "Film oder Serie", search,
            InputType.TYPE_CLASS_TEXT, query -> { search = query; showSearch(); }));
        addNav(navbar, "Einstellungen", this::showSettings);
        screen.addView(navbar, new LinearLayout.LayoutParams(-1, dp(53)));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(false);
        scroll.setClipToPadding(false);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setDescendantFocusability(ScrollView.FOCUS_AFTER_DESCENDANTS);
        body = column();
        body.setPadding(0, dp(16), 0, dp(14));
        scroll.addView(body, new ScrollView.LayoutParams(-1, -2));
        screen.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        if (label != null) margin(body, text(label, 30, TEXT, true), 0);
        setContentView(screen);
    }

    private void addNav(LinearLayout navbar, String label, Runnable action) {
        Button item = button(label, action);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, dp(45));
        lp.leftMargin = dp(8);
        navbar.addView(item, lp);
    }

    private void showHome() {
        createPage(Page.HOME, null);
        List<TvLibrary.Title> titles = library.titles();
        TvLibrary.Title resume = null;
        TvLibrary.Progress progress = null;
        for (TvLibrary.Title title : titles) {
            TvLibrary.Progress entry = library.latest(title);
            if (entry != null && !entry.finished && entry.positionMs > 0
                    && (progress == null || entry.updatedAt > progress.updatedAt)) {
                resume = title;
                progress = entry;
            }
        }
        Button add = button("Quelle hinzufügen", this::addSource);
        Button first = add;
        if (resume != null) {
            TvLibrary.Title selected = resume;
            TvLibrary.Progress resumeState = progress;
            margin(body, text("Weiterschauen", 26, TEXT, true), 0);
            String note = (selected.isSeries ? "S" + resumeState.season + " · F" + resumeState.episode + "   " : "")
                + time(resumeState.positionMs) + " / " + time(resumeState.durationMs);
            Button play = button("Fortsetzen · " + selected.title + "   " + note,
                () -> openTitle(selected, true, Page.HOME));
            actionLine(body, play);
            first = play;
        }
        margin(body, text("Deine Mediathek", 30, TEXT, true), resume == null ? 0 : 22);
        if (titles.isEmpty()) {
            margin(body, text("Füge eine Video- oder Katalogadresse hinzu.", 19, MUTED, false), 8);
            buttonRow(body, add);
            focus(add);
        } else {
            buttonRow(body, add);
            addCards(titles, Page.HOME);
            restoreFocus(first);
        }
    }

    private void showSaved() {
        createPage(Page.SAVED, "Merkliste");
        List<TvLibrary.Title> saved = new ArrayList<>();
        for (TvLibrary.Title item : library.titles()) if (library.isSaved(item)) saved.add(item);
        if (saved.isEmpty()) {
            margin(body, text("Gespeicherte Filme und Serien erscheinen hier.", 19, MUTED, false), 8);
            Button home = button("Mediathek öffnen", this::showHome);
            buttonRow(body, home);
            focus(home);
            return;
        }
        Button random = button("Zufällig auswählen", () ->
            openTitle(saved.get(new java.util.Random().nextInt(saved.size())), false, Page.SAVED));
        buttonRow(body, random);
        addCards(saved, Page.SAVED);
        restoreFocus(random);
    }

    private void showSearch() {
        createPage(Page.SEARCH, search.isEmpty() ? "Suche" : "Suche nach „" + search + "“");
        Button edit = button("Suchbegriff ändern", () -> prompt("Mediathek durchsuchen", "Film oder Serie",
            search, InputType.TYPE_CLASS_TEXT, value -> { search = value; showSearch(); }));
        buttonRow(body, edit);
        List<TvLibrary.Title> matches = new ArrayList<>();
        String query = search.toLowerCase(Locale.ROOT);
        for (TvLibrary.Title title : library.titles()) {
            if (title.title.toLowerCase(Locale.ROOT).contains(query)) matches.add(title);
        }
        if (matches.isEmpty()) margin(body, text("Keine Treffer in deiner Mediathek.", 19, MUTED, false), 8);
        else addCards(matches, Page.SEARCH);
        restoreFocus(edit);
    }

    private void addCards(List<TvLibrary.Title> titles, Page origin) {
        int columns = 3;
        for (int start = 0; start < titles.size(); start += columns) {
            LinearLayout line = row();
            for (int i = 0; i < columns; i++) {
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(117), 1);
                lp.rightMargin = i + 1 < columns ? dp(10) : 0;
                int index = start + i;
                if (index >= titles.size()) {
                    line.addView(new View(this), lp);
                    continue;
                }
                TvLibrary.Title title = titles.get(index);
                LinearLayout card = row();
                card.setPadding(dp(10), dp(10), dp(12), dp(10));
                focusBackground(card, SURFACE);
                card.setFocusable(true);
                card.setContentDescription(title.title + (title.isSeries ? ", Serie" : ", Film"));
                card.setTag("title:" + title.id);
                card.setOnClickListener(view -> openTitle(title, false, origin));
                ImageView poster = new ImageView(this);
                poster.setImageResource(R.drawable.kinotix_icon);
                poster.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
                card.addView(poster, new LinearLayout.LayoutParams(dp(59), -1));
                loadPoster(title.poster, poster);
                LinearLayout labels = column();
                labels.setPadding(dp(10), 0, 0, 0);
                TextView headline = text(title.title, 19, TEXT, true);
                headline.setMaxLines(2);
                headline.setEllipsize(android.text.TextUtils.TruncateAt.END);
                labels.addView(headline);
                margin(labels, text(title.isSeries ? "Serie" : "Film", 14, MUTED, false), 4);
                card.addView(labels, new LinearLayout.LayoutParams(0, -2, 1));
                line.addView(card, lp);
            }
            margin(body, line, 9);
        }
    }

    private void loadPoster(String value, ImageView view) {
        if (value == null || !value.startsWith("https://")) return;
        Bitmap stored = images.get(value);
        if (stored != null) { displayPoster(view, stored); return; }
        artwork.execute(() -> {
            try {
                URL url = new URL(value);
                if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null) return;
                HttpURLConnection connection = (HttpURLConnection)url.openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(4000);
                connection.setReadTimeout(4000);
                byte[] bytes;
                try {
                    if (connection.getResponseCode() != 200) return;
                    try (InputStream input = connection.getInputStream()) { bytes = read(input, POSTER_LIMIT); }
                } finally { connection.disconnect(); }
                BitmapFactory.Options options = new BitmapFactory.Options();
                options.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
                if (options.outWidth < 1 || options.outHeight < 1
                        || options.outWidth > 10000 || options.outHeight > 10000) return;
                options.inJustDecodeBounds = false;
                options.inSampleSize = 1;
                while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 600) {
                    options.inSampleSize *= 2;
                }
                Bitmap image = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
                if (image != null) {
                    images.put(value, image);
                    runOnUiThread(() -> { if (view.isAttachedToWindow()) displayPoster(view, image); });
                }
            } catch (IOException | RuntimeException ignored) { }
        });
    }

    private void displayPoster(ImageView view, Bitmap image) {
        view.setScaleType(ImageView.ScaleType.CENTER_CROP);
        view.setImageBitmap(image);
    }

    private void openTitle(TvLibrary.Title title, boolean resume, Page origin) {
        focusTag = "title:" + title.id;
        returnPage = origin;
        detail = title;
        season = 1;
        createPage(Page.DETAIL, title.title);
        runTask("Titel wird geladen …", () -> library.details(title), value -> {
            detail = value;
            TvLibrary.Progress latest = library.latest(value);
            if (latest != null) season = latest.season;
            showDetail();
            if (resume && latest != null) {
                for (TvLibrary.Episode episode : detail.episodes) {
                    if (episode.season == latest.season && episode.episode == latest.episode) {
                        startEpisode(episode);
                        break;
                    }
                }
            }
        });
    }

    private void showDetail() {
        if (detail == null) { showHome(); return; }
        createPage(Page.DETAIL, detail.title);
        if (detail.description != null && !detail.description.isEmpty()) {
            TextView description = text(detail.description, 18, MUTED, false);
            description.setMaxLines(4);
            description.setEllipsize(android.text.TextUtils.TruncateAt.END);
            margin(body, description, 6);
        }
        Button save = button(library.isSaved(detail) ? "Aus Merkliste entfernen" : "Merken", () -> {
            library.toggleSaved(detail);
            showDetail();
        });
        List<Integer> seasons = new ArrayList<>();
        for (TvLibrary.Episode episode : detail.episodes) {
            if (!seasons.contains(episode.season)) seasons.add(episode.season);
        }
        if (!seasons.contains(season) && !seasons.isEmpty()) season = seasons.get(0);
        Button back = button("Zurück", this::backFromDetail);
        if (detail.isSeries && seasons.size() > 1) {
            Button select = button("Staffel " + season, () -> {
                String[] labels = new String[seasons.size()];
                for (int i = 0; i < labels.length; i++) labels[i] = "Staffel " + seasons.get(i);
                new AlertDialog.Builder(this).setTitle("Staffel auswählen")
                    .setItems(labels, (dialog, index) -> { season = seasons.get(index); showDetail(); }).show();
            });
            buttonRow(body, back, save, select);
        } else {
            buttonRow(body, back, save);
        }
        Button first = null;
        for (TvLibrary.Episode episode : detail.episodes) {
            if (detail.isSeries && episode.season != season) continue;
            TvLibrary.Progress resume = library.progress(episode);
            String label = detail.isSeries ? "Folge " + episode.episode : "Abspielen";
            if (resume != null && resume.positionMs > 0 && !resume.finished) {
                label = (detail.isSeries ? label : "Fortsetzen") + " · " + time(resume.positionMs);
            } else if (resume != null && resume.finished && detail.isSeries) {
                label += " · Gesehen";
            }
            Button play = button(label, () -> startEpisode(episode));
            if (first == null) first = play;
            actionLine(body, play);
        }
        if (first == null) {
            margin(body, text("Keine abspielbaren Videos gefunden.", 19, MUTED, false), 10);
        }
        TvLibrary.Title title = detail;
        Button remove = button("Aus Mediathek entfernen", () -> new AlertDialog.Builder(this)
            .setTitle("Titel aus Mediathek entfernen?").setMessage(title.title)
            .setNegativeButton("Abbrechen", null)
            .setPositiveButton("Entfernen", (dialog, which) -> runTask("Titel wird entfernt …", () -> {
                library.remove(title);
                return true;
            }, result -> backFromDetail())).show());
        actionLine(body, remove);
        focus(first != null ? first : back);
    }

    private void backFromDetail() {
        if (returnPage == Page.SAVED) showSaved();
        else if (returnPage == Page.SEARCH) showSearch();
        else showHome();
    }

    private void startEpisode(TvLibrary.Episode episode) {
        TvLibrary.Title title = detail;
        runTask("Video wird vorbereitet …", () -> library.resolve(title, episode), resolved -> {
            List<Choice> available = new ArrayList<>();
            for (TvLibrary.Source source : resolved.sources) {
                List<TvLibrary.Variant> variants = new ArrayList<>(source.variants);
                variants.sort(Comparator.comparingInt(variant -> variant.height <= 0 ? Integer.MAX_VALUE : variant.height));
                Collections.reverse(variants);
                for (TvLibrary.Variant item : variants) available.add(new Choice(source, item));
            }
            if (available.isEmpty()) { showError("Für diese Auswahl wurde kein direkt abspielbarer Videostream gefunden."); return; }
            playingEpisode = resolved;
            choices = available;
            tried.clear();
            lastPosition = 0;
            lastDuration = 0;
            savedAt = 0;
            TvLibrary.Progress prior = library.progress(episode);
            if (prior != null && !prior.finished) {
                lastPosition = prior.positionMs;
                lastDuration = prior.durationMs;
            }
            mountPlayer();
            playChoice(0, lastPosition, true);
        });
    }

    private void mountPlayer() {
        pageToken++;
        page = Page.PLAYER;
        player = new TvPlayer(this, new TvPlayer.Listener() {
            @Override public void onProgress(long position, long duration, boolean finished) {
                if (playingEpisode == null || duration <= 0) return;
                lastPosition = Math.max(0, position);
                lastDuration = duration;
                long now = SystemClock.elapsedRealtime();
                if (finished || now - savedAt >= 1500 || player == null || !player.isPlaying()) {
                    library.saveProgress(playingEpisode, lastPosition, lastDuration, finished);
                    savedAt = now;
                }
            }
            @Override public void onBack() { closePlayer(); }
            @Override public void onComplete() { playbackFinished(); }
            @Override public void onError(String message) { failedChoice(message); }
            @Override public void onOptions() { showPlayerOptions(); }
            @Override public void onNext() { playNext(); }
            @Override public void onPositionChanged(long position, long duration) {
                if (player != null && playingEpisode != null && !choices.isEmpty()) showSkipAction(position, duration);
            }
        });
        setContentView(player);
        player.setOptionsAvailable(true);
        player.setNextEpisodeAvailable(nextEpisode() != null);
        player.requestFocus();
        enterImmersive();
    }

    private void playChoice(int index, long position, boolean autoplay) {
        choiceIndex = index;
        playWhenReady = autoplay;
        tried.add(index);
        TvLibrary.Episode item = playingEpisode;
        String label = detail.title + (detail.isSeries ? " · S" + item.season + " F" + item.episode : "");
        player.play(label, choices.get(index).variant.url, position, autoplay);
    }

    private void failedChoice(String message) {
        for (int i = 0; i < choices.size(); i++) {
            if (!tried.contains(i)) {
                playChoice(i, lastPosition, foreground && playWhenReady);
                return;
            }
        }
        showError(message);
    }

    private void showSkipAction(long position, long duration) {
        TvLibrary.Variant variant = choices.get(choiceIndex).variant;
        String[] keys = {"recap", "intro", "outro"};
        String[] labels = {"Rückblick überspringen", "Intro überspringen", "Abspann überspringen"};
        for (int i = 0; i < keys.length; i++) {
            TvLibrary.Segment marker = variant.segments.get(keys[i]);
            if (marker == null) marker = playingEpisode.segments.get(keys[i]);
            if (marker == null || position < marker.startMs || position >= marker.endMs) continue;
            long target = marker.endMs;
            if (i == 2) {
                TvLibrary.Segment credits = variant.segments.get("post_credits");
                if (credits == null) credits = playingEpisode.segments.get("post_credits");
                if (credits != null && credits.startMs > position && credits.startMs < target) target = credits.startMs;
                if (credits != null && position >= credits.startMs && position < credits.endMs) break;
            }
            player.setSkipAction(labels[i], duration > 0 ? Math.min(duration, target) : target);
            return;
        }
        player.setSkipAction(null, -1);
    }

    private TvLibrary.Episode nextEpisode() {
        if (detail == null || playingEpisode == null) return null;
        for (int i = 0; i + 1 < detail.episodes.size(); i++) {
            if (detail.episodes.get(i).id.equals(playingEpisode.id)) return detail.episodes.get(i + 1);
        }
        return null;
    }

    private void playbackFinished() {
        if (sleepAfterEpisode) {
            sleepAfterEpisode = false;
            return;
        }
        if (!foreground || nextEpisode() == null || !prefs().getBoolean("autoplay", true)) return;
        nextEpisodeJob = this::playNext;
        nextEpisodeDialog = new AlertDialog.Builder(this)
            .setTitle("Nächste Folge")
            .setMessage("Die nächste Folge startet in 5 Sekunden.")
            .setNegativeButton("Abbrechen", (dialog, which) -> cancelNextEpisode())
            .setPositiveButton("Jetzt abspielen", (dialog, which) -> playNext())
            .setOnCancelListener(dialog -> cancelNextEpisode())
            .show();
        handler.postDelayed(nextEpisodeJob, 5000);
    }

    private void cancelNextEpisode() {
        if (nextEpisodeJob != null) handler.removeCallbacks(nextEpisodeJob);
        nextEpisodeJob = null;
        if (nextEpisodeDialog != null) nextEpisodeDialog.dismiss();
        nextEpisodeDialog = null;
    }

    private void playNext() {
        TvLibrary.Episode next = nextEpisode();
        if (next == null) return;
        closePlayer();
        season = next.season;
        showDetail();
        startEpisode(next);
    }

    private void closePlayer() {
        cancelNextEpisode();
        TvPlayer previous = player;
        player = null;
        if (previous != null) previous.release();
        playingEpisode = null;
        choices = Collections.emptyList();
        showDetail();
    }

    private void showPlayerOptions() {
        List<String> labels = new ArrayList<>();
        if (choices.size() > 1) labels.add("Quelle und Qualität");
        if (player.hasAudioTracks()) labels.add("Tonspur");
        labels.add("Schlaftimer");
        new AlertDialog.Builder(this).setTitle("Wiedergabe")
            .setItems(labels.toArray(new String[0]), (dialog, index) -> {
                String label = labels.get(index);
                if ("Quelle und Qualität".equals(label)) showChoices();
                else if ("Tonspur".equals(label)) player.showAudioTracks();
                else showSleepTimer();
            }).show();
    }

    private void showChoices() {
        String[] labels = new String[choices.size()];
        for (int i = 0; i < labels.length; i++) labels[i] = choices.get(i).label();
        new AlertDialog.Builder(this).setTitle("Quelle und Qualität")
            .setSingleChoiceItems(labels, choiceIndex, (dialog, which) -> {
                dialog.dismiss();
                if (player == null || which == choiceIndex) return;
                long at = player.getPositionMs();
                boolean autoplay = player.isPlaying();
                tried.clear();
                playChoice(which, at, autoplay);
            }).show();
    }

    private void showSleepTimer() {
        String current = sleepAfterEpisode ? "Nach dieser Folge" : sleepEnd > 0
            ? "Noch " + Math.max(1, (sleepEnd - SystemClock.elapsedRealtime() + 59999) / 60000) + " Min." : "Aus";
        String[] labels = {"Aus", "15 Minuten", "30 Minuten", "45 Minuten", "Nach diesem Video"};
        new AlertDialog.Builder(this).setTitle("Schlaftimer · " + current).setItems(labels, (dialog, index) -> {
            handler.removeCallbacks(sleepJob);
            sleepEnd = 0;
            sleepAfterEpisode = index == 4;
            if (index >= 1 && index <= 3) {
                long delay = index * 15L * 60000L;
                sleepEnd = SystemClock.elapsedRealtime() + delay;
                handler.postDelayed(sleepJob, delay);
            }
        }).show();
    }

    private void addSource() {
        String[] options = {"Webadresse eingeben", "Datei auswählen"};
        new AlertDialog.Builder(this).setTitle("Quelle hinzufügen").setItems(options, (dialog, which) -> {
            if (which == 0) prompt("Video- oder Katalogadresse", "https://…", "",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI,
                value -> runTask("Quelle wird geprüft …", () -> library.importUrl(value), result -> showHome()));
            else pickFile();
        }).show();
    }

    private void pickFile() {
        Intent select = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        select.addCategory(Intent.CATEGORY_OPENABLE);
        select.setType("*/*");
        select.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"video/*", "application/json", "application/vnd.kinotix.catalog+json"});
        select.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try {
            startActivityForResult(select, PICK_FILE);
        } catch (ActivityNotFoundException error) {
            showError("Auf diesem Fire TV ist keine Dateiauswahl verfügbar. Füge die Quelle als HTTPS-Adresse hinzu.");
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_FILE || result != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        String type = getContentResolver().getType(uri);
        String name = "Lokales Video";
        try (android.database.Cursor cursor = getContentResolver().query(uri,
                new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && cursor.getString(0) != null) name = cursor.getString(0);
        } catch (RuntimeException ignored) { }
        if ((type != null && type.contains("json")) || name.toLowerCase(Locale.ROOT).endsWith(".json")) {
            runTask("Datei wird gelesen …", () -> {
                try (InputStream input = getContentResolver().openInputStream(uri)) {
                    if (input == null) throw new IOException("Die Datei konnte nicht geöffnet werden.");
                    return library.importJson(new String(read(input, 2 * 1024 * 1024), StandardCharsets.UTF_8));
                }
            }, imported -> showHome());
        } else {
            try {
                getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                library.addFile(uri.toString(), name);
                showHome();
            } catch (Exception error) {
                showError("Der Zugriff auf das Video lässt sich auf diesem Gerät nicht speichern.");
            }
        }
    }

    private void showSources() {
        createPage(Page.SOURCES, "Kataloge");
        Button add = button("Quelle hinzufügen", this::addSource);
        buttonRow(body, add, button("Zurück", this::showSettings));
        for (TvLibrary.Catalog catalog : library.catalogs()) {
            Button item = button(catalog.name, () -> new AlertDialog.Builder(this).setTitle(catalog.name)
                .setItems(new String[]{"Katalog aktualisieren", "Katalog entfernen"}, (dialog, which) -> {
                    if (which == 0) runTask("Katalog wird aktualisiert …", () -> library.refresh(catalog), value -> showSources());
                    else new AlertDialog.Builder(this).setTitle("Katalog entfernen?")
                        .setMessage(catalog.name).setNegativeButton("Abbrechen", null)
                        .setPositiveButton("Entfernen", (confirm, action) -> runTask("Katalog wird entfernt …", () -> {
                            library.removeCatalog(catalog);
                            return true;
                        }, value -> showSources())).show();
                }).show());
            actionLine(body, item);
        }
        focus(add);
    }

    private void showProfiles() {
        createPage(Page.PROFILES, "Profile");
        Button add = button("Profil hinzufügen", () -> prompt("Neues Profil", "Name", "",
            InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_WORDS, value -> {
                try {
                    library.addProfile(value);
                    showHome();
                } catch (RuntimeException error) { showError(error.getMessage()); }
            }));
        buttonRow(body, add, button("Zurück", this::showSettings));
        Button active = null;
        for (String name : library.profiles()) {
            boolean selected = name.equals(library.activeProfile());
            Button profile = button(name + (selected ? " · Aktiv" : ""), () -> {
                library.selectProfile(name);
                showHome();
            });
            actionLine(body, profile);
            if (selected) active = profile;
        }
        focus(active != null ? active : add);
    }

    private void showSettings() {
        createPage(Page.SETTINGS, "Einstellungen");
        Button profiles = button("Profil · " + library.activeProfile(), this::showProfiles);
        actionLine(body, profiles);
        actionLine(body, button("Kataloge", this::showSources));
        updateAutoplayButton();
        margin(body, text("Software-Updates", 24, TEXT, true), 24);
        updateReport = text("", 18, MUTED, false);
        updateReport.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        margin(body, updateReport, 5);
        updateProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        updateProgress.setMax(100);
        margin(body, updateProgress, 6);
        updateButton = button("Jetzt prüfen", () -> {
            switch (updates.state().phase) {
                case READY: updates.install(); break;
                case AVAILABLE: updates.download(); break;
                default: updates.check(); break;
            }
        });
        actionLine(body, updateButton);
        renderUpdate(updates.state());
        focus(profiles);
    }

    private void updateAutoplayButton() {
        boolean enabled = prefs().getBoolean("autoplay", true);
        Button choice = button("Nächste Folge automatisch · " + (enabled ? "An" : "Aus"), () -> { });
        choice.setOnClickListener(view -> {
            boolean next = !prefs().getBoolean("autoplay", true);
            prefs().edit().putBoolean("autoplay", next).apply();
            choice.setText("Nächste Folge automatisch · " + (next ? "An" : "Aus"));
        });
        actionLine(body, choice);
    }

    private void renderUpdate(TvUpdates.State state) {
        if (updateButton != null && page == Page.SETTINGS) {
            updateReport.setText(version() + " · " + state.message);
            boolean busy = state.phase == TvUpdates.Phase.CHECKING || state.phase == TvUpdates.Phase.DOWNLOADING;
            updateProgress.setVisibility(state.phase == TvUpdates.Phase.DOWNLOADING ? View.VISIBLE : View.GONE);
            updateProgress.setProgress(state.percent);
            updateButton.setEnabled(!busy);
            if (state.phase == TvUpdates.Phase.READY) updateButton.setText("Update installieren");
            else if (state.phase == TvUpdates.Phase.AVAILABLE) updateButton.setText("Update herunterladen");
            else updateButton.setText("Jetzt prüfen");
        }
        if (state.phase == TvUpdates.Phase.AVAILABLE && state.version != null && !state.version.equals(downloadedVersion)) {
            downloadedVersion = state.version;
            updates.download();
        }
    }

    private String version() {
        try { return "Version " + getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (android.content.pm.PackageManager.NameNotFoundException ignored) { return "KinoTix"; }
    }

    private android.content.SharedPreferences prefs() {
        return getSharedPreferences("tv-settings", MODE_PRIVATE);
    }

    private void prompt(String title, String hint, String initial, int type, Result<String> result) {
        EditText field = new EditText(this);
        field.setSingleLine(true);
        field.setInputType(type);
        field.setImeOptions(EditorInfo.IME_ACTION_DONE);
        field.setText(initial);
        field.setHint(hint);
        LinearLayout padding = column();
        padding.setPadding(dp(22), dp(5), dp(22), 0);
        padding.addView(field);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle(title).setView(padding)
            .setNegativeButton("Abbrechen", null).setPositiveButton("Weiter", null).create();
        Runnable submit = () -> {
            String value = field.getText().toString().trim();
            if (!value.isEmpty()) { dialog.dismiss(); result.accept(value); }
            else field.setError("Bitte gib einen Wert ein.");
        };
        dialog.setOnShowListener(ignored -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> submit.run());
            field.requestFocus();
            if (dialog.getWindow() != null) dialog.getWindow()
                .setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
        });
        field.setOnEditorActionListener((view, action, event) -> {
            if (event != null && (event.getKeyCode() == KeyEvent.KEYCODE_ENTER
                    || event.getKeyCode() == KeyEvent.KEYCODE_NUMPAD_ENTER)) {
                if (event.getAction() == KeyEvent.ACTION_UP) submit.run();
                return true;
            }
            if (action == EditorInfo.IME_ACTION_DONE) { submit.run(); return true; }
            return false;
        });
        dialog.show();
    }

    private <T> void runTask(String message, Task<T> task, Result<T> complete) {
        int token = ++pageToken;
        TextView status = text(message, 18, ACCENT, false);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        margin(body, status, 12);
        worker.execute(() -> {
            try {
                T result = task.run();
                runOnUiThread(() -> {
                    status.setVisibility(View.GONE);
                    if (token == pageToken && !isDestroyed() && !isFinishing()) complete.accept(result);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    status.setVisibility(View.GONE);
                    if (token == pageToken && !isDestroyed() && !isFinishing()) showError(error.getMessage());
                });
            }
        });
    }

    private void showError(String message) {
        new AlertDialog.Builder(this).setTitle("KinoTix")
            .setMessage(message == null || message.trim().isEmpty() ? "Die Aktion konnte nicht abgeschlossen werden." : message)
            .setPositiveButton("OK", null).show();
    }

    private void focus(View view) { view.post(view::requestFocus); }

    private void restoreFocus(View fallback) {
        View previous = focusTag == null ? null : body.findViewWithTag(focusTag);
        focusTag = null;
        focus(previous == null ? fallback : previous);
    }

    private static byte[] read(InputStream input, int maximum) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        for (int count; (count = input.read(buffer)) != -1;) {
            if (out.size() + count > maximum) throw new IOException("Die Datei ist zu groß.");
            out.write(buffer, 0, count);
        }
        return out.toByteArray();
    }

    private static String time(long ms) {
        long seconds = Math.max(0, ms) / 1000;
        return String.format(Locale.GERMAN, "%d:%02d", seconds / 60, seconds % 60);
    }
}
