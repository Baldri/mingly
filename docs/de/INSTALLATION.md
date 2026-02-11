# Installation

## Desktop-App (empfohlen)

### macOS

1. Laden Sie die neueste `.dmg`-Datei von der [Releases-Seite](https://github.com/mingly-app/mingly/releases) herunter
2. Oeffnen Sie die `.dmg`-Datei
3. Ziehen Sie **Mingly** in den **Programme**-Ordner
4. Starten Sie Mingly aus dem Launchpad oder Finder

> **Hinweis:** Beim ersten Start fragt macOS moeglicherweise nach einer Sicherheitsbestaetigung. Gehen Sie zu *Systemeinstellungen > Datenschutz & Sicherheit* und klicken Sie auf *Trotzdem oeffnen*.

### Windows

1. Laden Sie die neueste `.exe`-Datei von der [Releases-Seite](https://github.com/mingly-app/mingly/releases) herunter
2. Fuehren Sie den Installer aus
3. Waehlen Sie den Installationsordner (Standard: `C:\Program Files\Mingly`)
4. Mingly wird automatisch eine Desktop-Verknuepfung und einen Startmenue-Eintrag erstellen
5. Starten Sie Mingly ueber die Verknuepfung

## Aus dem Quellcode

Voraussetzungen:
- Node.js 18 oder neuer
- npm 9 oder neuer

```bash
git clone https://github.com/mingly-app/mingly.git
cd mingly
npm install
npm run dev
```

Die App startet automatisch im Entwicklungsmodus.

### Produktion-Build erstellen

```bash
npm run build
npm run dist
```

Der Installer wird im `release/`-Ordner erstellt.

## Docker (Server-Modus)

Fuer den Einsatz als Server ohne Desktop-Oberflaeche:

```bash
git clone https://github.com/mingly-app/mingly.git
cd mingly
docker compose up -d
```

Drei Dienste werden gestartet:
- **Mingly Server** auf Port 3939
- **Qdrant** (Vektordatenbank) auf Port 6333
- **RAG Server** (Embedding) auf Port 8001

Pruefen Sie den Status:

```bash
curl http://localhost:3939/health
```

## Systemanforderungen

| Komponente | Minimum | Empfohlen |
|-----------|---------|-----------|
| Betriebssystem | macOS 12+ / Windows 10+ | macOS 14+ / Windows 11 |
| RAM | 4 GB | 8 GB |
| Speicherplatz | 500 MB | 2 GB (mit lokalen Modellen) |
| Node.js | 18.x | 20.x (nur fuer Quellcode-Installation) |

## Naechste Schritte

Nach der Installation startet der **Einrichtungsassistent** automatisch. Er fuehrt Sie durch:

1. Sprachauswahl (Deutsch/Englisch)
2. API-Schluessel Konfiguration
3. Betriebsmodus-Auswahl
4. Optionale Wissensdatenbank-Einrichtung

Weiter: [Konfiguration](KONFIGURATION.md)
