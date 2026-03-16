# Swiss AI Privacy — Mingly Strategie

> Erstellt: 2026-03-14 | Status: Draft | Aktualisiert: 2026-03-14 (Konsolidierung)
> Autor: Holger von Ellerts / Claude
> Kontext: Geschäftsidee PII-Anonymisierung → Plattform-Strategie digital opua
> Referenzen: STRATEGY.md (Pfad B), mingly-roadmap-v06.md (Phase 7b + 9.8-9.9 + 10)

## Executive Summary

**Claim: "Swiss AI Privacy"** — Mingly wird der privacy-first Multi-LLM Desktop Client.
Nutzer interagieren mit ChatGPT, Claude, Gemini und lokalen Modellen, ohne ihre Identität,
Gesundheitsdaten oder persönliche Vorlieben an Provider preiszugeben.

**Positionierung:**
```
Proton    = Swiss Email Privacy    (Genf, 100M+ User)
Threema   = Swiss Chat Privacy     (Pfäffikon, 12M+ User)
Mingly    = Swiss AI Privacy       (← diese Position ist FREI)
```

**Strategie:** Privacy-Layer als Shared Core (`@digital-opua/pii-core`), Mingly als
Consumer-Vehicle, Rollout auf DocMind, RAG-Wissen, Nexbid. Open-Source-Core für Vertrauen,
Commercial Features für Revenue.

---

## 1. Marktanalyse

### 1.1 Bestehende Konkurrenz

| Akteur | Typ | Schwäche |
|--------|-----|----------|
| Wald.ai ($4M Seed) | Cloud-Proxy, Enterprise | Teuer, US-Cloud, kein Consumer |
| Caviard.ai | Browser Extension | Nur Masking, kein Fake-Profil, limitiert |
| Cloak.business | Chrome Extension | Vertrauensproblem (Malware-Skandal Dez 2025) |
| Lakera (→ Check Point, ~$300M) | Enterprise Gateway | Enterprise-only, kein Consumer |
| Lumo by Proton | Privacy-First AI | Nur Open-Source-Modelle, kein Multi-LLM |
| LLM Guard (Open Source) | Python Library | Nur für Entwickler |

### 1.2 Marktlücke

**Niemand bietet gleichzeitig:**
1. Multi-LLM-Support (ChatGPT + Claude + Gemini + Ollama)
2. Automatische PII-Anonymisierung mit kohärentem Fake-Profil
3. Desktop-App (kein Browser-Extension-Vertrauen nötig)
4. Schweizer Datenschutz (nDSG) by Design
5. On-Device SLM für PII-Detection (kein Cloud-Dependency)

### 1.3 Marktgrösse

- Privacy Enhancing Technologies: $3.1 Mrd. (2024) → $12 Mrd. (2030), CAGR 25%
- Privacy-Preserving AI: Prognose $39.9 Mrd. bis 2035
- Regulatorischer Druck steigt: EU AI Act (Aug 2025), nDSG, DSGVO

---

## 2. Produkt-Vision: Mingly als "Swiss AI Privacy" Client

### 2.1 User Experience

```
┌─────────────────────────────────────────────────────┐
│  Mingly                                    [─][□][×]│
├─────────────┬───────────────────────────────────────┤
│             │                                       │
│  Chats      │  🔒 Privacy Mode: AN                  │
│             │                                       │
│  ─────────  │  Du: "Ich bin Holger, 42, wohne in   │
│  Claude ◉   │  Basel und habe seit 3 Jahren         │
│  GPT-4o     │  Bluthochdruck. Was kann ich tun?"    │
│  Gemini     │                                       │
│  Ollama     │  ┌─ Privacy Shield ──────────────┐    │
│             │  │ 4 Daten geschützt:             │    │
│             │  │  👤 Holger → Thomas Berger     │    │
│             │  │  🎂 42 → 38                    │    │
│             │  │  📍 Basel → Luzern             │    │
│             │  │  🏥 Bluthochdruck → (behalten) │    │
│             │  └────────────────────────────────┘    │
│             │                                       │
│  ─────────  │  An Provider gesendet:                │
│  ⚙ Settings │  "Ich bin Thomas, 38, wohne in       │
│             │  Luzern und habe seit 3 Jahren         │
│  🔒 Privacy │  Bluthochdruck. Was kann ich tun?"    │
│             │                                       │
│             │  Claude: "Bei Bluthochdruck empfehle  │
│             │  ich folgende Massnahmen..."           │
│             │                                       │
└─────────────┴───────────────────────────────────────┘
```

