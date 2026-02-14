# Nutzung

## Chat starten

1. Klicken Sie auf **Neuer Chat** (Plus-Symbol in der Seitenleiste)
2. Waehlen Sie einen Anbieter und ein Modell (Cloud-Anbieter, lokale Modelle oder Gemma Auto-Routing)
3. Tippen Sie Ihre Nachricht und druecken Sie **Enter**

Die Antwort wird in Echtzeit gestreamt.

### Lokale Modell-Erkennung

Beim Oeffnen des Neuer-Chat-Dialogs scannt Mingly automatisch nach lokalen LLM-Servern:

- **Ollama** (Port 11434)
- **LM Studio** (Port 1234)
- **vLLM** (Port 8000)
- **LocalAI** (Port 8080)
- **Text Gen WebUI** (Port 5000)
- **llama.cpp** (Port 8081)

Erkannte Modelle erscheinen unter der Gruppe **Lokale Modelle**.

### Gemma Auto-Routing

Waehlen Sie **Gemma Auto-Routing** als Anbieter, damit Gemma 2B Ihre Anfrage analysiert und automatisch an das beste Modell weiterleitet.

## Modell-Anzeige

Der Chat-Header zeigt das aktive Modell der aktuellen Konversation:

```
● anthropic / claude-3-5-sonnet
```

## Modell-Vergleich

Vergleichen Sie, wie verschiedene Modelle auf denselben Prompt reagieren:

1. Klicken Sie auf das **Spalten-Symbol** (⫼) im Chat-Header
2. Fuegen Sie 2–3 Modelle hinzu (z.B. Claude, GPT-4, Gemini)
3. Geben Sie einen Prompt ein und klicken Sie **Compare**
4. Sehen Sie die Antworten nebeneinander mit Latenz, Token-Anzahl und Kosten
5. Klicken Sie **Mark as Winner** bei der besten Antwort

## Routing-Modus

Wechseln Sie zwischen manuellem und automatischem Routing im Chat-Header:

- **Manuell** (User-Symbol) — Sie waehlen das Modell fuer jede Konversation
- **Automatisch** (Sparkles-Symbol) — Gemma 2B analysiert jede Anfrage und waehlt das beste Modell

## Anbieter wechseln

Sie koennen den KI-Anbieter jederzeit wechseln:

- **Im Chat**: Die Modell-Anzeige zeigt den aktuellen Anbieter/Modell
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

## Service Discovery

Mingly kann automatisch RAG- und MCP-Server erkennen:

1. Gehen Sie zu **Einstellungen > RAG** oder **Einstellungen > MCP Server**
2. Klicken Sie **Discover**
3. Mingly scannt lokale Ports, Ihr LAN-Subnetz und konfigurierte Cloud-Endpunkte
4. Erkannte Dienste erscheinen mit Status (online/offline) und Standort (lokal/Netzwerk/Cloud)

### Eigener RAG-Server-Name

Standardmaessig heisst der externe RAG-Server "RAG-Wissen". So aendern Sie den Namen:

1. Gehen Sie zu **Einstellungen > RAG** und klicken Sie **Configure** bei der Server-Karte
2. Aendern Sie das Feld **Display Name**
3. Der Name wird ueberall in der App aktualisiert

## Wissensdatenbank nutzen

Wenn die Wissensdatenbank aktiviert ist:

1. Stellen Sie Fragen zu Ihren Dokumenten
2. Mingly durchsucht automatisch relevante Inhalte
3. Die Antwort enthaelt Quellenangaben

**Beispiel:**
> "Was steht in unserem Projektplan fuer Q2?"

Mingly findet relevante Abschnitte in Ihren indexierten Dokumenten und gibt eine fundierte Antwort.

## Auto-Updates

Mingly prueft automatisch auf Updates:

- **Pro+ Tier**: Updates werden im Hintergrund heruntergeladen und beim Beenden/Neustarten installiert. Klicken Sie "Restart & Install" in den Einstellungen fuer sofortige Aktualisierung.
- **Free Tier**: Sie werden ueber neue Versionen benachrichtigt. Klicken Sie "Download Manually" fuer den Download von GitHub.

Manuell pruefen: **Einstellungen > Allgemein > Check for Updates**

## Abo & Lizenz

Verwalten Sie Ihr Abonnement unter **Einstellungen > Allgemein**:

- Aktuelles Tier anzeigen (Free/Pro/Team/Enterprise)
- Lizenzschluessel eingeben um einen bezahlten Plan zu aktivieren
- Upgrade ueber den "Upgrade"-Button (verlinkt zu mingly.ch)
- Die Seitenleiste zeigt ebenfalls das aktuelle Tier mit Upgrade-Shortcut

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
