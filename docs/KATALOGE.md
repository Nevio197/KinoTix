# Quellen hinzufügen

Öffne **Hinzufügen**. Füge einen direkten Videolink oder die HTTPS-Adresse einer KinoTix-Katalogdatei ein und wähle **Adresse prüfen**. Eine erkannte Quelle kannst du anschließend in die Mediathek übernehmen. Über **Datei auswählen** lassen sich eine Videodatei, eine JSON-Medienliste oder eine JSON-Katalogdatei importieren.

Wenn eine Webseite keine kompatiblen Katalogdaten anbietet, brauchst du einen direkten Videolink oder eine passende Katalogdatei. Bei Fehlern unterscheidet KinoTix eine fehlende Katalogstruktur von einem Problem beim Zugriff. Gespeicherte Kataloge findest du unter **Einstellungen → Kataloge**.

Die [Beispieldatei](../examples/katalog.json) zeigt das Format für eigene Quellen. Die Basisadresse steht unter `origin`. `listing` und `detail` beschreiben, wo KinoTix Titel und Folgen in der Seite erkennt. Unter `playerHosts` und `mediaHosts` stehen die zugelassenen Hostnamen. Optional liefert `index` eine XML-Sitemap für die Suche. Die Einstellungen werden als Daten gelesen und in einer getrennten Browser-Ansicht ohne Zugriff auf App-Dateien oder Kontodaten ausgewertet.

Wer einen Katalog bereitstellt, kann seine Webseite mit der Katalogdatei verknüpfen. Dann genügt die Webseitenadresse für die Prüfung in KinoTix. Die Katalogdatei wird über HTTPS auf derselben Website bereitgestellt.

```html
<link rel="alternate" type="application/vnd.kinotix.catalog+json" href="/katalog.json">
```

Wenn die Titelseite mehrere verwendbare Videovarianten liefert, werden Quelle und Qualität im Player auswählbar. Bei einer Originaldatei gibt es eine Quelle. Einbauten im Browser können verschlüsselte Formate, DRM oder einen Adapter auf Server-Seite erfordern. KinoTix spielt die direkt verfügbaren Video-URLs ab, die zum Katalog gehören.

Kataloge im Gastmodus bleiben lokal. Mit einem eingerichteten [Supabase-Konto](SUPABASE.md) werden die im Konto ausgewählten Kataloge zwischen Windows und Mac synchronisiert. Lokale Kataloge werden erst nach **Lokale Kataloge ins Konto übernehmen** übertragen.