### 2.2 Kern-Prinzipien

1. **Privacy by Default** — Privacy Mode ist AN beim ersten Start (Opt-out, nicht Opt-in)
2. **Transparent** — User sieht was anonymisiert wird (Privacy Shield Panel)
3. **Semantisch kohärent** — Fake-Daten sind plausibel (Name→Name, Stadt→Stadt, Alter→±5)
4. **Medizinische Daten: Vorsichtsprinzip** — Krankheiten werden NICHT ersetzt (semantischer Kontext kritisch), aber der Personenbezug wird entfernt
5. **Reversibel** — Mapping bleibt lokal, Antworten werden re-hydratisiert
6. **Zero Cloud** — Alle PII-Verarbeitung on-device, nichts verlässt den Rechner ungeschützt

### 2.3 Privacy Modes

| Modus | Was passiert | Use Case |
|-------|-------------|----------|
| **Shield** (Default) | PII wird durch kohärente Fake-Daten ersetzt | Alltägliche Nutzung |
| **Vault** | PII wird komplett entfernt (Redaction) | Hochsensible Daten |
| **Transparent** | Nichts wird geändert, aber PII wird markiert | Bewusste Entscheidung |
| **Local Only** | Routing nur an Ollama, kein Cloud-Provider | Maximum Privacy |

---

## 3. SLM + Privacy — Die Synergie

### 3.1 Warum SLM für Privacy passt

Die SLM-Strategie von digital opua ("Tiny First") und Privacy sind **natürliche Verbündete**:

| SLM-Prinzip | Privacy-Anwendung |
|-------------|-------------------|
| Kleinstes Modell zuerst | PII-Detection braucht kein GPT-4 — ein 66M BERT reicht |
| On-Device | PII-Erkennung MUSS lokal laufen — SLM ermöglicht das |
| Spezialisierung > Generalisierung | Ein PII-SLM schlägt ein General-Purpose LLM bei NER |
| Kosteneffizienz | PII-Check kostet 0 API-Tokens wenn lokal |

### 3.2 Drei SLMs in Mingly (v0.7+)

```
User Input
    │
    ▼
┌──────────────────┐
│  PII-SLM (66M)   │  ← Schicht 1: Was ist PII?
│  DistilBERT NER   │     Token Classification
│  piiranha/GLiNER  │     Latenz: <50ms
└────────┬─────────┘
         │ PII-Entities erkannt
         ▼
┌──────────────────┐
│  Anonymizer      │  ← Schicht 2: Ersetzen
│  Faker + Rules   │     Deterministisch, kein ML
│  Session-Mapping │     Latenz: <5ms
└────────┬─────────┘
         │ Anonymisierter Text
         ▼
┌──────────────────┐
│  Routing-SLM     │  ← Schicht 3: Wohin senden?
│  (360M, v0.7)    │     Modell-Auswahl basierend auf
│  SmolLM2/BERT    │     Task-Typ + Sensitivity
└────────┬─────────┘
         │
         ▼
   Cloud LLM / Ollama
```

**Gesamtlatenz Privacy-Pipeline:** ~55ms (unmerklich für User)

### 3.3 PII-SLM: Modell-Auswahl

