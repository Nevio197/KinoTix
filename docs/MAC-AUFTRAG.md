# Aufgabe für das MacBook

Teste **KinoTix 0.4.4** aus diesem Quellcode auf macOS. Verwende für Release-Tests die App-ID `de.kinotix.desktop` und die eigenen Zugangsdaten für Signierung und Notarisierung.

## 1. Eigenen Player prüfen

1. Im Repo-Ordner Node.js 24 nutzen und diese Befehle ausführen.

   ```sh
   npm ci --ignore-scripts --prefix app
   npm ci --ignore-scripts --prefix windows
   npm run mac:local --prefix windows
   ```

2. Die App `dist/mac-universal/KinoTix.app` öffnen. Für einen Test mit einem Build nur für den eigenen Prozessor gibt es `npm run mac:native --prefix windows`. Im Fenster muss die Hauptnavigation sichtbar bleiben. Unter ihr liegt das Video mit eigenen einblendbaren Bedienelementen. Im Vollbild sollen diese Bedienelemente gleich aussehen und die Zeitleiste benutzbar bleiben. Escape prüfen.
3. Eine eigene MP4-Datei abspielen. Lautstärke im Fenster und im Vollbild ändern, auch stumm schalten, die App beenden und neu starten. Danach Pegel und gespeicherten Wiedergabestand prüfen.
4. Die [Beispielliste](../examples/medienliste.json) mit eigenen Testvideos in den dort genannten Dateien nachstellen und importieren. In derselben Folge Quelle und Qualität wechseln. Zeitposition, Pause und Lautstärke sollen erhalten bleiben. Zur nächsten Folge wechseln und den automatischen Countdown einmal abbrechen.
5. Bild-in-Bild öffnen und schließen. Den Schlaftimer auf **Nach diesem Video** setzen und prüfen, dass am Ende keine weitere Folge startet.
6. Mit zu den Testvideos passenden Marken prüfen, dass Intro und Abspann springen, Rückgängigmachen wirkt und eine Abspannszene abgespielt wird. Prüfe auch ein Video ohne Marken. [Zeitmarken und Importformat](ZEITMARKEN.md)
7. In der Mediathek nach angefangener Wiedergabe die große Karte unter **Weiterschauen** prüfen. Sie zeigt Restlaufzeit und Fortschritt. Startseite, Titelansicht und Dialoge an einem kleinen Fenster sowie im Vollbild prüfen.
8. Beim Darüberfahren über die Zeitleiste die Bildvorschau prüfen. Mit zwei AAC-Tonspuren die Sprache wechseln. Eine absichtlich unbrauchbare erste Quelle mit einer intakten zweiten Quelle testen. Folge, Position, Pause, Qualität und bevorzugte Tonspur sollen beim Wechsel erhalten bleiben.
9. Unter **Hinzufügen** einen direkten Videolink, einen HTTPS-Link zu einem KinoTix-Katalog und eine einfache Webseite prüfen. Die ersten beiden lassen sich übernehmen. Für die Webseite erscheint ein Hinweis. Über die gemeinsame Dateiauswahl je eine Videodatei, Medienliste und Katalogdatei testen.
10. Mit einem frischen Profil unter **Einstellungen → Verbindung** den Modus **Automatisch** prüfen. Einen HTTPS-Testkatalog laden, dessen Name über das System-DNS nicht aufgelöst wird, aber über verschlüsseltes DNS erreichbar ist. Katalog, Suche und Wiedergabe prüfen. Der Verbindungsdialog soll jetzt sicheres DNS als aktiv anzeigen. Anschließend die Modi **System-DNS** und **Immer sicheres DNS** jeweils nach einem Neustart prüfen.
11. Mit einem Katalog prüfen, dass Startseite, Karten und Titelansicht die zugehörigen Cover anzeigen. Verwende für den Test eine Titelkarte mit einem Logo vor dem eigentlichen, verzögert geladenen Cover.

## 2. Google-Konto und Gastmodus prüfen

