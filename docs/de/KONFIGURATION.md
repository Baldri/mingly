# Konfiguration

## API-Schluessel einrichten

Mingly unterstuetzt mehrere KI-Anbieter. Sie benoetigen mindestens einen API-Schluessel, um loszulegen.

### Unterstuetzte Anbieter

| Anbieter | Modelle | API-Schluessel erhalten |
|----------|---------|------------------------|
| **Anthropic** | Claude 4.5, Claude 4 Opus, Sonnet, Haiku | [console.anthropic.com](https://console.anthropic.com/) |
| **OpenAI** | GPT-4o, GPT-4, GPT-3.5 | [platform.openai.com](https://platform.openai.com/) |
| **Google** | Gemini 2.5, Gemini 2.0 | [aistudio.google.com](https://aistudio.google.com/) |
| **Ollama** (lokal) | Llama, Mistral, Phi u.v.m. | Kein Schluessel noetig |

### API-Schluessel hinzufuegen

1. Oeffnen Sie die **Einstellungen** (Zahnrad-Symbol)
2. Gehen Sie zum Tab **Allgemein**
3. Geben Sie Ihren API-Schluessel fuer den gewuenschten Anbieter ein
4. Klicken Sie auf **Speichern**

> **Sicherheit:** Alle API-Schluessel werden im Betriebssystem-Schluesselring gespeichert (macOS Keychain / Windows Credential Vault) — niemals im Klartext.

### Lokale Modelle mit Ollama

Fuer vollstaendig lokale KI ohne Cloud-Anbindung:

1. Installieren Sie [Ollama](https://ollama.com/)
2. Laden Sie ein Modell: `ollama pull llama3.2`
3. Mingly erkennt Ollama automatisch auf `http://localhost:11434`
4. Waehlen Sie "Ollama" als Anbieter im Chat

## Betriebsmodi

Mingly bietet drei Betriebsmodi:

### Standalone (Standard)

Alles laeuft lokal auf Ihrem Computer. Ideal fuer Einzelnutzer.

- Kein Server noetig
- Alle Daten bleiben auf Ihrem Geraet
- Voller Funktionsumfang

### Server

Mingly laeuft als zentraler Server im Netzwerk. Andere Clients koennen sich verbinden.

- REST-API und WebSocket-Schnittstelle
- Mehrere Benutzer gleichzeitig
- Zentrale Verwaltung von API-Schluesseln
- Authentifizierung via API-Key

### Client (Hybrid)

Verbindet sich mit einem bestehenden Mingly-Server.

- Nutzt die API-Schluessel des Servers
- Lokale Oberflaeche, zentrale Verarbeitung
- Ideal fuer Teams

Den Betriebsmodus koennen Sie jederzeit in den **Einstellungen** unter **Netzwerk & KI-Server** aendern.

## Wissensdatenbank (RAG)

Die Wissensdatenbank reichert KI-Antworten mit Ihren eigenen Dokumenten an.

### Einrichten

1. Oeffnen Sie **Einstellungen > Wissensdatenbank**
2. Aktivieren Sie die Wissensdatenbank
3. Waehlen Sie einen Ordner mit Ihren Dokumenten
4. Mingly indiziert die Dateien automatisch

### Unterstuetzte Formate

- PDF, Markdown, Text-Dateien
- Word-Dokumente (.docx)
- HTML-Seiten

### Vorteile

- Antworten basierend auf Ihren Dokumenten
- Quellenangaben in den Antworten
- Ideal fuer Fachthemen und interne Dokumente

## MCP-Tools (Model Context Protocol)

Mingly unterstuetzt MCP-Server fuer erweiterte KI-Faehigkeiten.

### Konfigurieren

1. Oeffnen Sie **Einstellungen > Integrationen**
2. Fuegen Sie einen MCP-Server hinzu (Name + URL)
3. Testen Sie die Verbindung

### Moeglichkeiten

- Dateisystem-Zugriff
- Datenbank-Abfragen
- Web-Suche
- Eigene Tools und Workflows

## Datenschutz

Mingly nimmt Datenschutz ernst:

- **Keine Telemetrie** — keine Daten werden an Dritte gesendet
- **Lokale Speicherung** — alle Gespraeche bleiben auf Ihrem Geraet
- **Sensible-Daten-Erkennung** — warnt vor versehentlichem Senden von Passwoertern oder API-Schluesseln
- **DSGVO-konform** — Datenexport und -loeschung jederzeit moeglich

Weiter: [Nutzung](NUTZUNG.md)
