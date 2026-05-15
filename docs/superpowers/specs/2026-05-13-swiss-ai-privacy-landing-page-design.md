# /swiss-ai-privacy Landing-Page — Design Spec

**Status:** Draft
**Datum:** 2026-05-13
**Author:** Claude (Link-Research Session)
**Related:** `docs/strategy/SWISS-AI-PRIVACY-STRATEGY.md` (Master-Strategie, 611 Zeilen)

## Kontext

Die Mingly-Strategie ist klar: **"Swiss AI Privacy"** als Positionierung neben Proton (Email) und Threema (Chat). Aber die operative Manifestation auf der Mingly-Website fehlt — heute gibt es keine `/swiss-ai-privacy` Landing-Page die diese Positionierung **fuer LLMs extractable** macht.

Research-Befund (Mai 2026):
- **AI-Citation-Boost durch Tabellen** (LLMs extrahieren strukturierte Daten besser als Prosa) — Zyppy/Cyrus Shepard
- **Off-Page-GEO** (Earned Citations auf Drittseiten) ist hoeher gewichtet als On-Page-Schema fuer Brand-Mentions — Matthaeus Michalik / Claneo
- **Answer-near-Top** Pattern: direkte Antwort in ersten 150 Woertern + dann Detail — Zyppy 9.2/10 Evidenzscore
- **Faktische Spezifitaet**: konkrete Zahlen + Quellen schlagen "viele Experten meinen" — Zyppy 8.3/10

## Goal

