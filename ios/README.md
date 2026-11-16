# KinoTix für iPhone

Öffne `KinoTix.xcodeproj` in Xcode. Das Schema **KinoTix** baut für iOS 17 oder neuer. Für ein echtes iPhone wählst du in Xcode dein Entwicklungsteam und das verbundene Gerät aus.

Der Build liest die Projektadresse und den öffentlichen Supabase-Schlüssel aus `app/supabase.json`. Über `KINOTIX_IOS_ACCOUNT_CONFIG` lässt sich eine gleich strukturierte Datei angeben. Ohne diese Datei funktioniert der lokale Gastmodus. Verwende hier ausschließlich den Publishable Key.

Unter **Einstellungen → Mit Google anmelden** öffnet sich die Google-Anmeldung im Browser. Kehre anschließend zu KinoTix zurück und bestätige das angezeigte Konto. Der Abgleich umfasst Kataloge, portable Videolinks und den Wiedergabestand des Hauptprofils.

Ein per Xcode installiertes Entwicklungsprofil läuft bei einem Personal Team nach sieben Tagen ab. Für TestFlight braucht das Entwicklungsteam Zugriff auf das Apple Developer Program und App Store Connect. [Apple-Kontotypen](https://developer.apple.com/help/account/basics/about-your-developer-account) · [TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
