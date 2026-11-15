# Eigene Kataloge importieren

Im Gastmodus unter **Medium hinzufügen → Katalog hinzufügen → Katalogdatei importieren** eine lokal verfügbare JSON-Katalogdatei auswählen. Der Katalog erscheint auf der Startseite und seine Titel sind über die normale Suche erreichbar. Die separate Desktop-App muss dafür nicht geöffnet sein.

Die [Beispieldatei](../examples/katalog.json) zeigt das Format für eigene Quellen. Die Basisadresse steht unter `origin`. `listing` und `detail` beschreiben, wo KinoTix Titel und Folgen in der Seite erkennt. Unter `playerHosts` und `mediaHosts` stehen die zugelassenen Hostnamen. Optional liefert `index` eine XML-Sitemap für die Suche. Die Einstellungen werden als Daten gelesen und in einer getrennten Browser-Ansicht ohne Zugriff auf App-Dateien oder Kontodaten ausgewertet.

Wenn die Titelseite mehrere verwendbare Videovarianten liefert, werden Quelle und Qualität im Player auswählbar. Bei einer Originaldatei gibt es eine Quelle. Einbauten im Browser können verschlüsselte Formate, DRM oder einen Adapter auf Server-Seite erfordern. KinoTix spielt die direkt verfügbaren Video-URLs ab, die zum Katalog gehören.

Kataloge im Gastmodus bleiben lokal. Mit einem eingerichteten [Supabase-Konto](SUPABASE.md) werden die im Konto ausgewählten Kataloge zwischen Windows und Mac synchronisiert. Lokale Kataloge werden erst nach **Lokale Kataloge ins Konto übernehmen** übertragen.
