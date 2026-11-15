package de.kinotix.firetv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.MediaPlayer;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.TextUtils;
import android.util.SparseArray;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.util.Locale;

/** Full-screen video and playback controls for a television remote. */
public final class TvPlayer extends FrameLayout implements SurfaceHolder.Callback {
    public interface Listener {
        void onProgress(long positionMs, long durationMs, boolean finished);
        void onBack();
        void onComplete();
        void onError(String message);
        default void onPositionChanged(long positionMs, long durationMs) {}
        default void onNext() {}
        default void onOptions() {}
    }

    private static final int CONTROL_TIMEOUT_MS = 4_000;
    private static final int MEDIA_TIMEOUT_MS = 25_000;
    private static final int CHECKPOINT_MS = 5_000;
    private static final int SKIP_MS = 10_000;
    private static final int ACCENT = 0xffbfdbfe;

    private final Activity activity;
    private final Listener listener;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable hideTask = this::hideControls;
    private final Runnable mediaTimeout = () -> fail("Das Video antwortet nicht.");
    private final SurfaceView video;
    private final FrameLayout controls;
    private final TextView heading;
    private final TextView time;
    private final TextView status;
    private final ProgressBar progress;
    private final Button playPause;
    private final Button skipAction;
    private final Button options;
    private final Button next;
    private final Button[] actions;
    private final AudioManager audio;
    private final AudioManager.OnAudioFocusChangeListener audioFocus = change -> {
        if (change < 0) {
            deactivateSession();
            pause();
            showControls();
        }
    };

