# SLM-Implementierung: Mingly Routing-SLM

**Version:** 1.0
**Datum:** 2026-03-14
**Parent:** ~/projects/nexbid/docs/strategy/SLM-STRATEGY-DIGITAL-OPUA.md
**Status:** Planning
**Target Release:** Mingly v0.7

---

## 1. Zielsetzung

Mingly erhaelt ein eingebettetes **Routing-SLM** (~100–500M Parameter), das automatisch das optimale Modell aus dem Provider-Portfolio des Kunden waehlt. Das Routing-SLM laeuft lokal auf dem Kunden-Rechner (CPU-only, <10ms).

### Wertversprechen

| Fuer den Kunden | Mechanismus |
|-----------------|------------|
| **60–80% Kosten-Reduktion** | Einfache Anfragen → guenstigstes Modell |
| **Bessere Antwort-Qualitaet** | Task-spezifisch bestes Modell (Code→Codex, Text→Claude) |
| **Zero-Config** | Router lernt automatisch aus Nutzung |
| **Transparenz** | "Dieses Modell wurde gewaehlt weil..." |

### Strategischer Moat

Mingly wird vom "Multi-LLM Client" zur **"intelligenten AI-Orchestrierungsplattform"**:
- Je mehr Provider angebunden → desto wertvoller das Routing
- Jede Installation wird durch Nutzungsdaten einzigartig besser
- Wettbewerber muessten proprietaere Routing-Daten replizieren

---

## 2. Architektur

```
┌──────────────────────────────────────────────────────┐
│  Mingly Desktop App (Electron)                        │
│                                                        │
│  User Prompt                                           │
│       │                                                │
│       ▼                                                │
│  ┌──────────────────┐                                  │
│  │  Feature Extractor│                                  │
│  │  (Regelbasiert)   │                                  │
│  │                   │                                  │
│  │  • Prompt-Laenge  │                                  │
│  │  • Sprache (DE/EN)│                                  │
│  │  • Task-Keywords  │                                  │
│  │  • Code-Markers   │                                  │
│  │  • Konversations- │                                  │
│  │    kontext        │                                  │
│  └────────┬─────────┘                                  │
│           │                                            │
│           ▼                                            │
│  ┌──────────────────┐    ┌──────────────────────────┐  │
│  │  Routing-SLM      │    │  Provider Registry       │  │
│  │  (~360M, ONNX)    │    │                          │  │
│  │                   │    │  Provider A (GPT-4o)     │  │
│  │  Input: Features  │───▶│  Provider B (Claude)     │  │
│  │  Output:          │    │  Provider C (Ollama)     │  │
│  │  • provider_id    │    │  Provider D (Groq)       │  │
│  │  • confidence     │    │  Provider E (Mistral)    │  │
│  │  • reasoning      │    │                          │  │
│  └────────┬─────────┘    └──────────┬───────────────┘  │
│           │                         │                   │
│           ▼                         ▼                   │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Response + Metadata                              │  │
│  │  • Model used, Latency, Token count, Cost         │  │
│  └────────────────────────┬─────────────────────────┘  │
│                           │                             │
│                           ▼                             │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Feedback Collector                               │  │
│  │  • User Rating (optional)                         │  │
│  │  • Implicit: Regenerate? Edit? Accept?            │  │
│  │  • Latency, Cost                                  │  │
│  │  → Gespeichert in SQLite (lokal)                  │  │
│  └──────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

---

## 3. Routing-Klassifikation

### 3.1 Task-Kategorien

| Kategorie | Beispiel-Prompts | Optimales Modell-Profil |
|-----------|-----------------|------------------------|
| **code_generation** | "Schreibe eine Funktion die..." | Code-optimiert (Codex, DeepSeek-Coder) |
| **code_review** | "Review diesen Code..." | Reasoning-stark (Claude, GPT-4o) |
| **creative_writing** | "Schreibe einen Blogpost..." | Kreativ (Claude, GPT-4o) |
| **quick_question** | "Was ist REST?" | Schnellstes/guenstigstes Modell |
| **analysis** | "Analysiere diese Daten..." | Reasoning-stark + langer Kontext |
| **translation** | "Uebersetze..." | Multilingual-stark |
| **summarization** | "Fasse zusammen..." | Effizientes Modell reicht |
| **conversation** | "Erzaehl mir mehr..." | Konversations-optimiert |

### 3.2 Routing-Entscheidungsmatrix

```
Routing-Score = weighted_sum(
    task_match:      0.35,  # Wie gut passt der Provider zum Task?
    cost_efficiency:  0.25,  # Kosten pro Token (normalisiert)
    latency_match:   0.20,  # Passt zur gewuenschten Geschwindigkeit?
    historical_perf:  0.20,  # Wie gut war Provider bei aehnlichen Prompts?
)
```

### 3.3 Override-Regeln (hart-codiert, kein SLM noetig)

| Regel | Aktion |
|-------|--------|
| User hat Modell manuell gewaehlt | Kein Routing, direkte Weiterleitung |
| Prompt enthaelt Bild/Datei | Nur Vision-faehige Modelle |
| Prompt >100k Tokens | Nur Long-Context Modelle |
| Provider offline | Naechstbester Provider |

---

## 4. Modell-Optionen fuer den Router

### Option A: Fine-Tuned SmolLM2-360M (Generative)

| Aspekt | Detail |
|--------|--------|
| Groesse | 360M Parameter, ~200MB GGUF |
| Inference | llama.cpp, CPU, ~8ms |
| Input | Structured Prompt (Features als Text) |
| Output | JSON: `{"provider": "claude", "confidence": 0.87, "reason": "code_review task"}` |
| Training | Unsloth, QLoRA, ~15 Min |
| Vorteil | Kann "reasoning" generieren, flexibel |
| Nachteil | Groesser, langsamer als BERT |

### Option B: Fine-Tuned BERT-Classifier (Discriminative)

| Aspekt | Detail |
|--------|--------|
| Groesse | 110M Parameter, ~50MB ONNX |
| Inference | ONNX Runtime, CPU, ~3ms |
| Input | Prompt-Text (tokenized) |
| Output | Softmax ueber Provider-Klassen |
| Training | HuggingFace PEFT (LoRA) + Transformers, ~10 Min |
| Fine-Tuning | `pip install peft` — LoRA auf Attention-Layer, ~0.5% trainierbare Parameter |
| Vorteil | Schnellster, bewaehrt fuer Classification |
| Nachteil | Kein Reasoning, fixe Anzahl Klassen |

### Option C: Hybrid (Empfohlen)

```
Stufe 1: Regelbasierter Pre-Filter (0ms)
  └─ Offensichtliche Faelle (Vision, Long-Context, User-Override)