| Modell | Params | F1 | Sprachen | ONNX | Empfehlung |
|--------|--------|-----|----------|------|------------|
| `gravitee-io/bert-small-pii` | **28.5M** | — | EN | Ja | PoC / Minimal |
| `dslim/bert-base-NER` | 110M | 91.3% | EN | Ja | Fallback |
| `piiranha-v1-detect` | 400M | **99.4%** | DE+EN+FR+IT | Ja | **Production** |
| `urchade/gliner_multi_pii` | ~100M | GPT-4-level | Multi | Ja | Zero-Shot |
| `eternisai/Anonymizer-1.7B` | 1.7B | 9.2/10 | EN | Nein | Overkill für Detection |

**Empfehlung Mingly:**
- **v0.7 PoC:** `piiranha-v1` via ONNX Runtime (~400MB, beste DE-Unterstützung)
- **v0.8 Optimierung:** `gliner_multi_pii` evaluieren (Zero-Shot = neue PII-Typen ohne Retraining)
- **Langfristig:** Eigenes Fine-Tuned Modell auf `ai4privacy/pii-masking-400k` + CH-spezifische Daten (AHV-Nr, CH-IBAN, Kantone)

### 3.4 Routing-SLM + Privacy: Doppelte Nutzung

Das Routing-SLM (bereits für v0.7 geplant) kann **Privacy-aware routen**:

```typescript
interface RoutingDecision {
  model: string;           // "claude-sonnet" | "gpt-4o" | "ollama/llama3"
  reason: string;          // "medical_query_complex"
  privacyAction: PrivacyAction;  // "shield" | "vault" | "local_only"
}

// Beispiele:
// "Erkläre mir Quantenmechanik" → GPT-4o, transparent (kein PII)
// "Mein Sohn hat Fieber" → Claude, shield (PII anonymisieren)
// "Meine Scheidung..." → Ollama, local_only (zu sensitiv für Cloud)
```

Das Routing-SLM lernt aus Nutzungsdaten, welche Topics automatisch lokal bleiben sollten.

---

## 4. Technische Architektur

### 4.1 Shared Core: `@digital-opua/pii-core`

```
@digital-opua/pii-core (TypeScript + ONNX)
├── detect/
│   ├── regex-detector.ts      # Strukturierte PII (E-Mail, IBAN, AHV-Nr, Tel)
│   ├── ner-detector.ts        # ML-basierte NER via ONNX Runtime
│   ├── swiss-detector.ts      # CH-spezifisch: AHV, Kantone, PLZ, CH-Mobile
│   └── detector-pipeline.ts   # Orchestrierung: Regex → NER → Merge
├── anonymize/
│   ├── faker-anonymizer.ts    # Typ-kohärenter Ersatz via Faker
│   ├── date-shifter.ts        # Datumsverschiebung (±N Tage, relativ korrekt)
│   ├── name-generator.ts      # Gender/Sprach-kohärente Namen
│   └── strategies.ts          # Shield / Vault / Transparent
├── mapping/
│   ├── session-map.ts         # In-Memory Token→Original Mapping
│   ├── encrypted-store.ts     # AES-256-GCM persistentes Mapping
│   └── rehydrator.ts          # Response-Deanonymisierung
├── models/
│   └── onnx/                  # Vortrainierte ONNX-Modelle
│       ├── piiranha-v1.onnx
│       └── tokenizer/
└── index.ts                   # Public API
```

### 4.2 Public API

```typescript
import { PIICore } from '@digital-opua/pii-core';

const pii = new PIICore({
  strategy: 'shield',        // shield | vault | transparent
  locale: 'de_CH',           // Faker-Locale
  model: 'piiranha-v1',      // ONNX-Modell
  sessionId: 'conv-123',     // Konsistentes Mapping pro Session
});

// Anonymisieren
const result = await pii.anonymize("Ich bin Holger aus Basel, 42 Jahre alt.");
// → { text: "Ich bin Thomas aus Luzern, 38 Jahre alt.",
//    entities: [{ type: "PERSON", original: "Holger", replacement: "Thomas", ... }],
//    stats: { detected: 3, anonymized: 3, latencyMs: 47 } }

// Deanonymisieren (Response vom LLM)
const original = pii.deanonymize("Thomas, hier sind Empfehlungen für Luzern...");
// → "Holger, hier sind Empfehlungen für Basel..."
```

