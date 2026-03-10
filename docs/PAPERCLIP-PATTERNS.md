# Paperclip Patterns -- Mingly

> Patterns aus [Paperclip](https://github.com/Baldri/paperclip) extrahiert und auf Mingly adaptiert (2026-03-10).
> Alle Implementierungen nutzen SQLite (sql.js) als Storage-Backend und das Singleton-Pattern fuer globalen Zugriff.

## Uebersicht

| # | Pattern | Phase | Dateien | Status |
|---|---------|-------|---------|--------|
| 1 | Provider HealthCheck | 2.1 | `health-check-types.ts`, 4 Client-Dateien, `client-manager.ts` | Implementiert |
| 2 | Cost Tracking Enhancement | 2.2 | `tracking-engine.ts`, `cost-calculator.ts`, `llm-cost-table.json`, `budget-manager.ts` | Implementiert |
| 3 | Session State Persistence | 2.3 | `session-state.ts`, Migration 7 | Implementiert |
| 4 | Activity Logger | 4.1 | `audit/activity-logger.ts`, `audit/types.ts`, Migration 8 | Implementiert |
| 5 | Shared Cost Table | 4.2 | `cost-calculator.ts`, `llm-cost-table.json` | Implementiert |

---

## 1. Provider HealthCheck (Phase 2.1)

### Problem

Vor dem HealthCheck-Pattern gab es keine strukturierte Moeglichkeit, die Konnektivitaet und den Status eines LLM-Providers zu ueberpruefen, bevor Nachrichten gesendet werden. `validateApiKey()` lieferte nur ein boolean -- keine Details ueber die Art des Fehlers (Auth, Rate-Limiting, Netzwerk).

### Loesung

Jeder LLM-Client implementiert eine optionale `healthCheck()` Methode, die ein strukturiertes `ProviderHealthCheck`-Objekt zurueckgibt. Der `LLMClientManager` bietet `healthCheckAll()` an, das alle registrierten Provider durchlaeuft -- inklusive Fallback auf `validateApiKey()` fuer Provider ohne eigene Implementierung.

### Dateien

| Datei | Pfad | Beschreibung |
|-------|------|-------------|
| `health-check-types.ts` | `src/main/llm-clients/health-check-types.ts` | Interface-Definitionen |
| `client-manager.ts` | `src/main/llm-clients/client-manager.ts` | `healthCheckAll()` Orchestrierung |
| `anthropic-client.ts` | `src/main/llm-clients/anthropic-client.ts` | Anthropic-spezifischer Check |
| `openai-client.ts` | `src/main/llm-clients/openai-client.ts` | OpenAI-spezifischer Check |
| `ollama-client.ts` | `src/main/llm-clients/ollama-client.ts` | Ollama-spezifischer Check |
| `google-client.ts` | `src/main/llm-clients/google-client.ts` | Google-spezifischer Check |

### Interfaces

```typescript
interface ProviderHealthCheck {
  provider: string
  status: 'pass' | 'warn' | 'fail'
  checks: HealthCheckItem[]
  testedAt: string
  latencyMs: number
}

interface HealthCheckItem {
  code: string
  level: 'info' | 'warn' | 'error'
  message: string
  detail?: string | null
}
```

Das `healthCheck()` ist als optionale Methode auf dem `LLMClient` Interface definiert:

```typescript
interface LLMClient {
  // ... andere Methoden
  healthCheck?(): Promise<ProviderHealthCheck>
}
```

### Verwendung

```typescript
import { getClientManager } from './llm-clients/client-manager'

const manager = getClientManager()
const results = await manager.healthCheckAll()

// results ist ein Array von ProviderHealthCheck-Objekten
for (const result of results) {
  console.log(`${result.provider}: ${result.status} (${result.latencyMs}ms)`)
  for (const check of result.checks) {
    console.log(`  [${check.level}] ${check.code}: ${check.message}`)
  }
}
```

`healthCheckAll()` ueberspringt den `local`-Alias (Duplikat von `ollama`) und faengt Exceptions ab, die ein einzelner Provider werfen koennte -- der Rest wird trotzdem geprueft.

### Provider-spezifische Checks

| Provider | Methode | Pruefschritte | Status-Codes |
|----------|---------|--------------|-------------|
| **Anthropic** | `messages.create()` mit `claude-3-haiku` + `max_tokens: 5` | 1. API Key vorhanden? 2. API erreichbar? 3. Verfuegbare Modelle | `api_key_missing`, `api_key_set`, `api_reachable`, `api_auth_failed`, `api_rate_limited`, `api_unreachable`, `models_available` |
| **OpenAI** | `models.list()` | 1. API Key vorhanden? 2. Modell-Liste abrufbar? 3. Anzahl Modelle | `api_key_missing`, `api_key_set`, `api_reachable`, `api_auth_failed`, `api_rate_limited`, `api_unreachable`, `models_available` |
| **Ollama** | `GET /api/version` + `GET /api/tags` | 1. Server laeuft? (inkl. Versionsnummer) 2. Modelle installiert? | `server_running`, `server_error`, `server_unreachable`, `models_loaded`, `no_models`, `tags_error` |
| **Google** | `generateContent('ping')` mit `gemini-pro` | 1. API Key vorhanden? 2. API erreichbar? 3. Konfigurierte Modelle | `api_key_missing`, `api_key_set`, `api_reachable`, `api_auth_failed`, `api_rate_limited`, `api_unreachable`, `models_available` |

Alle Provider unterscheiden bei Fehlern zwischen Auth-Problemen (`fail`), Rate-Limiting (`warn`) und Netzwerk-Fehlern (`fail`).

---

## 2. Cost Tracking Enhancement (Phase 2.2)

### Problem

1. Kein Unterschied zwischen kostenpflichtigen API-Calls und kostenlosen lokalen Modellen
2. Keine Aggregation von Kosten auf Konversations-Ebene
3. Budget-Enforcement war optional und nicht standardmaessig aktiv

### Loesung

- Neues `billingType`-Feld (`'api' | 'subscription' | 'free'`) in `tracking_events`
- SQL-View `conversation_costs` fuer Kosten-Aggregation pro Konversation
- Mandatory Budget-Check im `SEND_MESSAGE`-Handler vor teuren RAG/MCP-Operationen

### Dateien

| Datei | Pfad | Beschreibung |
|-------|------|-------------|
| `tracking-engine.ts` | `src/main/tracking/tracking-engine.ts` | `billingType`-Feld, `getConversationCosts()` |
| `budget-manager.ts` | `src/main/tracking/budget-manager.ts` | Budget-Limits pro Provider, Auto-Fallback |
| `database/index.ts` | `src/main/database/index.ts` | Migration 6: Schema-Erweiterungen |
| `ipc-handlers.ts` | `src/main/ipc-handlers.ts` | Mandatory Budget-Check Schritt 3 |

### BillingType-Bestimmung

Die `determineBillingType()`-Methode im `TrackingEngine` setzt den Typ automatisch:

```typescript
type BillingType = 'api' | 'subscription' | 'free'

private determineBillingType(provider: string): BillingType {
  const freeProviders = ['ollama', 'local']
  return freeProviders.includes(provider) ? 'free' : 'api'
}
```

Der `billingType` kann auch explizit uebergeben werden (z.B. fuer Subscription-basierte Provider):

```typescript
trackingEngine.recordEvent({
  conversationId: '...',
  provider: 'openai',
  model: 'gpt-4',
  // ... andere Felder
  billingType: 'subscription'  // Ueberschreibt die automatische Erkennung
})
```

### Conversation Costs View

Die `conversation_costs`-View aggregiert alle Tracking-Events pro Konversation:

```sql
CREATE VIEW conversation_costs AS
SELECT
  conversation_id,
  SUM(input_tokens) as total_input_tokens,
  SUM(output_tokens) as total_output_tokens,
  SUM(total_tokens) as total_tokens,
  SUM(total_cost) as total_cost,
  COUNT(*) as message_count,
  MIN(created_at) as first_message,
  MAX(created_at) as last_message
FROM tracking_events
GROUP BY conversation_id
```

Abfrage ueber den TrackingEngine:

```typescript
const costs = trackingEngine.getConversationCosts('conv_abc123')
// { conversationId, totalInputTokens, totalOutputTokens, totalTokens,
//   totalCost, messageCount, firstMessage, lastMessage }
```

### Mandatory Budget-Check

Im `SEND_MESSAGE`-Handler (Schritt 3) wird der Budget-Check **vor** allen teuren Operationen (RAG, MCP) ausgefuehrt:

```typescript
// 3. Budget enforcement (MANDATORY)
const budgetMgr = getBudgetManager()
const budgetCheck = budgetMgr.checkBudget(provider)
if (!budgetCheck.allowed) {
  if (budgetCheck.fallbackProvider) {
    // Silent fallback -- Provider wechseln
    provider = budgetCheck.fallbackProvider
  } else {
    // Kein Fallback -- Request blockieren
    throw new Error(budgetCheck.reason)
  }
}
```

Der `BudgetManager` prueft:
1. Globales Monatslimit (Default: $50)
2. Provider-spezifisches Limit (Default: Anthropic $25, OpenAI $25, Google $10)
3. Optional: Auto-Fallback auf anderen Provider, wenn Budget ueberschritten

### Schema-Aenderungen (Migration 6)

```sql
-- Neues Feld fuer Abrechnungstyp
ALTER TABLE tracking_events ADD COLUMN billing_type TEXT NOT NULL DEFAULT 'api'

-- Aggregations-View fuer Kosten pro Konversation
CREATE VIEW conversation_costs AS
SELECT
  conversation_id,
  SUM(input_tokens) as total_input_tokens,
  SUM(output_tokens) as total_output_tokens,
  SUM(total_tokens) as total_tokens,
  SUM(total_cost) as total_cost,
  COUNT(*) as message_count,
  MIN(created_at) as first_message,
  MAX(created_at) as last_message
FROM tracking_events
GROUP BY conversation_id
```

---

## 3. Session State Persistence (Phase 2.3)

### Problem

Provider-spezifischer Session-State (z.B. OpenAI Thread IDs, Continuity Tokens) ging bei App-Neustart verloren. Es gab keine Moeglichkeit, eine Konversation mit dem gleichen Kontext fortzusetzen.

### Loesung

Eine `conversation_sessions`-Tabelle in SQLite speichert Session-State pro Konversation/Provider-Paar. Der `ConversationSessionManager` bietet CRUD-Operationen mit automatischer Token- und Kosten-Akkumulation.

### Dateien

| Datei | Pfad | Beschreibung |
|-------|------|-------------|
| `session-state.ts` | `src/main/services/session-state.ts` | `ConversationSessionManager` Klasse |
| `database/index.ts` | `src/main/database/index.ts` | Migration 7: `conversation_sessions` Tabelle |
| `ipc-handlers.ts` | `src/main/ipc-handlers.ts` | Integration in `SEND_MESSAGE` (Schritt 9) |

### Interface

```typescript
interface ConversationSession {
  id: string
  conversationId: string
  provider: string
  model: string
  sessionParams: Record<string, unknown> | null  // Provider-spezifische Daten
  sessionDisplayId: string | null
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}
```

### Verwendung

```typescript
import { getSessionManager } from './services/session-state'

const sessionMgr = getSessionManager()

// Session holen oder erstellen (idempotent)
const session = sessionMgr.getOrCreate('conv_123', 'openai', 'gpt-4')

// Provider-spezifische Parameter speichern
sessionMgr.updateParams('conv_123', 'openai', {
  threadId: 'thread_abc',
  lastMessageId: 'msg_xyz'
})

// Token-Verbrauch akkumulieren
sessionMgr.addUsage('conv_123', 'openai', inputTokens, outputTokens, cost)

// Fehler aufzeichnen
sessionMgr.setError('conv_123', 'openai', 'Rate limit exceeded')

// Alle Sessions fuer eine Konversation abrufen
const sessions = sessionMgr.getAll('conv_123')
```

### Integration im SEND_MESSAGE Handler

Die Session-State-Persistenz erfolgt non-blocking am Ende des Handlers (Schritt 9), nach dem erfolgreichen Tracking:

```typescript
// 9. Persist session state (provider-specific continuity)
try {
  const sessionMgr = getSessionManager()
  sessionMgr.getOrCreate(conversationId, provider, model)
  sessionMgr.addUsage(conversationId, provider, inputTokens, outputTokens, totalCost)
} catch (sessionErr) {
  console.warn('Session state persistence failed (non-blocking):', sessionErr)
}
```

Bei Fehlern wird der Error auf der Session gespeichert:

```typescript
// Im Error-Handler:
getSessionManager().setError(conversationId, provider, error.message)
```

### Schema-Aenderungen (Migration 7)

```sql
CREATE TABLE conversation_sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  session_params TEXT,           -- JSON: Provider-spezifische Daten
  session_display_id TEXT,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cost REAL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(conversation_id, provider)  -- Ein Session-Record pro Konversation+Provider
)

CREATE INDEX idx_convsess_conversation
  ON conversation_sessions(conversation_id)
```

---

## 4. Activity Logger (Phase 4.1)

### Problem

Keine Audit-Trail fuer Benutzer- und System-Aktionen. Fuer Compliance (nDSG/DSGVO) und Debugging fehlte eine zentrale Protokollierung.

### Loesung

Ein SQLite-basierter `ActivityLogger`, der das shared `ActivityLogEntry`-Interface implementiert. Das Interface ist identisch in drei Projekten: Mingly (SQLite), Claude Remote (JSONL), Nexbid (Postgres).

### Dateien

| Datei | Pfad | Beschreibung |
|-------|------|-------------|
| `types.ts` | `src/main/audit/types.ts` | Shared Interface + Mingly-spezifische Actions |
| `activity-logger.ts` | `src/main/audit/activity-logger.ts` | SQLite-Implementierung |
| `database/index.ts` | `src/main/database/index.ts` | Migration 8: `activity_log` Tabelle |

### Shared Interface

Dieses Interface ist **identisch** in Mingly, Claude Remote und Nexbid. Die Backends unterscheiden sich (SQLite / JSONL / Postgres), aber die Datenstruktur bleibt gleich:

```typescript
interface ActivityLogEntry {
  id: string
  actorType: string       // z.B. 'user', 'system', 'agent'
  actorId: string         // z.B. 'local', User-ID
  action: string          // z.B. 'conversation.create', 'budget.exceeded'
  entityType: string      // z.B. 'conversation', 'provider'
  entityId: string        // z.B. Konversations-ID
  details: Record<string, unknown> | null  // Zusaetzliche Daten als JSON
  createdAt: string       // ISO 8601 Timestamp
}

interface ActivityLoggerInterface {
  log(entry: Omit<ActivityLogEntry, 'id' | 'createdAt'>): void
  query?(filter: {
    entityType?: string
    action?: string
    since?: string
    limit?: number
  }): ActivityLogEntry[]
}
```

### Mingly-spezifische Actions

```typescript
type KnownAction =
  | 'conversation.create'
  | 'conversation.delete'
  | 'message.send'
  | 'message.receive'
  | 'provider.switch'
  | 'provider.health_check'
  | 'budget.exceeded'
  | 'budget.warning'
  | 'session.create'
  | 'session.error'
```

### Verwendung

```typescript
import { getActivityLogger } from './audit/activity-logger'

const logger = getActivityLogger()

// Aktion loggen (id und createdAt werden automatisch generiert)
logger.log({
  actorType: 'user',
  actorId: 'local',
  action: 'conversation.create',
  entityType: 'conversation',
  entityId: 'conv_abc123',
  details: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }
})

// Log abfragen mit Filtern
const entries = logger.query({
  action: 'budget.exceeded',
  since: '2026-03-01T00:00:00.000Z',
  limit: 50
})
```

### Schema-Aenderungen (Migration 8)

```sql
CREATE TABLE activity_log (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT 'local',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT,              -- JSON oder NULL
  created_at TEXT NOT NULL   -- ISO 8601
)

CREATE INDEX idx_activity_log_action ON activity_log(action)
CREATE INDEX idx_activity_log_entity ON activity_log(entity_type, entity_id)
CREATE INDEX idx_activity_log_created ON activity_log(created_at)
```

---

## 5. Shared Cost Table (Phase 4.2)

### Problem

Die Kosten-Tabelle war als `COST_TABLE`-Objekt direkt im `TrackingEngine` hardcoded. Preisaenderungen erforderten Code-Aenderungen. Die gleichen Preisinformationen wurden in Claude Remote dupliziert.

### Loesung

Eine externe JSON-Datei (`llm-cost-table.json`) als Single Source of Truth fuer Modell-Preise. Ein separates `cost-calculator.ts`-Modul laedt die Datei und stellt die Berechnungsfunktionen bereit. Die gleiche JSON-Datei wird in Mingly und Claude Remote verwendet.

### Dateien

| Datei | Pfad | Beschreibung |
|-------|------|-------------|
| `llm-cost-table.json` | `src/main/tracking/llm-cost-table.json` | Preis-Daten (USD per 1M Tokens) |
| `cost-calculator.ts` | `src/main/tracking/cost-calculator.ts` | Lade-Logik, `calculateCost()`, `getCostTable()` |
| `tracking-engine.ts` | `src/main/tracking/tracking-engine.ts` | Delegiert an `cost-calculator` |

### JSON-Struktur

Die Datei ist nach Provider gruppiert. Meta-Felder beginnen mit `$` oder `_` und werden beim Laden ignoriert:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "_version": "2026-03-10",
  "_description": "LLM provider pricing in USD per 1M tokens.",
  "anthropic": {
    "claude-3-5-sonnet-20241022": { "input": 3, "output": 15 }
  },
  "openai": {
    "gpt-4o": { "input": 2.5, "output": 10 }
  }
}
```

### Verwendung

**Neues Modell hinzufuegen:** Einfach einen Eintrag in `llm-cost-table.json` unter dem passenden Provider ergaenzen:

```json
"anthropic": {
  "claude-4-sonnet-20260501": { "input": 5, "output": 25 }
}
```

**Kosten berechnen:**

```typescript
import { calculateCost, hasModelPricing, getCostTable } from './tracking/cost-calculator'