Stufe 2: BERT-Classifier fuer Task-Kategorie (~3ms)
  └─ 8 Task-Kategorien (code, creative, analysis, ...)

Stufe 3: Scoring-Logik (regelbasiert, <1ms)
  └─ Task-Kategorie + Provider-Capabilities + Kosten + History
  └─ → Bester Provider
```

**Total: <5ms, kein Generative Model noetig fuer Phase 1.**

---

## 5. Trainingsdaten

### 5.1 Daten-Generierung

```python
# Phase 1: Claude/GPT-4 labelt Prompts
{
    "prompt": "Schreibe eine Python-Funktion die Primzahlen findet",
    "task_category": "code_generation",
    "complexity": "medium",
    "language": "de",
    "optimal_provider_profile": "code_optimized",
    "reasoning": "Code-Generierung, mittlere Komplexitaet, Code-Modell bevorzugt"
}
```

### 5.2 Datenquellen

| Quelle | Menge | Methode |
|--------|-------|---------|
| **Synthetisch (Claude-gelabelt)** | 5'000 Prompts | Diverse Task-Typen generieren + labeln |
| **Mingly Chat-History** | TBD | Bestehende Conversations retroaktiv labeln |
| **Open-Source Datasets** | 3'000 | ShareGPT, LMSYS, OpenAssistant (Task-Labels hinzufuegen) |

---

## 6. Integration in Mingly

### 6.1 Neue Komponenten

```
src/
  features/
    routing/
      ├── RoutingEngine.ts          # Haupt-Orchestrator
      ├── FeatureExtractor.ts       # Prompt → Features
      ├── TaskClassifier.ts         # BERT/ONNX Inference
      ├── ProviderScorer.ts         # Features + History → Score
      ├── RoutingHistory.ts         # SQLite-basiertes Logging
      └── RoutingExplainer.ts       # UI: "Warum dieses Modell?"
    routing/models/
      └── task-classifier.onnx      # Eingebettetes Modell (~50MB)
