# Samsung HTTPS-Transport

`window.KinoTransport.request(url, options)` liefert ein Promise mit `{status, body, url}`. `body` ist UTF-8-Text. HTTP-Fehlerstatus bleiben im Ergebnis verfügbar. `KinoTransport.text(url, options)` liefert den Text und lehnt HTTP-Status außerhalb 200–299 ab.

GET unterstützt zusätzlich `responseType: 'bytes'`. Die Antwort enthält dann ein `Uint8Array`, dessen Speicher vom Worker übertragen wird. Größe, HTTPS-Hostliste, Zertifikatsprüfung und Weiterleitungsgrenzen gelten auch für diese Antworten. Der Aufrufer prüft Dateiformat und MIME-Typ vor der Anzeige. `text()` verwendet immer Textantworten.

Die Optionen enthalten `allowedHosts` mit den exakten HTTPS-Hostnamen aus einem validierten Katalog oder dem Supabase-Projekt. `method` ist `GET` oder `POST`, `headers` enthält Textwerte und `body` den POST-Text. `maxBytes` begrenzt die dekodierte Antwort, standardmäßig auf 2 MiB und höchstens 16 MiB. POST-Daten sind auf 2 MiB begrenzt. Host-, Cookie- und Verbindungsheader werden abgelehnt.

`dns` ist `automatic`, `system` oder `secure`. `false` entspricht `system`. Automatisch folgt auf einen fehlgeschlagenen Verbindungs- oder TLS-Aufbau eine verschlüsselte DNS-Abfrage. Das SDK verbindet zur ermittelten IPv4-Adresse und prüft das Zertifikat weiterhin gegen den ursprünglichen HTTPS-Hostnamen. Die Anfrage wird im Worker mit dem Samsung-Socket-Backend ausgeführt.

GET folgt höchstens fünf Weiterleitungen innerhalb der übergebenen Hostliste. Bei einem Wechsel des Ursprungs bleiben nur Accept und Range erhalten. `redirect: 'error'` lehnt Weiterleitungen ab. POST-Weiterleitungen werden abgelehnt. Kontozugriffe verwenden `dns: false` und `redirect: 'error'`.

`build-transport.sh` verwendet das Samsung Emscripten SDK und eine CA-Datei außerhalb des Repositories. `EMCC`, `EM_CONFIG`, `EM_CACHE`, `EM_PORTS` und `PYTHON` wählen die vorhandene lokale Toolchain. Die generierten Dateien stehen unter `build/transport`. `package-widget.py` nimmt diese Dateien, die explizit gelisteten Widget-Dateien und die Lizenztexte in das WGT auf.

Die öffentliche Supabase-Konfiguration wird aus `app/supabase.json` übernommen. `KINOTIX_SAMSUNG_ACCOUNT_CONFIG` kann eine andere Datei angeben. Im Paket stehen ausschließlich Projektadresse und Publishable Key. Ohne diese Datei wird `{}` für den Gastmodus erzeugt.