### 4.3 Integration in Mingly

```
Mingly Architektur (bestehend)                    NEU (Privacy Layer)
┌──────────────────────────────────────────────────────────────────┐
│ Renderer (React)                                                 │
│  ├── ChatView                                                    │
│  │    └── PrivacyShield.tsx  ← NEU: zeigt anonymisierte Entities │
│  ├── Settings                                                    │
│  │    └── PrivacySettings.tsx ← NEU: Mode, Ausnahmen, Audit-Log │
│  └── StatusBar                                                   │
│       └── PrivacyIndicator.tsx ← NEU: 🔒 Shield | 🔓 Transparent│
├──────────────────────────────────────────────────────────────────┤
│ IPC (Preload)                                                    │
│  └── privacy:anonymize, privacy:deanonymize, privacy:getStats    │
├──────────────────────────────────────────────────────────────────┤
│ Main Process                                                     │
│  ├── security/                                                   │
│  │    ├── data-classifier.ts    (bestehend, Phase 7.3)           │
│  │    ├── output-guardrails.ts  (bestehend, Phase 7.2)           │
│  │    └── privacy-engine.ts     ← NEU: orchestriert pii-core    │
│  ├── ipc/handlers/                                               │
│  │    └── send-message.ts       ← ERWEITERT: pre-send anonymize │
│  └── models/                                                     │
│       └── onnx/piiranha-v1.onnx ← NEU: gebundelt oder lazy-load │
└──────────────────────────────────────────────────────────────────┘
```

**Kritischer Hook-Point:** Im `send-message` IPC Handler — NACH Input-Sanitization,
VOR dem API-Call:

```typescript
// Bestehender Flow (Phase 7):
// 1. InputSanitizer.check()       ← Injection Detection
// 2. DataClassifier.classify()    ← Sensitivity Level
// 3. CircuitBreaker.check()       ← Budget Check
// 4. ClientManager.send()         ← API Call

// Erweiterter Flow mit Privacy:
// 1. InputSanitizer.check()
// 2. DataClassifier.classify()
// 3. PrivacyEngine.anonymize()    ← NEU: PII ersetzen
// 4. CircuitBreaker.check()
// 5. ClientManager.send()         ← Anonymisierter Text geht raus
// 6. PrivacyEngine.deanonymize()  ← NEU: Response re-hydratisieren
```

### 4.4 ONNX Bundle-Strategie

| Strategie | Bundle-Size | Startup | Empfehlung |
|-----------|-------------|---------|------------|
| **Gebundelt** | +400MB | Sofort | Nein (App zu gross) |
| **Lazy Download** | +0MB initial, 400MB on-demand | Erster Privacy-Call | **Ja** |
| **Quantisiert (INT8)** | +100MB | Sofort | Für v0.8+ |

**Lazy Download Flow:**
1. User aktiviert Privacy Mode zum ersten Mal
2. Dialog: "Privacy-Modell herunterladen? (~100MB, einmalig)"
3. Download von CDN/GitHub Release → `~/.mingly/models/piiranha-v1.onnx`
4. Ab dann: lokal, offline-fähig

---

## 5. Mingly Roadmap — Privacy Integration

> Konsolidiert mit `memory/mingly-roadmap-v06.md` (Stand 2026-03-14)

### Phase 7a (v0.7.0-alpha) — AI Safety (bestehend, 4–5 Tage)

Items 7.1–7.9 wie in Master-Roadmap definiert (Circuit Breaker, Guardrails,
Data Classification, Prompt Injection, RAG Safety, Cost Tracking, promptfoo,
Token Limits, hai-guardrails).

### Phase 7b (v0.7.0) — 🔒 Swiss AI Privacy Layer (NEU, 4–5 Tage)

