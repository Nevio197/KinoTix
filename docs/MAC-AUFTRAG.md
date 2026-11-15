# Aufgabe für das MacBook

Teste **KinoTix 0.3.1** aus diesem Quellcode auf macOS. Die App ist ein eigener Ableger. Verwende dieses Repo und bei Release-Tests dessen eigene App-ID `de.kinotix.desktop` und eigene Plattform-Zugangsdaten.

## 1. Eigenen Player prüfen

1. Im Repo-Ordner Node.js 24 nutzen und diese Befehle ausführen.

   ```sh
   npm ci --ignore-scripts --prefix app
   npm ci --ignore-scripts --prefix windows
   npm run mac --prefix windows
   ```

2. Die App aus `dist/` öffnen. Im Fenster muss die Hauptnavigation sichtbar bleiben. Unter ihr liegt das Video mit eigenen einblendbaren Bedienelementen. Im Vollbild sollen diese Bedienelemente gleich aussehen und die Zeitleiste benutzbar bleiben. Escape prüfen.
3. Eine eigene MP4-Datei abspielen. Lautstärke im Fenster und im Vollbild ändern, auch stumm schalten, die App beenden und neu starten. Danach Pegel und gespeicherten Wiedergabestand prüfen.
4. Die [Beispielliste](../examples/medienliste.json) mit eigenen Testvideos in den dort genannten Dateien nachstellen und importieren. In derselben Folge Quelle und Qualität wechseln. Zeitposition, Pause und Lautstärke sollen erhalten bleiben. Zur nächsten Folge wechseln und den automatischen Countdown einmal abbrechen.
5. Bild-in-Bild öffnen und schließen. Den Schlaftimer auf **Nach diesem Video** setzen und prüfen, dass am Ende keine weitere Folge startet.
6. Mit zu den Testvideos passenden Marken prüfen, dass Intro und Abspann springen, Rückgängigmachen wirkt und eine Abspannszene abgespielt wird. Prüfe auch ein Video ohne Marken. [Zeitmarken und Importformat](ZEITMARKEN.md)

## 2. Google-Konto und Gastmodus prüfen

- Erst Gastmodus testen und nach Neustart Fortschritt und Merkliste prüfen. Der Gastverlauf bleibt auf dem jeweiligen Rechner.
- Mit dem [Supabase-Projekt für KinoTix](SUPABASE.md) auf Mac und Windows dasselbe Testkonto anmelden. Auf Windows eine eigene Katalogdatei importieren, auf dem Mac denselben Katalog öffnen. Eine Folge auf Windows abspielen, synchronisieren und unter **Weiterschauen** auf dem Mac fortsetzen.
- In einem zusätzlichen lokalen Profil abspielen und prüfen, dass dessen Fortschritt auf diesem Gerät bleibt. Zum synchronisierten Verlauf über **Mein Profil** zurückwechseln. Abmelden, ein zweites Testkonto testen und nach dem Abmelden den Gastverlauf prüfen.
- Die Supabase-Projekt-URL und den Publishable Key in `app/supabase.json` für den Testbuild ablegen. Das Google-Client-Secret bleibt bei Supabase.

## 3. Signierung und Updates prüfen

- Der Mac-Build ist für Apple Silicon und Intel als Universal-App konfiguriert. Den nativen Test und die Hardware dokumentieren.
- Sobald Developer-ID-Signatur und Notarisierungszugang verfügbar sind, DMG und ZIP signiert bauen. Windows-Herausgeber und Signatur, Google-Client sowie das eigene öffentliche Test-Repository gemäß README vorbereiten.
- Zwei signierte Testversionen erstellen und den echten Updatepfad prüfen. Ältere App öffnen, im Hintergrund laden lassen, regulär beenden und wieder öffnen. Versionsnummer und vorhandene lokale Daten prüfen. Die Installer sowie `latest.yml` und `latest-mac.yml` gehören zum jeweiligen Release.
- Ergebnis und offene Punkte im Repo festhalten. Die Windows-Funktionsprüfung lief mit Testvideos. Der Google-Login und die erste Synchronisierung liefen auf Windows gegen Supabase live. Der native Mac-Test, der Abgleich zwischen beiden Geräten und der signierte Update-Test sind offene Aufgaben.
