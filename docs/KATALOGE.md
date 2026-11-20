# Quellen hinzufügen

Öffne **Hinzufügen**. Füge einen direkten Videolink oder die HTTPS-Adresse einer KinoTix-Katalogdatei ein und wähle **Adresse prüfen**. Eine erkannte Quelle kannst du anschließend in die Mediathek übernehmen. Über **Datei auswählen** lassen sich eine Videodatei, eine JSON-Medienliste oder eine JSON-Katalogdatei importieren.

Für einen Katalog ohne Datei gib unter **Hinzufügen** die Domain ein und wähle **Domain als Katalog hinzufügen**. Das geht auch unter **Einstellungen → Kataloge**. Eine bereits auf diesem Gerät eingerichtete Domain behält ihre Regeln für Titel, Suche und Wiedergabe. Bei neuen Domains verwendet KinoTix einen von der Seite verknüpften Katalog oder sucht nach Titelkarten und Videos auf derselben Domain. Die Domain bleibt auch bei einem Verbindungsfehler gespeichert. Zum Anzeigen der Titel muss die Seite erreichbar sein und passende Daten liefern.

Unter **Alle Titel** kannst du einen Katalog mit Suchindex seitenweise durchblättern. Die Suche zeigt bereits geladene Titel sofort und ergänzt Treffer aus dem Index. Fehlt einer sichtbaren Kachel das Cover, prüft KinoTix das Vorschaubild auf der Titelseite. Beim nächsten Start stehen die zuletzt geladenen Katalogkacheln bereits auf dem Gerät bereit. Das Datum über den Kacheln zeigt den Stand der gespeicherten Vorschau.

Verlangt der Anbieter eine Browserprüfung, öffnet **Quellseite in KinoTix ansehen** seine Website in einem eigenen KinoTix-Fenster. Dort kannst du eine geöffnete Titelseite über **Merkliste → Aktuellen Titel merken** speichern. Beim Anschauen auf der Website steuert der Anbieter die Wiedergabe. KinoTix speichert die Zeitposition beim Abspielen im eigenen Player.

Unter **Einstellungen → Verbindung** ist **Automatisch** die Voreinstellung. KinoTix beginnt mit dem System-DNS. Scheitert die Namensauflösung, versucht die App dieselbe Adresse erneut mit verschlüsseltem DNS über Cloudflare. Nach einem Neustart beginnt die Automatik wieder mit dem System-DNS. Die HTTPS-Zertifikatsprüfung bleibt aktiv.

Du kannst auch **System-DNS** oder **Immer sicheres DNS** auswählen. Diese Einstellung bleibt auf dem Gerät und gilt ab dem nächsten Start der App. Frühere manuelle Einstellungen werden übernommen.

Die [Beispieldatei](../examples/katalog.json) zeigt das Format für eigene Quellen. Die Basisadresse steht unter `origin`. `listing` und `detail` beschreiben, wo KinoTix Titel und Folgen in der Seite erkennt. Unter `playerHosts` und `mediaHosts` stehen die zugelassenen Hostnamen. Optional liefert `index` eine XML-Sitemap für die Suche. Die Einstellungen werden als Daten gelesen und in einer getrennten Browser-Ansicht ohne Zugriff auf App-Dateien oder Kontodaten ausgewertet.

Wer einen Katalog bereitstellt, kann seine Webseite mit der Katalogdatei verknüpfen. Dann genügt die Webseitenadresse für die Prüfung in KinoTix. Die Katalogdatei wird über HTTPS auf derselben Website bereitgestellt.

```html
<link rel="alternate" type="application/vnd.kinotix.catalog+json" href="/katalog.json">
```

Wenn die Titelseite mehrere verwendbare Videovarianten liefert, werden Quelle und Qualität im Player auswählbar. Bei einer Originaldatei gibt es eine Quelle. Einbauten im Browser können verschlüsselte Formate, DRM oder einen Adapter auf Server-Seite erfordern. KinoTix spielt die direkt verfügbaren Video-URLs ab, die zum Katalog gehören.

Kataloge im Gastmodus bleiben lokal. Mit einem eingerichteten [Supabase-Konto](SUPABASE.md) werden die im Konto ausgewählten Kataloge zwischen Windows und Mac synchronisiert. Lokale Kataloge werden erst nach **Lokale Kataloge ins Konto übernehmen** übertragen.
