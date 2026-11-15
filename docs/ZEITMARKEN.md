# Intro, Rückblick und Abspann

## Was der Player heute nutzt

1. Eine Zeitmarke für die konkrete Videodatei ist am verlässlichsten. Die beim Import eingelesene Begleitdatei oder Medienliste kann `intro`, `recap`, `outro` und `post_credits` als `[Start, Ende]` in Sekunden angeben. Eine Videoqualität kann eigene Marken tragen, falls sie einen anderen Schnitt verwendet.
2. Für fehlende Marken fragt KinoTix IntroDB über die IMDb-ID ab. Bei Serien kommen Staffel und Episode dazu. Fehlt die ID, versucht KinoTix für Serien, einen eindeutigen Titeltreffer bei TVmaze zu finden. Die API-Antwort bleibt für die Sitzung im Speicher. Es wird kein kompletter Datenbankexport mit dem Installer ausgeliefert.
3. KinoTix springt über erkannte Intros und Abspannabschnitte automatisch. Rückblicke sind manuell überspringbar. Ein automatischer Sprung lässt sich direkt rückgängig machen. Fällt eine bekannte Abspannszene in einen Abspannabschnitt, wird der Abschnitt davor und danach getrennt geprüft. Bei einer Marke außerhalb der Videolänge oder mit zu geringer Sicherheit spielt das Video weiter.

Enthält Daten von IntroDB (introdb.app), verfügbar unter ODbL. Contains data from IntroDB (introdb.app), available under the ODbL. [API für Zeitmarken](https://api.introdb.app/reference/get-segments/) · [Export und Lizenz](https://api.introdb.app/open-data/)

## Gemessene Abdeckung

Der geöffnete Export vom 14. November 2026, 21:55 UTC, enthält 148.018 Zeitmarken. Für die Tabelle wurden Zeilen ab der für KinoTix nötigen Sicherheit von 0,75 gezählt. Die Zahlen geben die Größe des Angebots an. Für einen Filmkatalog oder eine konkrete private Bibliothek lässt sich daraus keine Trefferquote ableiten.

| Zeitmarke | Serienfolgen | Filme |
| --- | ---: | ---: |
| Intro | 74.974 | 23 |
| Abspann | 63.437 | 902 |
| Rückblick | 8.009 | 0 |
| Abspannszene | 610 | 43 |

Die Serien-Intros verteilen sich auf 2.898 Serien, die Serien-Abspanne auf 2.781. Eine Marke kann für einen anderen Schnitt gedacht sein. Gerade Vorspann, Senderlogo, Rückblick oder ein abweichender Abspann verschieben die Zeit.

[Manifest des täglichen Exports](https://data.introdb.app/latest/manifest.json) · [Datenbeschreibung](https://api.introdb.app/open-data/)

## Eigene Marken importieren

Zu `Beispiel.mp4` kannst du eine Datei `Beispiel.kinotix.json` im selben Ordner ablegen und anschließend das Video hinzufügen. Beim erneuten Import werden die vorhandenen Marken aktualisiert.

```json
{
  "title": "Mein Video",
  "segments": {
    "intro": [3, 47],
    "outro": [3690, 3790],
    "post_credits": [3740, 3755]
  }
}
```

[Beispiel einer Medienliste](../examples/medienliste.json) mit mehreren Folgen und Videoqualitäten. Die Liste über **Medium hinzufügen → Datei oder Liste wählen** importieren. Relative Dateinamen verweisen auf Dateien im Ordner der Liste. Eine freigegebene direkte HTTPS-Quelle kann als `url` statt `file` angegeben werden. `id` identifiziert die Liste auf beiden Rechnern und sollte beim Ändern der Pfade oder Varianten gleich bleiben.

## Nächster Schritt für größere Bibliotheken

- **Jellyfin** liefert typisierte Mediensegmente. Ein Import dieser Segmente für konkrete Dateien hätte Vorrang vor IntroDB. Das Kapitel-Plugin kann vorhandene, passend benannte Kapitel umwandeln. [Jellyfin Media Segments](https://jellyfin.org/docs/general/server/metadata/media-segments/)
- **Wiederkehrende Serien-Intros** lassen sich in einer eigenen Bibliothek über ähnliche Audioabschnitte mehrerer Folgen finden. Intro Skipper für Jellyfin macht das per Audio-Fingerabdruck. Bei Film-Abspannen und unterschiedlichen Schnitten zuerst eine Vorschau oder einen bestätigten Zeitbereich anzeigen. [Jellyfin Intro Skipper](https://github.com/intro-skipper/intro-skipper)
- **Trefferquote praktisch messen.** Für je 20 Filme und Serienfolgen aus dem gewünschten Bestand zählen, ob eine Marke verfügbar ist, zum Schnitt passt und Szenen im Abspann erhält. Dazu vor einem automatischen Sprung bei jeder Stichprobe 10 Sekunden davor und danach ansehen.
