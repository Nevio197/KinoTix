# <img src="app/art/mark.png" width="38" height="38" alt=""> KinoTix

Desktop-Videoplayer für Windows x64 und macOS. Füge unter **Medium hinzufügen** eigene Videodateien, freigegebene direkte HTTPS-Videolinks oder eine [JSON-Medienliste](examples/medienliste.json) hinzu.

**[KinoTix für Windows herunterladen](https://github.com/Nevio197/KinoTix/releases/latest)**. Installiere den GitHub-Build einmal, um automatische Updates einzuschalten. Für macOS stehen der native Gerätetest und das signierte Release aus.

Auf der Startseite zeigt **Weiterschauen** den Fortschritt und die Restlaufzeit. Der Player bietet eine Bildvorschau und Zeitmarken auf der Zeitleiste, Lautstärke, Bild-in-Bild, Schlaftimer und Vollbild. Bei verfügbaren Alternativen kann KinoTix nach einem Wiedergabefehler die Quelle wechseln. Tonspurwahl, Qualität und nächste Folge erscheinen bei passenden Medien. [Zeitmarken für Intro und Abspann](docs/ZEITMARKEN.md)

Katalogimport, Wiedergabe, Quellenwechsel, Zeitleistenvorschau und Tonspurwahl sind auf Windows geprüft. Google-Anmeldung und die Verbindung zum Supabase-Projekt wurden auf Windows live getestet. Der [MacBook-Auftrag](docs/MAC-AUFTRAG.md) beschreibt die ausstehenden Mac- und geräteübergreifenden Tests.

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

Der GitHub-Build prüft beim Start auf neue stabile Releases. Der Updater lädt im Hintergrund und installiert beim regulären Beenden. Danach reicht es, KinoTix wieder zu öffnen.

Der Release-Workflow baut bei Tags `vX.Y.Z`, die zu `app/package.json` passen, zunächst den Windows-Installer und dessen Update-Dateien. Der Windows-Updater vertraut dem im Build hinterlegten Ed25519-Schlüssel. Er prüft die Signatur des Manifests und anschließend Größe und SHA-256 des Installers. Der Installer verwendet weiterhin die üblichen Windows-Installationsregeln.

Hinterlege im öffentlichen KinoTix-Repository die Actions-Variablen `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` und `KINOTIX_WINDOWS_UPDATE_PUBLIC_KEY`. Der öffentliche Schlüssel wird als Base64-kodierter DER-Schlüssel (SPKI) gespeichert. Hinterlege den passenden privaten PEM-Schlüssel Base64-kodiert als Actions-Secret `KINOTIX_WINDOWS_UPDATE_PRIVATE_KEY`. Behalte denselben Schlüssel für Folgeversionen, damit bereits installierte Builds neue Releases erkennen. Die optionalen Secrets `WINDOWS_CSC_LINK`, `WINDOWS_CSC_PASSWORD` und die Variable `KINOTIX_WINDOWS_PUBLISHER` konfigurieren zusätzlich eine Windows-Authenticode-Signatur.

Sobald der Mac-Build und seine Updates geprüft sind, setze zusätzlich `KINOTIX_MAC_RELEASE_ENABLED=true` und hinterlege `APPLE_TEAM_ID` als Actions-Variable. Ergänze die Secrets `MAC_CSC_LINK`, `MAC_CSC_PASSWORD`, `APPLE_ID` und `APPLE_APP_SPECIFIC_PASSWORD`. Ab der ersten macOS-Veröffentlichung müssen neue stabile Releases beide Plattformen samt Update-Dateien enthalten, weil beide Apps dasselbe aktuelle GitHub-Release lesen. Der Mac verwendet Developer ID und Apple-Notarisierung. [Electron-Builder zu Auto-Updates](https://www.electron.build/v26/docs/features/auto-update/)

Lokale Builds ohne Update-Konfiguration haben keinen Update-Kanal. Installiere für automatische Updates einmal den dafür konfigurierten GitHub-Build. Teste den Wechsel zwischen zwei Versionen pro Plattform.
