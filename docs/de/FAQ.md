# Haeufige Fragen (FAQ)

## Allgemein

### Was ist Mingly?

Mingly ist eine Desktop-Anwendung, mit der Sie verschiedene KI-Modelle (Claude, GPT, Gemini, Llama u.a.) in einer einzigen Oberflaeche nutzen koennen. Sie behalten die volle Kontrolle ueber Ihre Daten und API-Schluessel.

### Ist Mingly kostenlos?

Ja, Mingly selbst ist kostenlos und Open Source. Die KI-Anbieter (Anthropic, OpenAI, Google) berechnen jedoch Gebuehren fuer die API-Nutzung. Mit Ollama koennen Sie lokale Modelle voellig kostenlos nutzen.

### Welche KI-Modelle werden unterstuetzt?

- **Anthropic**: Claude 4.5 Sonnet, Claude 4 Opus, Haiku
- **OpenAI**: GPT-4o, GPT-4 Turbo, GPT-3.5 Turbo
- **Google**: Gemini 2.5 Pro, Gemini 2.0 Flash
- **Ollama**: Alle lokal verfuegbaren Modelle (Llama, Mistral, Phi, etc.)

## Kosten

### Was kostet die Nutzung?

Die Kosten haengen vom gewaehlten KI-Anbieter und Modell ab. Richtwerte pro 1 Million Tokens:

| Modell | Eingabe | Ausgabe |
|--------|---------|---------|
| Claude Haiku | ~0.25 USD | ~1.25 USD |
| Claude Sonnet | ~3.00 USD | ~15.00 USD |
| GPT-4o | ~2.50 USD | ~10.00 USD |
| GPT-3.5 Turbo | ~0.50 USD | ~1.50 USD |
| Ollama (lokal) | Kostenlos | Kostenlos |

> **Tipp:** Nutzen Sie die Budget-Funktion in den Einstellungen, um Ihre monatlichen Kosten zu begrenzen.

### Kann ich die Kosten begrenzen?

Ja. Unter *Einstellungen > Budget* koennen Sie monatliche Limits setzen. Mingly warnt Sie, bevor das Limit erreicht wird.

## Datenschutz

### Wo werden meine Daten gespeichert?

Alle Gespraeche, Einstellungen und die Wissensdatenbank werden ausschliesslich auf Ihrem Computer gespeichert. Mingly sendet keine Daten an eigene Server.

### Werden meine Chats an die KI-Anbieter gesendet?

Ja, Ihre Nachrichten werden an den jeweiligen KI-Anbieter (z.B. Anthropic, OpenAI) gesendet, um eine Antwort zu erhalten. Das ist fuer die Funktionsweise erforderlich. Ausnahme: Mit Ollama bleibt alles lokal.

### Ist Mingly DSGVO-konform?

Mingly bietet Funktionen fuer DSGVO-Konformitaet:

- **Datenexport**: Alle Ihre Daten als Datei exportieren
- **Datenloeschung**: Alle Ihre Daten vollstaendig entfernen
- **Keine Telemetrie**: Keine Nutzungsdaten werden gesammelt
- **Sensible-Daten-Erkennung**: Warnt vor versehentlichem Senden von Passwoertern

### Wie sicher sind meine API-Schluessel?

API-Schluessel werden im Betriebssystem-Schluesselring gespeichert:
- **macOS**: Apple Keychain
- **Windows**: Windows Credential Vault

Sie werden niemals im Klartext auf der Festplatte gespeichert.

## Lokale KI (Ollama)

### Wie nutze ich KI ohne Cloud?

1. Installieren Sie [Ollama](https://ollama.com/)
2. Laden Sie ein Modell herunter: `ollama pull llama3.2`
3. Starten Sie Ollama
4. In Mingly "Ollama" als Anbieter waehlen

Alle Verarbeitung geschieht lokal auf Ihrem Computer — keine Daten verlassen Ihr Geraet.

### Welche Hardware brauche ich fuer lokale Modelle?

- **Minimum**: 8 GB RAM (fuer kleine Modelle wie Phi)
- **Empfohlen**: 16 GB RAM, Apple M1/M2/M3 oder dedizierte GPU
- **Grosse Modelle** (70B): 32+ GB RAM

## Server-Modus

### Wann brauche ich den Server-Modus?

Der Server-Modus eignet sich fuer:

- **Teams**: Mehrere Personen nutzen gemeinsam eine Mingly-Instanz
- **Zentralisierung**: API-Schluessel zentral verwalten
- **Integration**: Andere Anwendungen ueber die REST-API anbinden
- **Headless**: Betrieb auf einem Server ohne Desktop-Oberflaeche

### Wie richte ich den Server ein?

Die einfachste Methode ist Docker:

```bash
docker compose up -d
```

Oder manuell:

```bash
npm run build:server
npm run start:server
```

Der Server ist dann auf `http://localhost:3939` erreichbar.

### Kann ich den Server absichern?

Ja, mit API-Key-Authentifizierung:

1. Setzen Sie `MINGLY_REQUIRE_AUTH=true`
2. Definieren Sie `MINGLY_API_KEY=IhrGeheimesPasswort`
3. Alle Anfragen muessen den Header `Authorization: Bearer IhrGeheimesPasswort` enthalten

## Probleme

### Die App startet nicht

1. Stellen Sie sicher, dass die Systemanforderungen erfuellt sind
2. Versuchen Sie, die App neu zu installieren
3. Bei Quellcode-Installation: `rm -rf node_modules && npm install`

### Antworten sind langsam

- Pruefen Sie Ihre Internetverbindung
- Waehlen Sie ein schnelleres Modell (z.B. Haiku statt Opus)
- Bei Ollama: Stellen Sie sicher, dass genuegend RAM verfuegbar ist

### Die Wissensdatenbank findet nichts

- Pruefen Sie, ob der Ordner-Pfad korrekt ist
- Stellen Sie sicher, dass die Dateien in einem unterstuetzten Format vorliegen
- Warten Sie, bis die Indizierung abgeschlossen ist

---

Zurueck zu: [Installation](INSTALLATION.md) | [Konfiguration](KONFIGURATION.md) | [Nutzung](NUTZUNG.md)