```

### 6.2 UI-Integration

| Element | Beschreibung |
|---------|-------------|
| **Auto-Select Badge** | Zeigt "Auto: Claude (93% Confidence)" in Modell-Selector |
| **Routing Insight** | Tooltip: "Code-Review erkannt → Claude empfohlen (beste Reasoning)" |
| **Cost Savings Counter** | "Diesen Monat gespart: $12.40 durch intelligentes Routing" |
| **Override** | Kunde kann jederzeit manuell ueberschreiben |
| **Routing Settings** | Prioritaet setzen: Kosten vs. Qualitaet vs. Geschwindigkeit |

### 6.3 Orchestrator-Integration (bestehendes Feature)

```typescript
// Bestehender DelegationProposalDialog erweitern
interface RoutingDecision {
  provider: string;
  model: string;
  confidence: number;
  taskCategory: TaskCategory;
  reasoning: string;
  estimatedCost: number;
  estimatedLatency: number;
  alternatives: Alternative[];  // Top 3
}
```

---

## 7. Feedback-Loop

### 7.1 Implizite Signale

| Signal | Interpretation |
|--------|---------------|
| User akzeptiert Antwort | Positive Bewertung fuer Provider+Task |
| User regeneriert | Negative Bewertung |
| User wechselt manuell Provider | Router-Fehler → Lern-Signal |
| User editiert Antwort stark | Qualitaets-Problem |
| Schnelle Follow-up-Frage | Konversation geht weiter → OK |

### 7.2 Re-Training Zyklus

```
Alle 30 Tage (oder 1000 neue Datenpunkte):
  1. Neue Feedback-Daten aus SQLite exportieren
  2. Labels generieren (implizite Signale → Scores)
  3. BERT-Classifier re-trainen (inkrementell)
  4. Neues ONNX-Modell in Mingly updaten (Auto-Update)
```

---

## 8. Phasen-Plan

### Phase 0: Daten-Sammlung (ab sofort, passiv)
- [ ] Routing-relevante Features in Mingly Chat-History loggen
- [ ] Task-Kategorie-Heuristik (regelbasiert) als Baseline

### Phase 1: Regelbasiertes Routing (v0.7-alpha)
- [ ] Feature Extractor + Provider Scorer (ohne ML)
- [ ] UI: Auto-Select Badge + Override
- [ ] Kosten-Tracking pro Provider

### Phase 2: BERT-Classifier (v0.7-beta)
- [ ] Trainingsdaten generieren (5k Prompts)
- [ ] BERT fine-tunen, ONNX exportieren
- [ ] In Electron-App einbetten
- [ ] A/B Test: Rule-Based vs. ML-Routing

### Phase 3: Feedback-Loop (v0.7-stable)
- [ ] Implizite Signale sammeln
- [ ] Re-Training Pipeline
- [ ] Auto-Update Mechanismus

---

## 9. Risiken

| Risiko | Mitigation |
|--------|-----------|
| ONNX Runtime in Electron? | Tested: onnxruntime-node funktioniert, ~50MB Bundle-Size |
| Kunden haben nur 1 Provider | Router deaktiviert sich automatisch, kein Overhead |
| Router waehlt falsches Modell | Immer Override moeglich, Feedback korrigiert |
| Bundle-Size +50MB | Akzeptabel fuer Desktop-App, optional downloadbar |
| Privacy: Prompts fuer Training? | Alles lokal, kein Cloud-Upload, SQLite auf Kunden-Rechner |

---

*Ref: SLM-STRATEGY-DIGITAL-OPUA.md (Parent-Dokument)*
*Ref: ~/mingly/docs/STRATEGY.md (Mingly Gesamtstrategie)*