| # | Feature | Abhängigkeit | Aufwand |
|---|---------|-------------|---------|
| 7b.1 | PII-Core Library (Detect/Anonymize/Map/Rehydrate) | 7a.3 DataClassifier | 2 Tage |
| 7b.2 | Privacy UI (Shield Panel, Settings, Indicator) | 7b.1 | 1.5 Tage |
| 7b.3 | ONNX Model Lazy-Download + piiranha-v1 | 7b.1 | 1 Tag |
| 7b.4 | Privacy Red-Teaming (PII-Leak-Tests via promptfoo) | 7b.1 + 7a.7 | 0.5 Tage |
| 7b.5 | CH-spezifische PII-Recognizers (AHV, CH-IBAN, Kantone) | 7b.1 | 0.5 Tage |

### Phase 9 (v0.9.0) — Distribution (erweitert)

| # | Feature | Neu |
|---|---------|-----|
| 9.1–9.7 | Bestehende Items (Search, Shortcuts, Notarization, etc.) | Nein |
| **9.8** 🔒 | **Browser Extension "AI Privacy Check" (Lead Magnet)** | Ja |
| **9.9** 🔒 | **Privacy Audit-Log UI (Statistik + Compliance-Export)** | Ja |

### Phase 10 (v1.0.0) — Swiss AI Privacy Launch

| # | Feature |
|---|---------|
| 10.1 | Marketing-Website: "Swiss AI Privacy" Claim auf mingly.ch |
| 10.2 | Branding: Sub-Claim "Deine Daten bleiben bei dir" |
| 10.3 | Open-Source: `@digital-opua/pii-core` auf npm/GitHub (MIT) |
| 10.4 | Compliance: nDSG-Konformitaetserklaerung |

> **Pricing:** Konsistent mit STRATEGY.md — Free / Pro CHF 24 / Team CHF 69 / Enterprise.
> Privacy ist in ALLEN Tiers enthalten (kein Upsell). Siehe Abschnitt 7.4.

---

## 6. Rollout auf andere digital opua Produkte

### 6.1 Rollout-Roadmap

```
Q2 2026    Q3 2026    Q4 2026    Q1 2027
   │          │          │          │
   ▼          ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│Mingly  │ │DocMind │ │RAG-    │ │Nexbid  │
│v0.7    │ │v0.6    │ │Wissen  │ │v2      │
│Privacy │→│Privacy │→│Phase F │→│PII in  │
│PoC     │ │for Docs│ │PII     │ │Feeds   │
└────────┘ └────────┘ └────────┘ └────────┘
     │          │          │          │
     └──────────┴──────────┴──────────┘
                    │
          @digital-opua/pii-core
            (Shared Library)
```

### 6.2 Produkt-spezifische Integration

#### DocMind Desktop (v0.6.0)

| Aspekt | Details |
|--------|---------|
| **Use Case** | Dokumente durchsuchen ohne PII an Embedding-API zu senden |
| **Hook-Point** | Pre-Embedding: Text → pii-core.anonymize() → Embedding API |
| **Besonderheit** | Dokument-Level Mapping (nicht Session-Level) |
| **Zielgruppe** | Arztpraxen, Kanzleien, HR mit sensiblen Dokumenten |
| **Pitch** | "Ihre Dokumente durchsuchen, ohne sie preiszugeben" |

#### RAG-Wissen (Phase F)

| Aspekt | Details |
|--------|---------|
| **Use Case** | PII in indexierten Dokumenten erkennen und maskieren |
| **Hook-Point** | Indexer Pipeline: pre-chunking + post-search Response |
| **Besonderheit** | Bereits geplant (Phase F), ai4privacy + Presidio evaluiert |
| **Synergie** | pii-core ersetzt geplante Presidio-Integration (leichtgewichtiger) |
| **Zielgruppe** | Unternehmen mit internem Wissensmanagement |

#### Nexbid (v2)

