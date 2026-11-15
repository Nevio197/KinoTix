# KinoTix für Fire TV

Die Android-App läuft eigenständig auf Fire OS ab Version 6 (Android API 25). Sie braucht Internetzugang für HTTPS-Quellen und GitHub-Updates. Die App nutzt die Android-Version von Fire OS. Vega OS verwendet ein eigenes App-Format.

Mit dem Steuerkreuz erreichst du Mediathek, Merkliste, Suche und Einstellungen. Über **Quelle hinzufügen** akzeptiert KinoTix direkte HTTPS-Videos, Medienlisten und KinoTix-Kataloge mit statischen HTML-Quellen. Die lokale Dateiauswahl hängt von den verfügbaren Apps auf dem Gerät ab. Wiedergabestand, Merkliste und Profile bleiben auf dem Fire TV gespeichert. Bei der Wiedergabe blendet sich die Leiste nach kurzer Zeit aus. Mit einer Richtungstaste lässt sie sich wieder einblenden. Die mittlere Taste pausiert die Wiedergabe und setzt sie fort.

## Updates

KinoTix prüft beim App-Start den Fire-TV-Kanal in diesem GitHub-Repo und lädt neue APKs automatisch im Hintergrund. Unter **Einstellungen → Software-Updates** lässt sich erneut suchen. Sobald der Download geprüft ist, startet **Update installieren** den Fire-TV-Systeminstaller. Auf Fire OS 7 erfordert er eventuell die einmalige Freigabe von KinoTix als Installationsquelle und bestätigt jedes Update. Merkliste und Fortschritt bleiben in der App gespeichert.

Der Kanal verwendet eigene GitHub-Vorabversionen mit Tags `firetv-vX.Y.Z`. Er erwartet eine Datei `KinoTix-X.Y.Z-FireTV.apk` mit der von GitHub gelieferten SHA-256-Prüfsumme. Die App prüft vor der Installation zusätzlich Paketname, Versionscode und Signaturzertifikat.

## APK bauen und aktualisieren

Installiere JDK 17, die Android Platform 34 und Build-Tools 35.0.0. Setze `JAVA_HOME` und `ANDROID_SDK_ROOT`. `firetv/version.txt` ist die Fire-TV-Versionsnummer.

- `firetv/build.sh --test` baut eine lokal signierte Test-APK für Emulatoren und Debugging.
- `firetv/build.sh` baut die Release-APK in `dist/firetv/`. Dafür müssen `KINOTIX_FIRETV_KEYSTORE`, `KINOTIX_FIRETV_KEY_ALIAS`, `KINOTIX_FIRETV_STORE_PASSWORD` und `KINOTIX_FIRETV_KEY_PASSWORD` gesetzt sein. Folgeversionen brauchen denselben Signierschlüssel. Schlüssel und Passwort gehören in die private Ablage des Herausgebers.
- Erhöhe für ein Update `firetv/version.txt`, baue die APK und veröffentliche sie mit dem passenden Tag als Vorabversion in diesem Repository. Markiere sie dabei nicht als neueste allgemeine Version. Teste das Upgrade aus einer älteren signierten APK mit einem vorhandenen Wiedergabestand.

Amazon beschreibt die ADB-Erstinstallation für Entwickler. Distribution über den Amazon Appstore hat einen eigenen Veröffentlichungsweg. [Fire TV über ADB verbinden](https://developer.amazon.com/docs/fire-tv/connecting-adb-to-device.html)

## Umfang dieser Ausgabe

Der Katalogleser wertet HTML und eingebettete Video-Elemente als Daten aus. Skriptbasierte Einbettungen, geräteübergreifender Kontoabgleich sowie Fernsteuerung von einem zweiten Gerät stehen für Fire TV noch aus.