// Kosten fuer einen API-Call berechnen
const { inputCost, outputCost, totalCost } = calculateCost(
  'claude-3-5-sonnet-20241022',
  1500,   // Input Tokens
  500     // Output Tokens
)
// inputCost  = (1500 / 1_000_000) * 3   = 0.0045
// outputCost = (500  / 1_000_000) * 15  = 0.0075
// totalCost  = 0.012

// Pruefen ob ein Modell bekannt ist
const known = hasModelPricing('gpt-4o')  // true

// Gesamte Tabelle abrufen
const table = getCostTable()
```

**Intern:** Der `TrackingEngine` delegiert an `cost-calculator`:

```typescript
import { calculateCost as sharedCalculateCost } from './cost-calculator'

calculateCost(model, inputTokens, outputTokens) {
  return sharedCalculateCost(model, inputTokens, outputTokens)
}
```

Unbekannte Modelle liefern `{ inputCost: 0, outputCost: 0, totalCost: 0 }` zurueck -- kein Fehler, keine Blockade.

### Unterstuetzte Modelle

| Provider | Modell | Input ($/1M) | Output ($/1M) |
|----------|--------|-------------|---------------|
| **Anthropic** | claude-sonnet-4-20250514 | 3.00 | 15.00 |
| | claude-opus-4-20250514 | 15.00 | 75.00 |
| | claude-3-5-sonnet-20241022 | 3.00 | 15.00 |
| | claude-3-5-haiku-20241022 | 0.80 | 4.00 |
| | claude-3-opus-20240229 | 15.00 | 75.00 |
| | claude-3-sonnet-20240229 | 3.00 | 15.00 |
| | claude-3-haiku-20240307 | 0.25 | 1.25 |
| **OpenAI** | gpt-4-turbo-preview | 10.00 | 30.00 |
| | gpt-4-turbo | 10.00 | 30.00 |
| | gpt-4 | 30.00 | 60.00 |
| | gpt-4o | 2.50 | 10.00 |
| | gpt-4o-mini | 0.15 | 0.60 |
| | gpt-3.5-turbo | 0.50 | 1.50 |
| | gpt-3.5-turbo-16k | 3.00 | 4.00 |
| **Google** | gemini-pro | 0.50 | 1.50 |
| | gemini-1.5-pro | 3.50 | 10.50 |
| | gemini-1.5-flash | 0.075 | 0.30 |
| | gemini-2.0-flash | 0.10 | 0.40 |
| | gemini-ultra | 7.00 | 21.00 |

Stand: 2026-03-10. Preise als USD pro 1 Million Tokens.

---

## Architektur-Entscheidungen

### Warum SQLite fuer alles?

Mingly ist eine Desktop-App. Alle Daten bleiben lokal auf dem Geraet des Users -- kein Server, kein Cloud-Storage. SQLite (via sql.js/WASM) bietet:
- Zero-Config: Kein externer Datenbankserver noetig
- Portabilitaet: Eine Datei (`mingly.db`), die mit der App mitwandert
- DSGVO/nDSG-Konformitaet: Daten verlassen nie das Geraet
- Performance: Fuer Desktop-Workloads (einzelner User, tausende Eintraege) voellig ausreichend

### Warum Singleton-Pattern?

Alle Manager-Klassen (`TrackingEngine`, `ConversationSessionManager`, `ActivityLogger`, `BudgetManager`, `LLMClientManager`) verwenden das Singleton-Pattern mit exportierter `getInstance()`-Funktion:

```typescript
let instance: TrackingEngine | null = null
export function getTrackingEngine(): TrackingEngine {
  if (!instance) {
    instance = new TrackingEngine()
  }
  return instance
}
```

Gruende:
- In Electron's Main Process gibt es nur einen Thread -- kein Concurrency-Problem
- Konsistenter Zustand ueber alle IPC-Handler hinweg
- Einfachheit: Kein DI-Framework noetig
- Lazy Initialization: Instanzen werden erst bei Bedarf erstellt

### Warum Non-Blocking Session State?

Die Session-State-Persistenz im `SEND_MESSAGE`-Handler ist in ein `try/catch` gewickelt und loggt Fehler nur als Warning:

```typescript
try {
  sessionMgr.addUsage(...)
} catch (sessionErr) {
  console.warn('Session state persistence failed (non-blocking):', sessionErr)
}
```

Die Message-Zustellung an den User darf nie durch einen Session-State-Fehler blockiert werden. Der User hat bereits die Antwort erhalten -- Session-State ist ein Nice-to-Have, kein Showstopper.

### Warum Mandatory Budget Check?

Der Budget-Check ist **nicht** optional. Im `SEND_MESSAGE`-Handler wird er in Schritt 3 ausgefuehrt -- **vor** den teuren RAG- und MCP-Operationen (Schritte 4b, 4c). So werden keine externen API-Calls gemacht, wenn das Budget bereits ueberschritten ist.

Ablauf:
1. Budget noch nicht erschoepft: `{ allowed: true }` -- normal weiter
2. Budget erschoepft + Fallback konfiguriert: Silent Provider-Switch (z.B. Anthropic -> Ollama)
3. Budget erschoepft + kein Fallback: Request wird mit Error blockiert

Der Budget-Manager liest die Konfiguration aus einer separaten JSON-Datei (`budget-config.json` im userData-Verzeichnis), nicht aus der SQLite-Datenbank. So kann der User die Limits auch manuell editieren.