- Erst Gastmodus testen und nach Neustart Fortschritt und Merkliste prüfen. Der Gastverlauf bleibt auf dem jeweiligen Rechner.
- Mit dem [Supabase-Projekt für KinoTix](SUPABASE.md) auf Mac und Windows dasselbe Testkonto anmelden. Auf Windows eine eigene Katalogdatei importieren, auf dem Mac denselben Katalog öffnen. Eine Folge auf Windows abspielen, synchronisieren und unter **Weiterschauen** auf dem Mac fortsetzen.
- In einem zusätzlichen lokalen Profil abspielen und prüfen, dass dessen Fortschritt auf diesem Gerät bleibt. Zum synchronisierten Verlauf über **Mein Profil** zurückwechseln. Abmelden, ein zweites Testkonto testen und nach dem Abmelden den Gastverlauf prüfen.
- Die Supabase-Projekt-URL und den Publishable Key in `app/supabase.json` für den Testbuild ablegen. Das Google-Client-Secret bleibt bei Supabase.

## 3. Signierung und Updates prüfen

- Der Mac-Build ist für Apple Silicon und Intel als Universal-App konfiguriert. Den nativen Test und die Hardware dokumentieren.
- Sobald Developer-ID-Signatur und Notarisierungszugang verfügbar sind, DMG und ZIP für den Mac-Update-Kanal bauen. Richte die Mac-Freigabe im öffentlichen KinoTix-Repo gemäß README ein. Lokale ad-hoc-Builds haben keinen Update-Kanal.
- Zwei Testversionen mit verifizierbaren Updates erstellen. Ältere App öffnen, im Hintergrund laden lassen, regulär beenden und wieder öffnen. Versionsnummer und vorhandene lokale Daten prüfen. Zum Release gehören die Installer, das signierte Windows-Manifest `kinotix-windows-x64.json` samt `.sig` sowie für macOS `latest-mac.yml`, das Universal-ZIP und dessen Blockmap.

## Ergebnis für den lokalen Universal-Build

- Auf Apple Silicon mit der gepackten App geprüft: Dateiauswahl, lokales und HTTPS-Video, Medienlisten, Katalogimport, Suche und Cover. Der Testfilm lief auch nach Auswahl im macOS-Dateidialog.
- Geprüft sind Vollbild und Escape, Zeitleiste und Vorschaubild, Lautstärke, Bild-in-Bild, Audio- und Qualitätswechsel, Ersatzquelle, Intro- und Abspannmarken, Folgenwechsel und Schlaftimer. Fortsetzung, Lautstärke und Merkliste blieben nach dem Neustart erhalten. `⌘Q` hat die App während der Wiedergabe regulär beendet.
- Dieselbe Universal-App lief als x86_64-Prozess unter Rosetta. Dort bestanden die Prüfungen für MP4, Vollbild, Zeitleiste, Lautstärke, Bild-in-Bild, Beenden, Fortsetzen und Trennung lokaler Profile. Ein physischer Intel-Mac steht für die Prüfung aus.
- Das x64-Testpaket startete unter Windows 11 ARM in UTM. Die Wiedergabe und Vollbild ließen sich über den nicht interaktiven Gastzugang nicht verlässlich prüfen.
- Die Verbindungseinstellungen wurden nach Neustart geprüft. Die automatische Wiederholung nach einem DNS-Fehler ist durch automatisierte Tests abgedeckt. Der Test mit einem live nur über sicheres DNS erreichbaren Katalog steht aus.
- Die Synchronisierungslogik hat im Test mit nachgebildetem Server den genauen Wiedergabestand übertragen. Das konfigurierte Projekt leitet die Anmeldung an Google weiter. Anmeldung und Übertragung zwischen Mac und Windows mit demselben Konto stehen aus.
- DMG und ZIP enthalten verifizierten arm64- und x86_64-Code. Die lokale Ad-hoc-Signatur ist für Tests gedacht. Für den öffentlichen Build und den Update-Test zwischen zwei veröffentlichten Versionen fehlen Developer-ID-Signatur und Notarisierungszugang.