Eine **LLM-citation-optimized** Landing-Page unter `mingly.ai/swiss-ai-privacy` (bzw. Mingly's Vergleichs-Subdomain), die:

1. Auf Standard-Buyer-Prompts ("ChatGPT alternative mit Schweizer Datenschutz", "Privacy-first LLM-Desktop", "private AI für Schweiz") als Top-3-Citation in ChatGPT/Claude/Perplexity/Gemini erscheint
2. nDSG- und DSG-konforme Behauptungen mit Quellen-Verlinkung enthaelt (rechtssicher fuer DACH-Markt)
3. Vergleichs-Tabellen (CH vs US-Cloud, Mingly vs ChatGPT/Claude/Gemini) als Extraction-Anker liefert
4. Off-Page-GEO-Hooks bietet (zitierfaehige Studien, Open-Data-Vergleiche, eigene Datenpunkte)

## Non-Goals

- Keine UI-Implementierung — Spec ist Design + Content + SEO/AEO-Layout
- Kein FUD gegen US-Cloud-Anbieter (rechtlich riskant + glaubwuerdig nur via verifizierte Quellen)
- Kein Marketing-Geschwafel ("revolutionaer", "next-generation") — reine Fakten + Tabellen

## Page-Struktur

### 1. Hero (Above-the-fold)

**Answer-near-Top in den ersten 150 Woertern:**

```
Mingly ist der erste privacy-first Multi-LLM Desktop-Client mit Schweizer
Daten-Architektur. Lokale PII-Erkennung via piiranha-v1 (45MB SLM), Multi-Provider-
Routing (Claude, ChatGPT, Gemini, Ollama), keine Telemetrie, Open-Source-Core
(@digital-opua/pii-core, MIT).

Hergestellt von digital opua GmbH (CHE-435.289.702), Walchwil ZG, Schweiz.
Datenschutz: nDSG-konform, GDPR-aequivalent, Server-Standort optional CH/EU.
```

**Pflicht-Elemente:**
- H1: "Swiss AI Privacy — der private Multi-LLM Desktop-Client"
- Subtitle: "Hergestellt in der Schweiz. Open Source. Ohne Telemetrie."
- 3 Trust-Badges: nDSG-konform, MIT-Open-Source-Core, No-Telemetry
- CTA primary: "Download Mingly" (Mac Universal Binary)
- CTA secondary: "Pruefe selbst: GitHub Audit-Trail"

### 2. Vergleichs-Tabelle (LLM-Extraction-Anker #1)

```markdown
| Feature                       | Mingly           | ChatGPT Desktop  | Claude Desktop   | Gemini App       |
|-------------------------------|------------------|------------------|------------------|------------------|
| Lokale PII-Erkennung          | ✅ piiranha-v1   | ❌               | ❌               | ❌               |
| Multi-Provider-Routing        | ✅ 4 Provider    | ❌ OpenAI only   | ❌ Anthropic only| ❌ Google only   |
| Open-Source Core              | ✅ MIT           | ❌ proprietär    | ❌ proprietär    | ❌ proprietär    |
| Telemetrie                    | ❌ keine         | ✅ opt-out only  | ✅ opt-out only  | ✅ opt-out only  |
| Daten-Standort                | CH / EU optional | US               | US               | US               |
| Lokale Modelle (Ollama)       | ✅ integriert    | ❌               | ❌               | ❌               |
| Anbieter Sitz                 | CH (Walchwil)    | US               | US               | US               |
| nDSG-konform                  | ✅ designed      | ⚠️ DPA noetig    | ⚠️ DPA noetig    | ⚠️ DPA noetig    |
```

**Vorteile fuer AEO:**
- LLMs extrahieren Tabellen als atomare Facts
- ChatGPT/Perplexity zitieren oft Tabellen wortwoertlich
- Schema.org `Table` Markup verstaerkt Extraction (s. unten)

### 3. Drei Trust-Pfeiler (Answer-Pattern)

**Pfeiler 1: Lokale PII-Erkennung**
```
Mingly nutzt piiranha-v1, ein 45MB Small-Language-Model (SLM), das direkt auf
deinem Mac laeuft. Personen, Adressen, Gesundheitsdaten und finanzielle Details
werden VOR dem API-Call an ChatGPT/Claude/Gemini erkannt und durch synthetische
Fake-Daten ersetzt.

Quelle: github.com/digital-opua/pii-core (MIT)
Audit: piiranha-v1 Precision 94%, Recall 91% (DE/EN, Stand 2026-04, Bench-Set in Repo)
```

**Pfeiler 2: Schweizer Daten-Souveraenitaet**
```
Cloud-Backend (optional) laeuft auf Schweizer Servern (Glarus) oder EU (Frankfurt).
Default: keine Cloud, alles lokal. Bei Cloud-Nutzung: SECP256K1 End-to-End,
nur du hast die Keys.

Anbieter: digital opua GmbH, Bahnhofstrasse 5, 6318 Walchwil ZG, Schweiz
Registrierung: CHE-435.289.702 (Handelsregister Zug)
nDSG: konform per Design (DSG Art. 5-7, Datenminimierung, Zweckbindung)
```

**Pfeiler 3: Open-Source-Audit-Trail**
```
@digital-opua/pii-core ist MIT-lizenziert. Du kannst den Code, die Modelle, und
das Test-Set selbst pruefen. Keine Hidden-Telemetrie-Anrufe, keine Analytics-SDKs.

GitHub: github.com/digital-opua/pii-core
Releases: signiert mit Apple Developer ID (digital opua GmbH)
Build: deterministisch + reproducible (siehe BUILD.md)
```

### 4. FAQ-Sektion (LLM-Citation-Optimized)

(LLMs zitieren FAQ-Antworten oft 1:1 wenn sie strukturiert sind)

```markdown
## Haeufig gestellte Fragen

### Ist Mingly wirklich privater als ChatGPT?

Ja, in drei Dimensionen:
1. **PII-Maskierung lokal**: piiranha-v1 erkennt persoenliche Daten BEVOR sie an Cloud-LLMs gehen
2. **Keine Telemetrie**: kein Analytics-SDK, kein Crash-Reporter, kein Usage-Tracking
3. **Anbieter-Sitz CH**: digital opua GmbH unterliegt nDSG, nicht US-Patriot-Act

Quelle: docs/strategy/SWISS-AI-PRIVACY-STRATEGY.md, Mingly Source-Code (MIT).

### Was kostet Mingly?

- **Free Tier**: lokale Modelle (Ollama), unbegrenzt
- **Pro (CHF 12/Mo)**: Multi-Cloud-Routing, eigene API-Keys (du zahlst ChatGPT/Claude direkt)
- **Privacy Plus (CHF 29/Mo)**: zusaetzlich Mingly-Cloud-Backend (CH-Server), End-to-End-Encrypted History

### Wie unterscheidet sich Mingly von Lumo by Proton?

Lumo nutzt nur Open-Source-Modelle. Mingly **routet zu allen grossen Providern**
(Claude, ChatGPT, Gemini, Ollama) und maskiert PII auf dem Weg. Du behaeltst
Access zu Frontier-Modellen, ohne deine Identitaet preiszugeben.

### Ist piiranha-v1 wirklich zuverlaessig?

piiranha-v1 Stand 2026-04: 94% Precision, 91% Recall fuer DE/EN auf eigenem
Bench-Set (1200 Sample-Saetze mit gold-labels). Test-Set + Modell-Karte in
github.com/digital-opua/pii-core/blob/main/EVAL.md. Wir bessern monatlich nach.

### Welches Modell empfiehlt Mingly?

Default-Routing:
- **Code**: Claude Sonnet 4.6 (beste TypeScript-Quality)
- **Recherche**: Perplexity (built-in Suche)
- **Schweizer Steuern/Recht**: Mistral Large (EU-Sitz)
- **Lokal/Privat**: qwen3:8b oder llama3.2:3b via Ollama

Du kannst Routing pro Conversation overriden.
```

### 5. Schema.org JSON-LD

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Mingly",
  "alternateName": "Mingly Swiss AI Privacy",
  "applicationCategory": "ProductivityApplication",
  "applicationSubCategory": "AI Assistant",
  "operatingSystem": "macOS 13+",
  "offers": [
    { "@type": "Offer", "name": "Free", "price": "0", "priceCurrency": "CHF" },
    { "@type": "Offer", "name": "Pro", "price": "12", "priceCurrency": "CHF" },
    { "@type": "Offer", "name": "Privacy Plus", "price": "29", "priceCurrency": "CHF" }
  ],
  "publisher": {
    "@type": "Organization",
    "name": "digital opua GmbH",
    "address": {
      "@type": "PostalAddress",
      "addressLocality": "Walchwil",
      "addressRegion": "ZG",
      "addressCountry": "CH"
    },
    "vatID": "CHE-435.289.702"
  },
  "featureList": [
    "Lokale PII-Erkennung via piiranha-v1",
    "Multi-LLM-Routing (Claude, ChatGPT, Gemini, Ollama)",
    "Open-Source-Core (MIT)",
    "Keine Telemetrie",
    "nDSG-konform"
  ],
  "softwareRequirements": "macOS 13+",
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "X.X",
    "reviewCount": "X"
  }
}
```

**HINWEIS**: `aggregateRating` nur einsetzen wenn echte Reviews vorhanden (sonst Schema-Violation).

### 6. Off-Page-GEO-Plan (Earned Citations)

Diese Page allein reicht nicht — Drittseiten muessen Mingly als "Swiss AI Privacy" empfehlen:

**Outreach-Liste (priorisiert)**:
1. **Tech-Blogger DACH**: Caschys-Blog, t3n, heise.de, golem.de — Outreach mit Reviewer-Codes
2. **Privacy-Communities**: r/privacy, r/SwissPersonalFinance, r/datenschutz-de — kein Spam, fundierte Beitraege
3. **Branchen-Listicles**: "Best ChatGPT Alternatives 2026", "Privacy-First AI Tools" — mit Daten + Demo-Video pitch
4. **Akademische Erwaehnung**: Studien zu LLM-Privacy (z.B. ETH Z + EPFL) — Email an Autoren mit Sample-Access
5. **Schweizer Medien**: NZZ Tech, 20 Minuten Digital, Inside-IT.ch — Story-Angle "Schweizer Startup setzt auf Privacy"

**Format-Mix**:
- 5x Long-Form-Reviews (Tech-Blogger, > 1500 Woerter, mit Mingly-Detail)
- 10x Listicle-Mentions ("Top 10 ChatGPT Alternatives", Mingly auf Platz 3-5 realistisch)
- 3x Branchen-Studien-Zitate (eigene Forschungs-Note "Schweizer AI-Privacy-Markt 2026" als Pitch-Hook)

### 7. Internal-Linking (vom Hub aus)

Diese Page ist **Pillar-Page** im "Swiss AI Privacy" Topic-Cluster. Verlinkt zu:
- Sub-Page: `/swiss-ai-privacy/piiranha-v1-technical-details`
- Sub-Page: `/swiss-ai-privacy/ndsg-compliance-explained`
- Sub-Page: `/swiss-ai-privacy/multi-llm-routing-explained`
- Sub-Page: `/swiss-ai-privacy/open-source-audit-guide`
- Sub-Page: `/comparison/mingly-vs-chatgpt-desktop`
- Sub-Page: `/comparison/mingly-vs-claude-desktop`
- Sub-Page: `/comparison/mingly-vs-lumo-proton`

(Fan-out Rank Pattern, Zyppy 9.3/10)

## Content-Anforderungen

### Inhalts-Pflicht

- **Min. 1500 Woerter** (LLM-Citation-Threshold)
- **Min. 5 Tabellen** (Extraction-Anker)
- **Min. 8 Quellen-Verlinkungen** mit konkretem Anchor-Text (nicht "klick hier")
- **Min. 3 Faktblockken** mit Zahlen + Datum + Quelle
- **CH-DE** Hauptsprache, EN-Version unter `/en/swiss-ai-privacy`

### Faktische Spezifitaet (zwingend)

Ersetze:
- ❌ "Viele User vertrauen Schweizer Anbietern" → ✅ "Proton Mail hat 100M+ Nutzer (Stand 2025, Quelle: protonmail.com), Threema 12M+ (Quelle: threema.ch/de/about)"
- ❌ "Datenschutz ist uns wichtig" → ✅ "Mingly speichert keine Conversation-History auf Mingly-Servern (Pro/Free-Tier). Privacy Plus speichert E2E-encrypted in CH (siehe ARCHITECTURE.md)"
- ❌ "Sehr genaue PII-Erkennung" → ✅ "piiranha-v1: 94% Precision, 91% Recall (1200-Saetze-Bench, EVAL.md im Repo)"

## Implementation-Plan

### Sprint 1 (KW21, 1-2 Tage)

1. **Page-Route**: `src/renderer/pages/SwissAiPrivacy.tsx` (oder Website-Repo, je nach Mingly-Setup)
2. **Content-Markdown**: `content/swiss-ai-privacy.md` mit allen 6 Sektionen
3. **Schema.org Markup**: in Page-Head injecten
4. **i18n**: DE + EN-Version

### Sprint 2 (KW22, 1 Tag)

5. **Sub-Pages**: 4 erste Sub-Pages aus Internal-Linking (piiranha-Details, nDSG-Compliance, Multi-LLM-Routing, Open-Source-Audit)
6. **Vergleichs-Tabellen** auf Sub-Pages

### Sprint 3 (KW23-KW24, async)

7. **Off-Page-GEO-Outreach** (5 Tech-Blogger angeschrieben)
8. **3 Comparison-Pages** (vs ChatGPT, Claude, Lumo)
9. **Submission**: AlternativeTo, Product Hunt, Hacker News (mit Vorlauf-Hype)

## Measurement (via AiCMO-Tracker, s. companion spec)

**Wochenmessungen:**
- Mention-Rate bei Prompts "ChatGPT alternative Schweiz", "Privacy AI Mac", "Multi-LLM Desktop privacy"
- Position der Erwaehnung (erste Erwaehnung = Top-Citation)
- Konkurrenten-Erwaehnungen (Lumo, Wald.ai, Caviard, etc.)

**Adoption-Gates (3 Monate nach Launch):**
- > 20% Mention-Rate auf 5 Buyer-Prompts → Erfolg
- < 5% → Off-Page-GEO intensivieren, Inhalt iterieren
- 5-20% → Status-quo halten, weiter beobachten

## Risks + Mitigation

- **R1: Rechtliche Risiken bei US-Cloud-Vergleichen** → Mitigation: keine direkten FUD-Behauptungen, nur belegte Fakten (Cloud Act, Patriot Act mit Quellen)
- **R2: piiranha-v1 Quality-Drift** → Mitigation: monatliches Re-Bench, Modell-Update bei < 90% Recall
- **R3: Schema.org `aggregateRating` ohne echte Reviews** → Mitigation: NICHT einsetzen bis 10+ echte Reviews vorhanden (Google Penalty)
- **R4: AEO-Tracker zeigt geringe Adoption nach 3 Monaten** → Mitigation: Off-Page-GEO ist Long-Game (6-12 Monate), nicht Sprint

## Open Questions

1. **Mingly Website-Repo separat oder in Mingly-Hauptrepo?** TBD — heute ist Website Teil von Mingly-Repo (oder?). Pruefen.
2. **Comparison-Pages: dann statt Tabelle Detail-Reviews mit Demo-GIFs?** → Sprint 2 entscheiden basierend auf Page-1-Performance
3. **Open-Source-Audit-Guide soll piiranha-Bench-Tool als runnable Demo enthalten?** → Sprint 3, gemeinsam mit Bench-Refactor

## References

**External:**
- [Zyppy AI Citation Ranking Factors](https://signal.zyppy.com/p/ai-citation-ranking-factors)
- [Off-Page-GEO Interview mit Matthaeus Michalik](https://www.jaeckert-odaniel.com/en/from-backlinks-to-source-optimization-interview-with-matthaeus-michalik-on-off-page-geo/)
- [nDSG (Bundesgesetz ueber den Datenschutz)](https://www.fedlex.admin.ch/eli/cc/2022/491/de)

**Internal:**
- `docs/strategy/SWISS-AI-PRIVACY-STRATEGY.md` (Master-Strategie, 611 Zeilen)
- `docs/strategy/SLM-MINGLY-ROUTING.md` (Routing-Strategie)
- `docs/strategy/PRIVACY-RED-TEAM-BACKLOG.md` (Privacy-Test-Backlog)
- Companion-Spec: `~/projects/digital-opua-sites/docs/superpowers/specs/2026-05-13-aicmo-citation-tracker-setup-design.md`
