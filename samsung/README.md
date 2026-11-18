# KinoTix für Samsung TV

Die eigenständige Web-App ist für Samsung-Fernseher ab Tizen 9.0 eingerichtet. Kataloge und Videos lädt der Fernseher selbst über HTTPS. Die Fernbedienung steuert Mediathek, Suche, Merkliste, Profile, Einstellungen und Wiedergabe. Während der Wiedergabe blenden sich Titel und Bedienelemente nach vier Sekunden aus. OK oder eine Pfeiltaste blendet sie ein. Bei Pause bleiben sie sichtbar.

Unter **Einstellungen → Google-Konto** lässt sich die Anmeldung mit dem Handy starten. Verwende dasselbe Google-Konto wie auf den anderen KinoTix-Geräten. Kataloge, portable Videolinks und der Wiedergabestand von **Mein Profil** werden über Supabase synchronisiert. Weitere Profile und ihre Merklisten sowie der Gastverlauf liegen auf dem Fernseher. Die Anmeldung wird im geschützten Tizen-Schlüsselspeicher gesichert. [Konten und Synchronisierung](../docs/SUPABASE.md)

Der Player verwendet die HTML5-Videowiedergabe des Fernsehers. Container, Codec, Auflösung und verfügbare Tonspuren hängen von Modell, Laufzeit und Quelle ab. Eine deutsche Tonspur wird bevorzugt, soweit die Laufzeit ihre Auswahl erlaubt. Manuelle Tonspurauswahl und Bild-in-Bild sind in dieser Ausgabe noch offen. Eine Quelle mit mehreren Varianten ermöglicht Qualitätswechsel. Fortschritt, Staffel und Folge bleiben lokal gespeichert und stehen nach dem Abgleich auf verbundenen Geräten bereit.

## Aus dem Quellcode bauen

Für den Netzwerk-Worker wird das Samsung Emscripten SDK 1.39.4.7 mit aktivierter Fastcomp-Toolchain verwendet. Seine Intel-Werkzeuge benötigen auf Apple Silicon Rosetta. Python 3.9 bis 3.11, Tizen Studio mit TV-Erweiterung und Samsung Certificate Extension werden ebenfalls benötigt. Das SDK und eine aktuelle CA-Datei liegen außerhalb des Repositories. Die Lizenztexte der eingebundenen Laufzeitkomponenten stehen unter `licenses/`. [Samsung WebAssembly SDK](https://developer.samsung.com/smarttv/develop/extension-libraries/webassembly/download.html) · [CA-Datei von curl](https://curl.se/docs/caextract.html)

Die SDK-Konfiguration sowie `EM_CACHE` und `EM_PORTS` müssen zur aktivierten Samsung-Toolchain gehören. `samsung-sdk-cxx17.patch` wird einmalig auf das unveränderte SDK angewendet. Die folgenden Befehle werden im Repository-Root ausgeführt.

```sh
sdk='/Pfad/zum/Samsung-SDK/emsdk'
patch -d "$sdk/fastcomp/emscripten" -p1 < samsung/samsung-sdk-cxx17.patch
EMCC="$sdk/fastcomp/emscripten/emcc.py" PYTHON=python3 \
  samsung/build-transport.sh '/Pfad/zur/cacert.pem'
python3 samsung/package-widget.py --unsigned \
  dist/samsung/KinoTix-0.2.2-Samsung-unsigned.wgt
```

`package-widget.py` übernimmt aus `app/supabase.json` ausschließlich Projektadresse und öffentlichen Publishable Key. `KINOTIX_SAMSUNG_ACCOUNT_CONFIG` kann eine andere Konfigurationsdatei auswählen. Ohne Konfiguration ist der Gastmodus verfügbar. Der Netzwerk-Worker entsteht unter `samsung/build/transport`. [Transport-Schnittstelle](TRANSPORT.md)

Erstelle im Samsung Certificate Manager ein Profil mit Autoren- und Distributionszertifikat für das Testgerät. Signiere Updates mit demselben Autorenzertifikat.

```sh
python3 samsung/package-widget.py --profile 'Mein-TV-Profil' \
  --tizen '/Pfad/zu/tizen-studio/tools/ide/bin/tizen' \
  dist/samsung/KinoTix-0.2.2-Samsung.wgt
tizen install -n KinoTix-0.2.2-Samsung.wgt -t '<TV-Ziel>' -- dist/samsung
```

Der Fernseher muss über den Entwicklermodus als autorisiertes Ziel verbunden sein. Für das Upgrade der bisherigen KinoGER-Installation bleiben Paket- und App-ID erhalten. Der Anzeigename ist KinoTix, die Versionsnummer ist 0.2.2. [Samsung Zertifikate](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/creating-certificates.html) · [Samsung TV als Testgerät](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html)

## Updates

Ein neues WGT aus GitHub wird bei dieser Entwicklerinstallation über einen verbundenen Rechner installiert. Die App besitzt keine öffentliche Berechtigung, ihr eigenes WGT zu installieren. Ein Download oder eine Versionsprüfung allein führt deshalb noch keine Installation durch. Für Updates unmittelbar am Fernseher bietet Samsung seinen Store oder ein genehmigtes Beta-Programm. [Samsung Package API](https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/package-api.html) · [Samsung Beta-FAQ](https://developer.samsung.com/tv-seller-office/faq/beta-test.html)
