# Mingly v0.7.0 Website + Release — Design Spec

## Ziel

Website (mingly.ch) auf v0.7.0 "Swiss AI Privacy" Release aktualisieren.
Alle Inhalte muessen das Privacy-First Messaging widerspiegeln.

## Scope

### 1. Website Content Update (~/projects/mingly-website/)

**i18n Dateien (DE + EN synchron):**

#### Hero
- **Titel:** "Swiss AI Privacy — AI nutzen, Daten behalten." / "Swiss AI Privacy — Use AI, Keep Your Data."
- **Subtitle:** Multi-LLM Desktop Client mit automatischer On-Device PII-Protection.
- **Badge:** "Swiss AI Privacy · On-Device · nDSG/GDPR"
- **Tags:** Behalten (Keychain, Offline, Electron) + "On-Device NER" hinzufuegen

#### Features (Neue Reihenfolge)
1. Swiss AI Privacy (On-Device PII Detection, 4 Modi) — Tag: Core/Security
2. On-Device NER (piiranha-v1, 400M, <50ms) — Tag: Core
3. Smart LLM Routing — Tag: Smart
4. Document Context — Tag: Free
5. Knowledge Base (RAG) — Tag: Pro
6. Tool Integration (MCP) — Tag: Extensible
7. Context Engineering — Tag: Smart
8. Multi-Backend Routing — Tag: Network
9. Cost Tracking — Tag: Smart
10. Maximum Security (Keychain, Circuit Breaker, Canary) — Tag: Security

#### Pricing (Privacy-Messaging pro Tier)
- **Free:** "Volle Privacy-Protection inklusive" — Shield-Mode, On-Device NER, 3 conv/day Cloud
- **Pro:** + "4 Privacy-Modi" (Shield/Vault/Transparent/Local Only), Routing-SLM
- **Team:** + "Privacy-Audit-Log", Team-weite Privacy-Policies
- **Enterprise:** + "nDSG/DSGVO Compliance-Dashboard", Custom PII-Regeln
- Preise bleiben: CHF 0 / 24 / 69 / auf Anfrage

#### Use Cases (Privacy-First, neue Reihenfolge)
1. **Arztpraxis (Hausaerztin)** — Arztbriefe + Literatur ohne Cloud. Patientengeheimnis.
2. **Steuerberatung (Zug)** — Mandantenanfragen 3x schneller. Mandantengeheimnis.
3. **Anwaltskanzlei (NEU)** — Vertragsentwuerfe, Recherche. Anwaltsgeheimnis.
4. **Marketing-Agentur (Zuerich)** — Multi-Client Privacy, isolierte RAG pro Kunde.

#### Version + Downloads
- Alle Referenzen v0.5.1 → v0.7.0
- Download-URLs: `github.com/Baldri/mingly/releases/download/v0.7.0/`
- downloads.ts: Version-String + URLs aktualisieren

### 2. Mingly App (~/mingly/)

#### Version Bump
- package.json: 0.5.1 → 0.7.0
- CHANGELOG.md: v0.7.0 Entry (Swiss AI Privacy, 3-Layer NER, Red-Team, Dedup Fix)

#### MEDIUM Backlog (Preprocessor-Erweiterungen)
- HTML-Entity Decoding im text-preprocessor.ts
- Fullwidth-Normalisierung im text-preprocessor.ts
- Beide mit Tests

### 3. Release Build + Distribution
- `npm run dist:mac` (nach allen Code-Aenderungen)
- GitHub Release v0.7.0 erstellen
- Vercel Deploy der Website (auto via push)

## Nicht im Scope
- Neue Seiten/Routes auf der Website
- Redesign der visuellen Gestaltung
- Electron-Upgrade (Phase 8)
- ORG-Detection (spaeter)
- CI-Integration der Red-Team Tests

## Abhaengigkeiten
- Mingly App: Node v24.13.1, Vitest, electron-builder
- Website: Vite + React + Tailwind, Vercel fra1
- GitHub: Baldri/mingly + Baldri/mingly-website
