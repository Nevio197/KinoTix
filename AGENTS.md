# KinoTix

Diese Desktop-Ausgabe verwendet eine eigene App-ID und eigene App-Daten. Gemeinsamer Player-Code für Windows und macOS liegt in `app/`, die Build-Konfiguration in `windows/`.

Für die nächste Arbeit am Mac den [MacBook-Auftrag](docs/MAC-AUFTRAG.md) öffnen. Er enthält die offenen Tests für Player, Gerätesync, Signierung und Updates. Datenquellen und gemessene Abdeckung der [Zeitmarken](docs/ZEITMARKEN.md) liegen im selben Repo.

- Teste Änderungen am Player auf Windows und macOS und halte getrennt fest, was gebaut, getestet und veröffentlicht wurde.
- Der Gastmodus speichert lokal. Google-Anmeldung über Supabase synchronisiert Kataloge, übertragbare Videolinks und Wiedergabestand des eigenen Kontos. [Projektaufbau und Zugriff auf Kontodaten](docs/SUPABASE.md)
- Das Repo enthält nur ein neutrales Katalog-Beispiel. Persönliche Katalogdateien werden lokal ausgewählt oder privat mit dem eigenen Konto synchronisiert.
- Verwende bei Release-Tests das eigene Repository und dessen Update-Artefakte. Anleitungen und Konfiguration stehen in `README.md`.
