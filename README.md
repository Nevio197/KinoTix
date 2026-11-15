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

Der Release-Workflow baut bei Tags `vX.Y.Z`, die zu `app/package.json` passen, zunächst den Windows-Installer und dessen Update-Dateien. Hinterlege im öffentlichen KinoTix-Repository die Actions-Secrets `WINDOWS_CSC_LINK` und `WINDOWS_CSC_PASSWORD` sowie die Actions-Variablen `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` und `KINOTIX_WINDOWS_PUBLISHER`. Die Windows-Signatur muss zum eingestellten Herausgeber passen.

Sobald der Mac-Build und seine Updates geprüft sind, setze zusätzlich `KINOTIX_MAC_RELEASE_ENABLED=true` und hinterlege `APPLE_TEAM_ID` als Actions-Variable. Ergänze die Secrets `MAC_CSC_LINK`, `MAC_CSC_PASSWORD`, `APPLE_ID` und `APPLE_APP_SPECIFIC_PASSWORD`. Ab der ersten macOS-Veröffentlichung müssen neue stabile Releases beide Plattformen samt Update-Dateien enthalten, weil beide Apps dasselbe aktuelle GitHub-Release lesen. Der Mac verwendet Developer ID und Apple-Notarisierung. [Electron-Builder zu Auto-Updates](https://www.electron.build/v26/docs/features/auto-update/)

Lokale Builds haben keinen Update-Kanal. Installiere für automatische Updates einmal den signierten GitHub-Build. Teste den Wechsel zwischen zwei signierten Versionen pro Plattform.
