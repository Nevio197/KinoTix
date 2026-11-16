# Konten und Synchronisierung mit Supabase

KinoTix speichert Gastkataloge und den Gastverlauf auf dem Gerät. Nach der Google-Anmeldung lädt die App den Katalog und den Wiedergabestand aus dem eigenen Supabase-Konto. Ein Katalog, der im Gastmodus eingerichtet wurde, lässt sich über **Einstellungen → Kataloge → Lokale Kataloge ins Konto übernehmen** kopieren. Beim Abmelden öffnet KinoTix wieder den Gastbereich.

Auf Fire TV liegen An- und Abmeldung, der manuelle Abgleich und die Katalogübernahme unter **Einstellungen → Google-Konto**. Der Fire TV nutzt denselben Dienst und speichert seine eigene Anmeldung verschlüsselt im Android-Keystore. [Fire TV einrichten](FIRE-TV.md)

## Eigenes Projekt einrichten

1. Im [Supabase-Dashboard](https://supabase.com/dashboard) ein Projekt für KinoTix anlegen. Die Projektregion passend zum Nutzerkreis auswählen.
2. Die [Datenbankmigrationen](../supabase/migrations) im Projekt anwenden. Sie erstellen die Sync-Tabelle und beschränken den Zugriff auf die Zeilen des angemeldeten Kontos. Der automatische RLS-Trigger bleibt für Datenbankoperationen aktiv.
3. In Google Cloud eine OAuth-Webanwendung anlegen und die in Supabase **Authentication → Providers → Google** angezeigte Callback-URL als Weiterleitungs-URI eintragen. Google-Client-ID und Client-Secret in Supabase hinterlegen. Der Client fragt nur die Google-Anmeldung an.
4. Unter **Authentication → URL Configuration → Redirect URLs** `http://127.0.0.1:*/kinotix/auth/*` zulassen. Beim Anmelden öffnet die Desktop-App den Standardbrowser. Der lokale Callback übernimmt einmalig den Autorisierungscode, der mit PKCE an diesen Anmeldeversuch gebunden ist.
5. Für einen lokalen Build `app/supabase.json` erstellen. Dort die Projekt-URL und den Publishable Key eintragen. Für GitHub-Builds dieselben beiden Werte als Variablen `SUPABASE_URL` und `SUPABASE_PUBLISHABLE_KEY` hinterlegen.

```json
{
  "url": "https://projekt-id.supabase.co",
  "publishableKey": "sb_publishable_BEISPIEL"
}
```

Der Publishable Key ist für Desktop-Clients vorgesehen. Die Datenbank prüft zusätzlich die Sitzung und den Eigentümer jeder Zeile. Google-Client-Secret, Datenbankpasswort und `service_role` bleiben in der Administrationsumgebung. Die Desktop-App speichert das Supabase-Sitzungstoken verschlüsselt auf dem Gerät.

[Google-Anmeldung einrichten](https://supabase.com/docs/guides/auth/social-sign-in/auth-google) · [Weiterleitungsadressen](https://supabase.com/docs/guides/auth/redirect-urls) · [Zugriff pro Konto](https://supabase.com/docs/guides/database/postgres/row-level-security)

## Was auf dem Server liegt

- Supabase Auth verwaltet die Google-Identität des Nutzers und seine Anmeldung.
- Katalogeinträge enthalten den vom Nutzer importierten Namen, die Adresse und die Leseregeln. Es gibt keinen vorinstallierten Katalog. Katalogadressen dürfen keine Zugangsdaten enthalten.
- Wiedergabestände enthalten Medienkennung, Position und Abschlussstatus. Bei Katalogtiteln wird zusätzlich eine Titelreferenz gespeichert, damit die Folge auf dem zweiten Rechner unter **Weiterschauen** erscheint. Lokale Dateipfade und aufgelöste Videolinks bleiben auf dem Gerät.
- Änderungen werden lokal zwischengespeichert und beim nächsten Sync zusammengeführt. Eine ältere Änderung überschreibt keinen neueren Stand. Beim Entfernen eines Katalogs wird ein Löschvermerk synchronisiert.
- Der Wiedergabestand von **Mein Profil** wird synchronisiert. Weitere Profile und Merklisten bleiben auf dem Gerät. KinoTix hostet keine Videos.