| Aspekt | Details |
|--------|---------|
| **Use Case** | Advertiser-Produktdaten enthalten Kundendaten/PII |
| **Hook-Point** | Feed-Ingestor: PII in Produktbeschreibungen maskieren |
| **Besonderheit** | Server-seitig (Node.js), nicht Desktop |
| **Zielgruppe** | Publisher, die DSGVO-konform Ads ausspielen wollen |
| **Pitch** | "DSGVO-konforme Auktionen, garantiert" |

### 6.3 Shared Core — Packaging

```
@digital-opua/pii-core
├── npm (TypeScript) → Mingly, DocMind, Nexbid
├── PyPI (Python Wrapper) → RAG-Wissen
└── ONNX Models (separate Downloads)
    ├── piiranha-v1-int8.onnx (100MB, quantisiert)
    └── gliner-pii-v1.onnx (50MB, Zero-Shot)
```

**Lizenz:** MIT (Core) + Commercial (Enterprise Features: Audit-Log, Compliance-Reports, SLA)

---

## 7. Go-to-Market: Consumer erreichen

### 7.1 Kanal-Strategie

```
                        Awareness
                    ┌──────────────┐
                    │ Blog/Content │  "Ist dein ChatGPT nDSG-konform?"
                    │ LinkedIn     │  "Was weiss OpenAI über dich?"
                    │ HN/Reddit   │  Open-Source-Core Announcement
                    └──────┬───────┘
                           │
                     Consideration
                    ┌──────────────┐
                    │ Browser Ext. │  Gratis, warnt nur bei PII
                    │ (Lead Magnet)│  → "Schütze dich mit Mingly"
                    └──────┬───────┘
                           │
                      Conversion
                    ┌──────────────┐
                    │ Mingly Free  │  Lokale Modelle, Privacy an
                    │              │  → Upgrade für Cloud-LLMs
                    └──────┬───────┘
                           │
                       Revenue
                    ┌──────────────┐
                    │ Mingly Pro   │  CHF 24/Mo
                    │ Team         │  CHF 69/Mo pro Seat
                    └──────────────┘
```

### 7.2 Browser Extension: "AI Privacy Check"

**Zweck:** Lead Magnet, NICHT vollständiger Privacy-Proxy.

**Funktionen:**
1. Erkennt wenn User PII in ChatGPT/Claude/Gemini tippt
2. Zeigt Warning: "Du bist dabei, 3 persönliche Daten zu senden"
3. Liste der erkannten PII (Name, Ort, Krankheit...)
4. CTA: "Schütze dich automatisch → Mingly herunterladen"

**Technisch:** Manifest V3, Content Script, Regex-only (kein ML im Browser),
~50KB, kein Netzwerk-Zugriff (Vertrauen!).

**NICHT enthalten:** Anonymisierung, Fake-Profile, Datenverarbeitung →
das ist der Upgrade-Grund zu Mingly.

### 7.3 B2SmallB: Branchen-Vertrieb

| Branche | Kanal | Pitch |
|---------|-------|-------|
| **Arztpraxen** | FMH, Ärztekongresse, MedTech-Messen | "KI-Assistenz ohne Patientendaten in der Cloud" |
| **Anwaltskanzleien** | SAV, Anwaltstag, Legal Tech CH | "Mandantengeheimnis + KI = nur mit Mingly" |
| **Treuhänder** | Treuhandkammer, EXPERT Suisse | "Finanzdaten bleiben lokal" |
| **HR** | HR Swiss, Swissstaffing | "Bewerberdaten DSGVO-konform mit KI verarbeiten" |
| **Therapeuten** | FSP, Psychologie-Kongresse | "Sitzungsnotizen mit KI — vollständig anonym" |

### 7.4 Pricing

> Konsistent mit STRATEGY.md Pricing-Modell. Privacy ist kein Upsell — es ist
> in allen Tiers enthalten als Kern-Differenzierung ("Swiss AI Privacy").

