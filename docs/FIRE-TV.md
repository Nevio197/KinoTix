# KinoTix für Fire TV

Die Android-App läuft eigenständig auf Fire OS ab Version 6 (Android API 25). Sie braucht Internetzugang für HTTPS-Quellen und GitHub-Updates. Die App nutzt die Android-Version von Fire OS. Vega OS verwendet ein eigenes App-Format.

Die aktuelle [Fire-TV-Vorabversion](https://github.com/Nevio197/KinoTix/releases/tag/firetv-v0.1.7) enthält die APK für die Erstinstallation. Unter Fire OS 7 funktioniert die APK-Signaturprüfung ab KinoTix 0.1.2.

Mit dem Steuerkreuz erreichst du Mediathek, Merkliste, Suche und Einstellungen. Über **Quelle hinzufügen** akzeptiert KinoTix direkte HTTPS-Videos, Medienlisten und KinoTix-Kataloge mit statischen HTML-Quellen. Die lokale Dateiauswahl hängt von den verfügbaren Apps auf dem Gerät ab. Bei der Wiedergabe blendet sich die Leiste nach kurzer Zeit aus. Mit einer Richtungstaste lässt sie sich wieder einblenden. Die mittlere Taste pausiert die Wiedergabe und setzt sie fort.

Die Suche zeigt sofort Treffer aus deiner Mediathek. Kataloge mit hinterlegtem Suchindex liefern weitere Treffer, sobald ihr Index geladen ist.

## Konto und Spielstand

Ab Version 0.1.5 öffnest du **Einstellungen → Google-Konto → Mit Handy anmelden** und scannst den QR-Code. Melde dich auf dem Handy mit demselben Google-Konto wie am Mac an. Wähle am Fernseher **Mit diesem Konto verbinden**, wenn das angezeigte Konto stimmt. Der QR-Code ist fünf Minuten gültig. Die Anmeldung im TV-Browser steht ebenfalls im Kontomenü.

Anschließend synchronisiert KinoTix Kataloge, direkte HTTPS-Videolinks und den Wiedergabestand von **Mein Profil**. Wenn du einen Videolink im angemeldeten Konto hinzufügst, erscheint der Titel auf den angemeldeten Geräten. Über **Jetzt synchronisieren** lässt sich der Abgleich sofort anstoßen. Über **Vorhandene Videolinks ins Konto übernehmen** kannst du bereits im Fire-TV-Konto gespeicherte Links nachträglich übertragen.

Merkliste, Zusatzprofile, lokale Dateien und Links mit erkennbaren Zugangsdaten bleiben auf dem jeweiligen Gerät. Als Datei importierte Medienlisten werden wie lokale Dateien behandelt.

Im Gastmodus gespeicherte Kataloge kannst du im Kontomenü ausdrücklich ins Konto übernehmen. Nach dem Abmelden öffnet sich wieder die Gastmediathek.

## Updates

KinoTix prüft beim App-Start den Fire-TV-Kanal in diesem GitHub-Repo und lädt neue APKs automatisch im Hintergrund. Unter **Einstellungen → Software-Updates** lässt sich erneut suchen. Sobald der Download geprüft ist, startet **Update installieren** den Fire-TV-Systeminstaller. Auf Fire OS 7 erfordert er eventuell die einmalige Freigabe von KinoTix als Installationsquelle und bestätigt jedes Update. Merkliste und Fortschritt bleiben in der App gespeichert.

Der Kanal verwendet eigene GitHub-Vorabversionen mit Tags `firetv-vX.Y.Z`. Er erwartet eine Datei `KinoTix-X.Y.Z-FireTV.apk` mit der von GitHub gelieferten SHA-256-Prüfsumme. Die App prüft vor der Installation zusätzlich Paketname, Versionscode und Signaturzertifikat.

## APK bauen und aktualisieren

Installiere JDK 17, die Android Platform 34 und Build-Tools 35.0.0. Setze `JAVA_HOME` und `ANDROID_SDK_ROOT`. `firetv/version.txt` ist die Fire-TV-Versionsnummer.

- `firetv/build.sh --test` baut eine lokal signierte Test-APK für Emulatoren und Debugging.
- `firetv/build.sh` baut die Release-APK in `dist/firetv/`. Dafür müssen `KINOTIX_FIRETV_KEYSTORE`, `KINOTIX_FIRETV_KEY_ALIAS`, `KINOTIX_FIRETV_STORE_PASSWORD` und `KINOTIX_FIRETV_KEY_PASSWORD` gesetzt sein. Folgeversionen brauchen denselben Signierschlüssel. Schlüssel und Passwort gehören in die private Ablage des Herausgebers.
- Die Google-Anmeldung verwendet `app/supabase.json` oder die unter `KINOTIX_FIRETV_ACCOUNT_CONFIG` angegebene Datei. Der Build übernimmt daraus nur die Projektadresse und den öffentlichen Publishable Key.
- Erhöhe für ein Update `firetv/version.txt`, baue die APK und veröffentliche sie mit dem passenden Tag als Vorabversion in diesem Repository. Markiere sie dabei nicht als neueste allgemeine Version. Teste das Upgrade aus einer älteren signierten APK mit einem vorhandenen Wiedergabestand.

Für die QR-Anmeldung im eigenen Supabase-Projekt wende die Migration `kinotix_tv_pairing` an und deploye die Edge Function `kinotix-tv-auth` mit der Einstellung aus `supabase/config.toml`. Ergänze unter **Authentication → URL Configuration → Redirect URLs** den Eintrag `https://<projekt>.supabase.co/functions/v1/kinotix-tv-auth/callback/*/*` zu den vorhandenen Adressen. [Supabase Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)

Amazon beschreibt die ADB-Erstinstallation für Entwickler. Distribution über den Amazon Appstore hat einen eigenen Veröffentlichungsweg. [Fire TV über ADB verbinden](https://developer.amazon.com/docs/fire-tv/connecting-adb-to-device.html)

## Geprüfte Updates

- Im Android-TV-12-Emulator lud 0.1.0 beim Start die signierte 0.1.1 von GitHub. Nach Bestätigung im Installer war 0.1.1 installiert. Eine zuvor veränderte Wiedergabeeinstellung blieb erhalten.
- Auf einem Fire TV Stick Lite mit Fire OS 7.7.1.7 lud und prüfte 0.1.2 die signierte 0.1.3 bei einem echten App-Start. Die Geräteseite zeigte **Update installieren** an.
- Im Emulator liefen die Fernbedienungsaktionen, Spulen und Fortsetzen nach Neustart. Mit einem HTTPS-WebM-Clip wurde das Videobild verifiziert. Bei der verwendeten H.264-Testdatei konnte der Emulator den Decoder nicht starten.

## Umfang dieser Ausgabe

Der Katalogleser wertet HTML, eingebettete Videoelemente und in Skripten enthaltene Videolinks als Daten aus. Die Fernsteuerung von einem zweiten Gerät steht für Fire TV noch aus.