    private MediaPlayer player;
    private MediaSession session;
    private Uri source;
    private boolean surfaceReady;
    private boolean prepared;
    private boolean started;
    private boolean wantsPlayback;
    private boolean completed;
    private boolean hasAudioFocus;
    private boolean backgrounded;
    private boolean resumePlayback;
    private boolean buffering;
    private long positionMs;
    private long durationMs;
    private long seekInFlight = -1;
    private long queuedSeek = -1;
    private long skipToMs = -1;
    private long lastPosition = -1;
    private long lastDuration = -1;
    private boolean lastFinished;
    private long lastCheckpoint;
    private int pictureWidth;
    private int pictureHeight;
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!prepared) return;
            MediaPlayer observed = player;
            updatePosition();
            if (seekInFlight < 0) listener.onPositionChanged(positionMs, durationMs);
            if (observed != player) return;
            if (SystemClock.uptimeMillis() - lastCheckpoint >= CHECKPOINT_MS) checkpoint();
            if (observed == player) handler.postDelayed(this, 500);
        }
    };

    public TvPlayer(Activity activity, Listener listener) {
        super(activity);
        this.activity = activity;
        this.listener = listener;
        audio = (AudioManager) activity.getSystemService(Activity.AUDIO_SERVICE);
        activity.setVolumeControlStream(AudioManager.STREAM_MUSIC);
        setBackgroundColor(Color.BLACK);
        setFocusableInTouchMode(true);

        video = new SurfaceView(activity);
        video.setFocusable(false);
        video.getHolder().addCallback(this);
        addView(video, new FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT, Gravity.CENTER));

        controls = new FrameLayout(activity);
        addView(controls, new FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        heading = label(28);
        heading.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        heading.setSingleLine();
        heading.setEllipsize(TextUtils.TruncateAt.END);
        heading.setPadding(dp(50), dp(36), dp(50), dp(32));
        heading.setBackground(shade(GradientDrawable.Orientation.TOP_BOTTOM));
        controls.addView(heading, new FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.TOP));

        LinearLayout bottom = new LinearLayout(activity);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setPadding(dp(50), dp(26), dp(50), dp(35));
        bottom.setBackground(shade(GradientDrawable.Orientation.BOTTOM_TOP));
        controls.addView(bottom, new FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));

        time = label(17);
        time.setGravity(Gravity.END);
        bottom.addView(time, new LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(1_000);
        progress.setProgressTintList(ColorStateList.valueOf(ACCENT));
        progress.setContentDescription("Wiedergabefortschritt");
        bottom.addView(progress, new LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, dp(14)));

        LinearLayout row = new LinearLayout(activity);
        row.setGravity(Gravity.CENTER);
        bottom.addView(row, new LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
        Button back = button(row, "Zurück", this::back);
        Button rewind = button(row, "–10 Sek.", () -> skip(-SKIP_MS));
        playPause = button(row, "Pause", this::toggle);
        Button forward = button(row, "+10 Sek.", () -> skip(SKIP_MS));
        skipAction = button(row, "", this::skipMarker);
        next = button(row, "Nächste Folge", this::next);
        options = button(row, "Wiedergabe", this::options);
        actions = new Button[] {back, rewind, playPause, forward, skipAction, next, options};
        setSkipAction(null, -1);
        setNextEpisodeAvailable(false);
        setOptionsAvailable(false);

        status = label(20);
        status.setGravity(Gravity.CENTER);
        status.setPadding(dp(26), dp(15), dp(26), dp(15));
        status.setBackground(panel(0xdd111827));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        status.setVisibility(View.GONE);
        addView(status, new FrameLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER));
    }

    public void play(String title, String url, long startMs) {
        play(title, url, startMs, true);
    }

    public void play(String title, String url, long startMs, boolean autoplay) {
        release();
        source = url == null ? null : Uri.parse(url);
        heading.setText(title);
        positionMs = Math.max(0, startMs);
        durationMs = 0;
        lastPosition = lastDuration = -1;
        lastCheckpoint = SystemClock.uptimeMillis();
        wantsPlayback = autoplay;
        completed = lastFinished = false;
        setSkipAction(null, -1);
        pictureWidth = pictureHeight = 0;
        fitVideo();
        updatePosition();
        message("Video wird geladen …");
        showControls();
        String scheme = source == null ? null : source.getScheme();
        boolean validHttps = "https".equalsIgnoreCase(scheme) && source.getHost() != null && source.getUserInfo() == null;
        if (!validHttps && !"content".equals(scheme) && !"file".equals(scheme)) {
            fail("Diese Videoquelle wird nicht unterstützt.");
            return;
        }
        openWhenReady();
    }

    public void setNextEpisodeAvailable(boolean available) {
        next.setVisibility(available ? View.VISIBLE : View.GONE);
        syncSession();
    }

    public void setOptionsAvailable(boolean available) {
        options.setVisibility(available ? View.VISIBLE : View.GONE);
    }

    public boolean hasAudioTracks() {
        return audioTracks().size() > 1;
    }

    public void showAudioTracks() {
        SparseArray<String> tracks = audioTracks();
        if (tracks.size() <= 1) return;
        MediaPlayer owner = player;
        int selected = -1;
        try { selected = tracks.indexOfKey(owner.getSelectedTrack(MediaPlayer.TrackInfo.MEDIA_TRACK_TYPE_AUDIO)); }
        catch (IllegalStateException ignored) {}

        CharSequence[] labels = new CharSequence[tracks.size()];
        for (int index = 0; index < tracks.size(); index++) labels[index] = tracks.valueAt(index);
        AlertDialog dialog = new AlertDialog.Builder(activity).setTitle("Tonspur")
            .setSingleChoiceItems(labels, selected, (choice, index) -> {
                if (owner == player && prepared) {
                    try { owner.selectTrack(tracks.keyAt(index)); }
                    catch (IllegalArgumentException | IllegalStateException error) {
                        Toast.makeText(activity, "Die Tonspur konnte nicht gewechselt werden.", Toast.LENGTH_SHORT).show();
                    }
                }
                choice.dismiss();
            }).create();
        dialog.setOnDismissListener(closed -> { if (owner == player) showControls(); });
        dialog.show();
    }

    private SparseArray<String> audioTracks() {
        SparseArray<String> result = new SparseArray<>();
        if (!prepared || player == null) return result;
        MediaPlayer.TrackInfo[] tracks;
        try { tracks = player.getTrackInfo(); }
        catch (IllegalStateException error) { return result; }
        if (tracks == null) return result;

        for (int index = 0; index < tracks.length; index++) {
            MediaPlayer.TrackInfo track = tracks[index];
            if (track == null || track.getTrackType() != MediaPlayer.TrackInfo.MEDIA_TRACK_TYPE_AUDIO) continue;
            String name = "Tonspur " + (result.size() + 1);
            String language = track.getLanguage();
            if (language != null && language.length() <= 35 && !"und".equalsIgnoreCase(language) &&
                language.matches("[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*")) {
                String tag = language.toLowerCase(Locale.ROOT).replace('_', '-');
                if ("deu".equals(tag) || "ger".equals(tag)) tag = "de";
                if ("eng".equals(tag)) tag = "en";
                String display = Locale.forLanguageTag(tag).getDisplayLanguage(Locale.GERMAN);
                if (!display.isEmpty()) name += " · " + display;
            }
            result.put(index, name);
        }
        return result;
    }

    public void setSkipAction(String label, long targetMs) {
        boolean available = !TextUtils.isEmpty(label) && targetMs >= 0;
        long target = available ? targetMs : -1;
        String text = available ? label : "";
        int visibility = available ? View.VISIBLE : View.GONE;
        if (target == skipToMs && visibility == skipAction.getVisibility() && TextUtils.equals(text, skipAction.getText())) return;
        boolean wasFocused = skipAction.isFocused();
        skipToMs = target;
        skipAction.setText(text);
        skipAction.setVisibility(visibility);
        if (available) {
            boolean controlsWereHidden = controls.getVisibility() != View.VISIBLE;
            showControls();
            if (controlsWereHidden) skipAction.requestFocus();
        } else if (wasFocused) playPause.requestFocus();
    }

    public long getPositionMs() {
        if (prepared && seekInFlight < 0 && !completed) readPosition();
        return positionMs;
    }

    public boolean isPlaying() {
        return wantsPlayback && source != null && !completed;
    }

    public void pauseForBackground() {
        if (backgrounded) return;
        resumePlayback = isPlaying();
        backgrounded = true;
        deactivateSession();
        pause();
        showControls();
    }

    public void stopForBackground() {
        pauseForBackground();
        closePlayer();
    }

    public void resumeFromBackground() {
        if (!backgrounded) return;
        backgrounded = false;
        wantsPlayback = resumePlayback;
        resumePlayback = false;
        if (prepared && wantsPlayback) start();
        else openWhenReady();
        showControls();
    }

    public void release() {
        checkpoint();
        source = null;
        wantsPlayback = false;
        backgrounded = resumePlayback = false;
        handler.removeCallbacks(hideTask);
        closePlayer();
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (controls.getVisibility() == View.VISIBLE) playPause.requestFocus();
    }

    @Override protected void onDetachedFromWindow() {
        release();
        super.onDetachedFromWindow();
    }

    @Override protected void onSizeChanged(int w, int h, int oldW, int oldH) {
        super.onSizeChanged(w, h, oldW, oldH);
        fitVideo();
    }

    @Override public void surfaceCreated(SurfaceHolder holder) {
        surfaceReady = true;
        openWhenReady();
    }

    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}

    @Override public void surfaceDestroyed(SurfaceHolder holder) {
        surfaceReady = false;
        checkpoint();
        closePlayer();
    }

    // Call before Activity's default dispatch while the player is on screen.
    public boolean handleKey(KeyEvent event) {
        int key = event.getKeyCode();
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        boolean up = event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled();
        boolean first = down && event.getRepeatCount() == 0;
        switch (key) {
            case KeyEvent.KEYCODE_BACK:
            case KeyEvent.KEYCODE_ESCAPE:
            case KeyEvent.KEYCODE_BUTTON_B:
            case KeyEvent.KEYCODE_MEDIA_STOP:
                if (up) back();
                return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A:
                if (first) {
                    View focus = findFocus();
                    if (controls.getVisibility() == View.VISIBLE && focus instanceof Button) focus.performClick();
                    else toggle();
                }
                return true;
            case KeyEvent.KEYCODE_DPAD_LEFT:
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                if (down) {
                    int direction = key == KeyEvent.KEYCODE_DPAD_LEFT ? -1 : 1;
                    if (controls.getVisibility() == View.VISIBLE) moveFocus(direction);
                    else skip(direction * SKIP_MS);
                }
                return true;
            case KeyEvent.KEYCODE_DPAD_UP:
            case KeyEvent.KEYCODE_DPAD_DOWN:
            case KeyEvent.KEYCODE_MENU:
                if (first) showControls();
                return true;
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                if (first) toggle();
                return true;
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                if (first) { start(); showControls(); }
                return true;
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                if (first) { pause(); showControls(); }
                return true;
            case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD:
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
                if (down) skip(-SKIP_MS);
                return true;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD:
                if (down) skip(SKIP_MS);
                return true;
            case KeyEvent.KEYCODE_MEDIA_NEXT:
                if (next.getVisibility() != View.VISIBLE) return false;
                if (first) next();
                return true;
            default:
                return false;
        }
    }

    private void openWhenReady() {
        if (source == null || !surfaceReady || player != null || completed || backgrounded) return;
        MediaPlayer opened = new MediaPlayer();
        player = opened;
        try {
            opened.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build());
            opened.setDisplay(video.getHolder());
            opened.setOnPreparedListener(this::onPrepared);
            opened.setOnSeekCompleteListener(this::onSeekComplete);
            opened.setOnCompletionListener(this::onComplete);
            opened.setOnVideoSizeChangedListener((origin, width, height) -> {
                if (origin != player || width <= 0 || height <= 0) return;
                pictureWidth = width;
                pictureHeight = height;
                fitVideo();
            });
            opened.setOnErrorListener((origin, what, extra) -> {
                if (origin == player) fail("Das Video konnte nicht abgespielt werden.");
                return true;
            });
            opened.setOnInfoListener((origin, what, extra) -> {
                if (origin != player || !prepared) return false;
                if (what == MediaPlayer.MEDIA_INFO_BUFFERING_START && wantsPlayback) {
                    buffering = true;
                    message("Video wird gepuffert …");
                    scheduleMediaTimeout();
                } else if (what == MediaPlayer.MEDIA_INFO_BUFFERING_END || what == MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START) {
                    buffering = false;
                    if (seekInFlight < 0) {
                        handler.removeCallbacks(mediaTimeout);
                        message(null);
                    }
                }
                syncSession();
                return false;
            });
            opened.setDataSource(activity, source);
            opened.prepareAsync();
            scheduleMediaTimeout();
        } catch (IOException | IllegalArgumentException | IllegalStateException | SecurityException error) {
            fail("Die Videoquelle konnte nicht geöffnet werden.");
        }
    }

    private void onPrepared(MediaPlayer origin) {
        if (origin != player) return;
        handler.removeCallbacks(mediaTimeout);
        prepared = true;
        durationMs = Math.max(0, origin.getDuration());
        if (positionMs > 0 && durationMs > 0) seek(positionMs);
        else {
            message(null);
            if (wantsPlayback) start();
        }
        if (origin == player) handler.post(tick);
    }

    private void onSeekComplete(MediaPlayer origin) {
        if (origin != player || seekInFlight < 0) return;
        handler.removeCallbacks(mediaTimeout);
        seekInFlight = -1;
        long nextPosition = queuedSeek;
        queuedSeek = -1;
        if (nextPosition >= 0) {
            seek(nextPosition);
            return;
        }
        message(null);
        updatePosition();
        checkpoint();
        if (origin == player && wantsPlayback) start();
        syncSession();
    }

    private void onComplete(MediaPlayer origin) {
        if (origin != player) return;
        completed = true;
        wantsPlayback = false;
        positionMs = durationMs;
        queuedSeek = seekInFlight = -1;
        handler.removeCallbacks(mediaTimeout);
        releaseSession();
        abandonAudio();
        setKeepScreenOn(false);
        message(null);
        updatePosition();
        showControls();
        checkpoint();
        listener.onComplete();
    }

    @SuppressWarnings("deprecation") // The legacy audio-focus API also supports Fire OS 6.
    private void start() {
        if (source == null || backgrounded) return;
        wantsPlayback = true;
        if (completed) {
            completed = false;
            positionMs = 0;
            if (prepared) seek(0);
            else openWhenReady();
        } else if (prepared && seekInFlight < 0) {
            try {
                if (!hasAudioFocus && audio != null) {
                    hasAudioFocus = audio.requestAudioFocus(audioFocus, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
                        == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
                    if (!hasAudioFocus) {
                        wantsPlayback = false;
                        message("Der Ton ist gerade nicht verfügbar.");
                        showControls();
                        return;
                    }
                }
                activateSession();
                player.start();
                started = true;
                syncSession();
                setKeepScreenOn(true);
                scheduleHide();
            } catch (IllegalStateException error) {
                fail("Die Wiedergabe konnte nicht gestartet werden.");
            }
        }
    }

    private void pause() {
        wantsPlayback = false;
        buffering = false;
        if (prepared && !completed) {
            if (started) {
                try { player.pause(); } catch (IllegalStateException ignored) {}
            }
            if (seekInFlight < 0) {
                handler.removeCallbacks(mediaTimeout);
                message(null);
            }
        }
        abandonAudio();
        setKeepScreenOn(false);
        checkpoint();
        syncSession();
    }

    private void toggle() {
        if (isPlaying()) pause();
        else start();
        showControls();
    }

    private void skip(int deltaMs) {
        long current = queuedSeek >= 0 ? queuedSeek : seekInFlight >= 0 ? seekInFlight : getPositionMs();
        seek(current + deltaMs);
        showControls();
    }

    private void skipMarker() {
        if (skipToMs < 0) return;
        long target = skipToMs;
        setSkipAction(null, -1);
        seek(target);
        showControls();
    }

    private void seek(long requested) {
        if (!prepared || durationMs <= 0) return;
        long target = Math.max(0, Math.min(requested, durationMs - 1));
        if (seekInFlight >= 0) {
            queuedSeek = target;
        } else {
            seekInFlight = target;
            scheduleMediaTimeout();
            try {
                if (Build.VERSION.SDK_INT >= 26) player.seekTo(target, MediaPlayer.SEEK_CLOSEST);
                else player.seekTo((int) target);
                completed = false;
            } catch (IllegalStateException error) {
                fail("Im Video konnte nicht gesprungen werden.");
            }
        }
        updatePosition();
        syncSession();
    }

    private void scheduleMediaTimeout() {
        handler.removeCallbacks(mediaTimeout);
        handler.postDelayed(mediaTimeout, MEDIA_TIMEOUT_MS);
    }

    private void readPosition() {
        try {
            positionMs = Math.max(0, player.getCurrentPosition());
            durationMs = Math.max(0, player.getDuration());
        } catch (IllegalStateException ignored) {}
    }

    private void checkpoint() {
        lastCheckpoint = SystemClock.uptimeMillis();
        if (!prepared || seekInFlight >= 0) return;
        if (!completed) readPosition();
        if (positionMs == lastPosition && durationMs == lastDuration && completed == lastFinished) return;
        lastPosition = positionMs;
        lastDuration = durationMs;
        lastFinished = completed;
        listener.onProgress(positionMs, durationMs, completed);
    }

    private void updatePosition() {
        long visible = queuedSeek >= 0 ? queuedSeek : seekInFlight >= 0 ? seekInFlight : getPositionMs();
        progress.setProgress(durationMs == 0 ? 0 : (int) Math.min(1_000, visible * 1_000 / durationMs));
        time.setText(durationMs == 0 ? formatTime(visible) : formatTime(visible) + " / " + formatTime(durationMs));
    }

    private void closePlayer() {
        handler.removeCallbacks(tick);
        handler.removeCallbacks(mediaTimeout);
        MediaPlayer closing = player;
        player = null;
        prepared = false;
        started = false;
        buffering = false;
        queuedSeek = seekInFlight = -1;
        if (closing != null) closing.release();
        releaseSession();
        abandonAudio();
        setKeepScreenOn(false);
    }

    private void fail(String error) {
        release();
        message(error);
        showControls();
        listener.onError(error);
    }

    @SuppressWarnings("deprecation")
    private void abandonAudio() {
        if (hasAudioFocus && audio != null) audio.abandonAudioFocus(audioFocus);
        hasAudioFocus = false;
    }

    @SuppressWarnings("deprecation") // API 25 requires explicitly setting both MediaSession flags.
    private void activateSession() {
        if (session == null) {
            session = new MediaSession(activity, "KinoTix");
            if (Build.VERSION.SDK_INT < 26) {
                session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
            }
            session.setCallback(new MediaSession.Callback() {
                @Override public void onPlay() { start(); showControls(); }
                @Override public void onPause() { pause(); showControls(); }
                @Override public void onSeekTo(long position) { seek(position); showControls(); }
                @Override public void onFastForward() { skip(SKIP_MS); }
                @Override public void onRewind() { skip(-SKIP_MS); }
                @Override public void onSkipToNext() {
                    if (next.getVisibility() == View.VISIBLE) next();
                }
                @Override public void onStop() { back(); }
            }, handler);
            session.setMetadata(new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE,
                heading.getText().toString()).putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs).build());
        }
        session.setActive(true);
    }

    private void syncSession() {
        if (session == null) return;
        long actions = PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP |
            (wantsPlayback ? PlaybackState.ACTION_PAUSE : PlaybackState.ACTION_PLAY);
        if (durationMs > 0) actions |= PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_REWIND | PlaybackState.ACTION_FAST_FORWARD;
        if (next.getVisibility() == View.VISIBLE) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;
        boolean playing = wantsPlayback && !buffering && seekInFlight < 0;
        int state = playing ? PlaybackState.STATE_PLAYING : wantsPlayback ? PlaybackState.STATE_BUFFERING : PlaybackState.STATE_PAUSED;
        session.setPlaybackState(new PlaybackState.Builder().setActions(actions)
            .setState(state, getPositionMs(), playing ? 1f : 0f, SystemClock.elapsedRealtime()).build());
    }

    private void deactivateSession() {
        if (session != null) session.setActive(false);
    }

    private void releaseSession() {
        if (session == null) return;
        session.release();
        session = null;
    }

    private void back() { checkpoint(); listener.onBack(); }
    private void next() { checkpoint(); listener.onNext(); }
    private void options() { checkpoint(); listener.onOptions(); }

    private void moveFocus(int direction) {
        View focus = findFocus();
        int index = 0;
        while (index < actions.length && actions[index] != focus) index++;
        for (int i = index + direction; i >= 0 && i < actions.length; i += direction) {
            if (actions[i].getVisibility() == View.VISIBLE && actions[i].requestFocus()) break;
        }
        showControls();
    }

    private void showControls() {
        controls.setVisibility(View.VISIBLE);
        if (!(findFocus() instanceof Button)) playPause.requestFocus();
        playPause.setText(isPlaying() ? "Pause" : "Abspielen");
        scheduleHide();
    }

    private void scheduleHide() {
        handler.removeCallbacks(hideTask);
        if (prepared && isPlaying()) handler.postDelayed(hideTask, CONTROL_TIMEOUT_MS);
    }

    private void hideControls() {
        if (!isPlaying()) return;
        controls.setVisibility(View.INVISIBLE);
        requestFocus();
    }

    private void message(String content) {
        status.setText(content);
        status.setVisibility(content == null ? View.GONE : View.VISIBLE);
    }

    private void fitVideo() {
        if (video == null) return;
        int availableWidth = getWidth();
        int availableHeight = getHeight();
        int width = LayoutParams.MATCH_PARENT;
        int height = LayoutParams.MATCH_PARENT;
        if (pictureWidth > 0 && pictureHeight > 0 && availableWidth > 0 && availableHeight > 0) {
            double scale = Math.min((double) availableWidth / pictureWidth, (double) availableHeight / pictureHeight);
            width = (int) Math.round(pictureWidth * scale);
            height = (int) Math.round(pictureHeight * scale);
        }
        ViewGroup.LayoutParams params = video.getLayoutParams();
        if (params.width == width && params.height == height) return;
        params.width = width;
        params.height = height;
        video.setLayoutParams(params);
    }

    private TextView label(int size) {
        TextView label = new TextView(activity);
        label.setTextColor(Color.WHITE);
        label.setTextSize(size);
        return label;
    }

    private Button button(LinearLayout row, String label, Runnable action) {
        Button button = new Button(activity);
        button.setText(label);
        button.setTextSize(15);
        button.setAllCaps(false);
        button.setSingleLine(true);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setPadding(dp(14), 0, dp(14), 0);
        button.setTextColor(Color.WHITE);
        StateListDrawable background = new StateListDrawable();
        GradientDrawable focused = panel(0xff23416a);
        focused.setStroke(dp(2), ACCENT);
        background.addState(new int[] { android.R.attr.state_focused }, focused);
        background.addState(new int[0], panel(0xff263345));
        button.setBackground(background);
        button.setOnClickListener(view -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, dp(46));
        params.setMargins(dp(4), dp(9), dp(4), 0);
        row.addView(button, params);
        return button;
    }

    private GradientDrawable panel(int color) {
        GradientDrawable panel = new GradientDrawable();
        panel.setColor(color);
        panel.setCornerRadius(dp(9));
        return panel;
    }

    private GradientDrawable shade(GradientDrawable.Orientation orientation) {
        return new GradientDrawable(orientation, new int[] { 0xeb000000, Color.TRANSPARENT });
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static String formatTime(long millis) {
        long seconds = millis / 1_000;
        long hours = seconds / 3_600;
        if (hours == 0) return String.format(Locale.GERMANY, "%d:%02d", seconds / 60, seconds % 60);
        return String.format(Locale.GERMANY, "%d:%02d:%02d", hours, seconds / 60 % 60, seconds % 60);
    }
}