| Tier | Preis | Privacy-Features |
|------|-------|-----------------|
| **Free** | CHF 0 | Privacy Shield (lokal), 3 Conv./Tag, Ollama only |
| **Pro** | CHF 24/Mo (CHF 199/Jahr) | + Cloud-LLMs mit Privacy, Audit-Log, alle Modes |
| **Team** | CHF 69/User/Mo (CHF 599/Jahr) | + Team-Privacy-Policies, Shared Mappings, Compliance-Export |
| **Enterprise** | Auf Anfrage (ab ~CHF 150/User) | + On-Premise, SSO, Custom PII-Rules, SLA |

**Privacy als Differenzierung, nicht als Paywall:**
- Free-Tier hat VOLLEN Privacy-Schutz (Shield-Modus) — nur auf lokale Modelle beschränkt
- Pro fügt Cloud-Provider hinzu, Privacy bleibt aktiv
- Team/Enterprise fügen organisationsweite Privacy-Policies hinzu
- **Kein Tier ohne Privacy** — das IST der Brand

### 7.5 Messaging-Pyramide (VERBINDLICH)

> Entscheidung 2026-03-16: "Swiss AI Privacy" ist der Primaer-Claim.
> "Multi-LLM Client" ist ein Feature, keine Positionierung.

```
MISSION (Why)
  KI nutzen, ohne die Privatsphaere aufzugeben.

CLAIM (What)
  Swiss AI Privacy

VALUE PROPOSITION (How)
  Der einzige Multi-LLM Desktop Client, der persoenliche Daten
  automatisch schuetzt — on-device, open source, aus der Schweiz.

REASON TO BELIEVE (Proof)
  1. On-Device PII-Anonymisierung (piiranha-v1, 400M ONNX, <50ms)
  2. 4 Privacy Modes (Shield / Vault / Transparent / Local Only)
  3. Schweizer Firma (digital opua GmbH, Walchwil, nDSG)
  4. MIT-lizenzierter Core (auditierbar, kein Vertrauen auf Versprechen)
  5. Proton = Email, Threema = Chat, Mingly = AI (freie Position)

TAGLINE (One-Liner)
  DE: "Swiss AI Privacy — KI nutzen, Daten behalten."
  EN: "Swiss AI Privacy — Use AI, keep your data."
```

**Regeln:**
- "Swiss AI Privacy" steht IMMER vor "Multi-LLM"
- README, Website, FAQ, LinkedIn, ProductHunt: Tagline zuerst
- "Mingle with all AI minds" ist ein Sub-Slogan fuer die Multi-Provider-Feature-Section, NICHT die Hauptpositionierung
- Jede externe Kommunikation muss mindestens 1 der 5 RTBs enthalten

---

## 8. SLM + Privacy: Unified Narrative

### 8.1 Die Story

> **"Wir glauben, dass KI-Privatsphäre kein Cloud-Problem ist, sondern ein Lokales.**
> Deshalb setzen wir auf kleine, spezialisierte Modelle, die direkt auf deinem Gerät
> laufen — schneller, günstiger und privater als jede Cloud-Lösung."

### 8.2 Wie SLM das Privacy-Versprechen ermöglicht

| Ohne SLM | Mit SLM |
|----------|---------|
| PII-Detection via Cloud-API (Google DLP, AWS Comprehend) → Daten verlassen Gerät | PII-Detection via lokales ONNX-Modell → Daten bleiben lokal |
| Anonymisierung auf Server → Provider sieht Original | Anonymisierung on-device → Provider sieht nur Fake |
| Routing-Entscheidung durch Heuristik | Routing-SLM lernt: "Medizin → lokal, Kochen → Cloud" |
| Latenz: API-Roundtrip (~200ms) | Latenz: On-Device (~50ms) |
| Kosten: API-Calls pro PII-Check | Kosten: CHF 0 nach Model-Download |

### 8.3 SLM-Stack pro Produkt (aktualisiert)

