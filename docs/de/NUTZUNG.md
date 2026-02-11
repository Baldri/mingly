# Nutzung

## Chat starten

1. Klicken Sie auf **Neuer Chat** (Plus-Symbol in der Seitenleiste)
2. Waehlen Sie einen Anbieter und ein Modell
3. Tippen Sie Ihre Nachricht und druecken Sie **Enter**

Die Antwort wird in Echtzeit gestreamt.

## Anbieter wechseln

Sie koennen den KI-Anbieter jederzeit wechseln:

- **Im Chat**: Klicken Sie auf den Anbieter-Namen oben im Chat-Fenster
- **Neuer Chat**: Waehlen Sie beim Erstellen einen anderen Anbieter
- **Standard-Anbieter**: In den Einstellungen unter *Allgemein*

## Konversationen verwalten

### Seitenleiste

Die Seitenleiste zeigt alle Gespraeche chronologisch:

- Klicken Sie auf ein Gespraech, um es zu oeffnen
- Neues Gespraech starten mit dem Plus-Symbol
- Gespraeche werden automatisch gespeichert

### Titel

Gespraeche erhalten automatisch einen Titel basierend auf dem Inhalt. Sie koennen den Titel jederzeit aendern.

## Wissensdatenbank nutzen

Wenn die Wissensdatenbank aktiviert ist:

1. Stellen Sie Fragen zu Ihren Dokumenten
2. Mingly durchsucht automatisch relevante Inhalte
3. Die Antwort enthaelt Quellenangaben

**Beispiel:**
> "Was steht in unserem Projektplan fuer Q2?"

Mingly findet relevante Abschnitte in Ihren indexierten Dokumenten und gibt eine fundierte Antwort.

## Kosten im Blick

Mingly verfolgt automatisch Ihre API-Nutzung:

- **Analytics-Tab** in den Einstellungen zeigt Kosten pro Anbieter
- **Token-Zaehler** fuer jede Nachricht
- **Budget-Einstellungen** fuer monatliche Limits

### Budget einrichten

1. Oeffnen Sie **Einstellungen > Budget**
2. Setzen Sie ein monatliches Limit
3. Mingly warnt Sie, bevor das Limit erreicht wird

## Tastenkuerzel

| Aktion | Tastenkuerzel |
|--------|--------------|
| Nachricht senden | `Enter` |
| Neue Zeile | `Shift + Enter` |
| Neuer Chat | `Ctrl/Cmd + N` |
| Einstellungen | `Ctrl/Cmd + ,` |

## Tipps fuer bessere Ergebnisse

### Klare Anweisungen

Je praeziser Ihre Frage, desto besser die Antwort:

- **Gut:** "Erklaere die Vorteile von TypeScript gegenueber JavaScript fuer grosse Projekte"
- **Besser:** "Liste 5 konkrete Vorteile von TypeScript gegenueber JavaScript fuer ein Team von 10 Entwicklern"

### Kontext nutzen

Mingly merkt sich den Gespraechsverlauf. Sie koennen auf vorherige Nachrichten Bezug nehmen:

> "Erklaere den dritten Punkt genauer"

### Modell-Auswahl

- **Schnelle Fragen**: Haiku / GPT-3.5 (guenstig, schnell)
- **Komplexe Aufgaben**: Claude Opus / GPT-4o (praezise, ausfuehrlich)
- **Lokale Nutzung**: Ollama (kostenlos, keine Cloud)

## Fehlerbehebung

### "Kein API-Schluessel konfiguriert"

Gehen Sie zu *Einstellungen > Allgemein* und fuegen Sie mindestens einen API-Schluessel hinzu.

### "Verbindung zum Anbieter fehlgeschlagen"

- Pruefen Sie Ihre Internetverbindung
- Stellen Sie sicher, dass der API-Schluessel gueltig ist
- Manche Anbieter haben regionale Beschraenkungen

### "Modell nicht verfuegbar"

- Pruefen Sie, ob Ihr API-Plan das Modell unterstuetzt
- Einige Modelle erfordern gesonderten Zugang

Weiter: [Haeufige Fragen](FAQ.md)
