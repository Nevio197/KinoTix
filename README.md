# KinoTix

Desktop-Videoplayer für Windows x64 und macOS. Füge unter **Medium hinzufügen** eigene Videodateien, freigegebene direkte HTTPS-Videolinks oder eine [JSON-Medienliste](examples/medienliste.json) hinzu.

## Download

Der [Windows-Teststand 0.3.1](https://github.com/Nevio197/KinoTix/releases/tag/windows-preview-0.3.1) lässt sich als Setup herunterladen und manuell installieren. Das Setup ist unsigniert und aktualisiert sich noch nicht automatisch. Der Mac-Gerätetest steht aus. Eigene Kataloge kannst du nach der Installation importieren.

Im Fenster bleibt die Hauptnavigation sichtbar. Im Player findest du Zeitleiste, Lautstärke, Bild-in-Bild, Schlaftimer und Vollbild. Quelle, Qualität und nächste Folge stehen zur Verfügung, wenn die Medienliste sie anbietet. Intro und Abspann werden mit passenden [Zeitmarken](docs/ZEITMARKEN.md) automatisch übersprungen. Der [MacBook-Auftrag](docs/MAC-AUFTRAG.md) enthält die ausstehenden Gerätetests.

Unter Windows sind Katalogimport, Suche, Quellenauswahl, Wiedergabe und Fortsetzen geprüft. Google-Anmeldung und Verbindung zum Supabase-Projekt liefen in Version 0.3.0 live. Version 0.3.1 hält die Verläufe zusätzlicher lokaler Profile vom gemeinsamen Kontoverlauf getrennt. Der Abgleich zwischen Windows und macOS und die signierten Auto-Updates stehen als Gerätetests aus.

## Ohne Konto oder mit Google

Im Gastmodus bleiben Kataloge, Merkliste und Verlauf auf dem jeweiligen Gerät. Mit **Google-Konto → Mit Google anmelden** öffnest du die Anmeldung im Browser. Supabase synchronisiert danach deine importierten Kataloge und den Wiedergabestand von **Mein Profil** zwischen Windows und macOS. [Supabase-Konto einrichten](docs/SUPABASE.md) · [Eigene Kataloge importieren](docs/KATALOGE.md)

## Bauen

Voraussetzung ist Node.js 24. Aus dem Repository ausführen.

```sh
npm ci --ignore-scripts --prefix app
npm ci --ignore-scripts --prefix windows
npm run windows --prefix windows
```

Auf dem Mac den letzten Befehl durch `npm run mac --prefix windows` ersetzen. Installer liegen danach in `dist/`.

## Updates und öffentliche Releases

Der signierte Build für ein öffentliches GitHub-Repository prüft beim Start auf neue stabile Releases. Der Updater lädt im Hintergrund und installiert beim regulären Beenden. Danach reicht es, KinoTix wieder zu öffnen.

Der Release-Workflow baut bei Tags `vX.Y.Z`, die zu `app/package.json` passen, den Windows-Installer sowie DMG und ZIP für macOS. Er veröffentlicht die Update-Manifeste zusammen mit dem vollständigen Release. Hinterlege im neuen Repository `WINDOWS_CSC_LINK`, `WINDOWS_CSC_PASSWORD`, `MAC_CSC_LINK`, `MAC_CSC_PASSWORD`, `APPLE_ID` und `APPLE_APP_SPECIFIC_PASSWORD` als Actions-Secrets. Trage `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `KINOTIX_WINDOWS_PUBLISHER` und `APPLE_TEAM_ID` als Actions-Variablen ein. Die Windows-Signatur muss zum eingestellten Herausgeber passen. Der Mac verwendet Developer ID und Apple-Notarisierung. [Electron-Builder zu Auto-Updates](https://www.electron.build/docs/features/auto-update/)

Lokale Builds ohne öffentliches Zielrepository haben keinen Update-Kanal. Teste vor dem ersten öffentlichen Release den signierten Wechsel zwischen zwei Testversionen auf Windows und macOS.