| Produkt | SLM 1 (Privacy) | SLM 2 (Task) | Deployment |
|---------|-----------------|--------------|------------|
| **Mingly** | PII-SLM (piiranha, 400M ONNX) | Routing-SLM (360M) | Electron, on-device |
| **DocMind** | PII-SLM (shared mit Mingly) | — | Electron, on-device |
| **RAG-Wissen** | PII-SLM (piiranha, Python) | Answer-SLM (Qwen-3B, Ollama) | Server, lokal |
| **Nexbid** | PII-SLM (DistilBERT, 66M) | Context-SLM (Qwen-0.5B) | Cloud Edge |

---

## 9. Risiken & Mitigations

| Risiko | Schwere | Mitigation |
|--------|---------|------------|
| **ONNX Runtime in Electron**: Bundle-Size, Startup | Mittel | Lazy Download, INT8 Quantisierung |
| **Coreference-Problem**: "Herr Müller ... er ... der Patient" | Hoch | Phase 1: ignorieren, Phase 2: Coreference-Modell |
| **False Positives**: "Basel" als Stadt vs. "Basel" als Firmenname | Mittel | Kontextuelle NER (piiranha), User-Korrektur |
| **Grosse Player**: Check Point, OpenAI steigen ein | Hoch | Nische CH/DACH, Self-Hosted, Open Source |
| **User-Akzeptanz**: Privacy Mode verlangsamt/verändert Antworten | Mittel | Transparentes UI, einfaches Opt-out |
| **Regulatorisch**: Was wenn Provider Privacy-Proxys verbieten? | Niedrig | ToS-Monitoring, Multi-Provider-Support |

---

## 10. Erfolgskriterien

| Metrik | 6 Monate | 12 Monate | 24 Monate |
|--------|----------|-----------|-----------|
| Mingly Downloads | 1'000 | 10'000 | 50'000 |
| Privacy Mode Adoption | 60% der User | 75% | 80% |
| Browser Extension Installs | 5'000 | 25'000 | 100'000 |
| Paying Customers (Pro) | 50 | 500 | 2'500 |
| Business Seats | 20 | 200 | 1'000 |
| PII-Core npm Downloads | 500/Mo | 5'000/Mo | 20'000/Mo |
| Media Coverage | 2 Artikel | 10 Artikel | Swiss Tech Award |

---

## Anhang

### A. Regulatorische Referenzen
- nDSG: Bundesgesetz über den Datenschutz (in Kraft seit Sept. 2023)
- EDÖB: https://www.edoeb.admin.ch/de/ki-und-datenschutz
- EU AI Act: Ab 2. August 2025 vollständig in Kraft
- DSGVO Art. 25: Privacy by Design und by Default

### B. Technische Referenzen
- Microsoft Presidio: https://github.com/microsoft/presidio
- piiranha-v1: https://huggingface.co/iiiorg/piiranha-v1-detect-personal-information
- GLiNER: https://github.com/urchade/GLiNER
- ai4privacy Dataset: https://huggingface.co/datasets/ai4privacy/pii-masking-400k
- Anonymizer-SLM: https://huggingface.co/blog/pratyushrt/anonymizerslm
- ONNX Runtime: https://onnxruntime.ai/
- Faker: https://github.com/joke2k/faker

### C. Konkurrenz-Referenzen
- Wald.ai: https://wald.ai ($4M Seed, Dez 2024)
- Caviard.ai: https://www.caviard.ai/
- Lakera → Check Point: ~$300M Akquisition (Q4 2025)
- Lumo by Proton: https://lumo.proton.me/
- LLM Guard: https://github.com/protectai/llm-guard
- RPBLC DAM: https://github.com/RPBLC-hq/RPBLC.DAM

### D. Verwandte digital opua Dokumente
- SLM-Strategie: ~/projects/nexbid/docs/strategy/SLM-STRATEGY-DIGITAL-OPUA.md
- Mingly SLM-Routing: ~/mingly/docs/strategy/SLM-MINGLY-ROUTING.md
- Mingly Roadmap: memory/mingly-roadmap-v06.md
- RAG-Wissen Phase F: PII-Schutz (ai4privacy + Presidio)
