# Mingly v0.7.0 Website + Release — Implementation Plan

> **STATUS: UMGESETZT (2026-03-17).** Release v0.7.0 "Swiss AI Privacy" publiziert (GitHub Release 2026-03-17), Website-Content live auf mingly.ch (mingly-website Commit 02e6d22), Preprocessor-Fixes in v0.7.0 enthalten. Verifiziert gegen Live-Site, App und GitHub-Release am 2026-07-02; Checkboxen nachtraeglich abgehakt. Bekannte Restluecke (statische SEO-/og-Tags in index.html) wird separat im mingly-website-Repo gefixt.

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update mingly.ch website content to reflect v0.7.0 "Swiss AI Privacy" release, bump app version, add MEDIUM backlog preprocessor fixes, build & publish release.

**Architecture:** i18n-driven website (DE+EN translation files), Vite+React+Tailwind on Vercel. App uses electron-builder for distribution via GitHub Releases.

**Tech Stack:** TypeScript, React, Tailwind, Vite, Electron, electron-builder, Vitest

---

## Chunk 1: Website Content Updates

### Task 1: Update Hero Section (DE)

**Files:**
- Modify: `~/projects/mingly-website/src/i18n/de.ts:3-27`

- [x] **Step 1: Update meta title + description**

Change meta.title from "Dein KI-Chat. Deine Regeln." to Swiss AI Privacy focus:
```typescript
meta: {
  title: "Mingly – Swiss AI Privacy | KI nutzen, Daten behalten",
  description:
    "Mingly ist der Desktop AI Client mit automatischer On-Device PII-Protection. Multi-LLM, Dokumentenkontext, Wissensdatenbank, intelligentes Routing. Open Source, Swiss Made, nDSG/DSGVO-konform.",
  keywords:
    "Swiss AI Privacy, KI Chat, AI Desktop, Open Source, PII Detection, lokale KI, Datenschutz, Wissensdatenbank, RAG, LLM Router, Ollama, Claude, GPT, Gemini, Schweiz, nDSG, DSGVO",
},
```

- [x] **Step 2: Update hero badge, title, subtitle, tags**

```typescript
hero: {
  badge: "Swiss AI Privacy · On-Device · nDSG/DSGVO 🇨🇭",
  title1: "Swiss AI Privacy.",
  title2: "KI nutzen, Daten behalten.",
  subtitle:
    "Multi-LLM Desktop Client mit automatischer On-Device PII-Protection. Sensible Daten werden erkannt und bleiben lokal — bevor sie an eine KI gesendet werden.",
  downloadBtn: "Download",
  sourceBtn: "Quellcode auf GitHub",
  tags: ["🔒 OS-Keychain", "🇨🇭 nDSG / DSGVO", "⚡ Offline-fähig", "🧠 On-Device NER"],
},
```

- [x] **Step 3: Verify file saves without syntax errors**

Run: `cd ~/projects/mingly-website && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors related to de.ts

- [x] **Step 4: Commit**

```bash
cd ~/projects/mingly-website
git add src/i18n/de.ts
git commit -m "feat(i18n): update DE hero + meta for Swiss AI Privacy v0.7.0"
```

---

### Task 2: Update Hero Section (EN)

**Files:**
- Modify: `~/projects/mingly-website/src/i18n/en.ts:3-27`

- [x] **Step 1: Update meta title + description (EN mirror)**

```typescript
meta: {
  title: "Mingly – Swiss AI Privacy | Use AI, Keep Your Data",
  description:
    "Mingly is the desktop AI client with automatic on-device PII protection. Multi-LLM, document context, knowledge base, intelligent routing. Open Source, Swiss Made, GDPR/nDSG compliant.",
  keywords:
    "Swiss AI Privacy, AI Chat, AI Desktop, Open Source, PII Detection, local AI, privacy, knowledge base, RAG, LLM Router, Ollama, Claude, GPT, Gemini, Switzerland, GDPR, nDSG",
},
```

- [x] **Step 2: Update hero badge, title, subtitle, tags (EN mirror)**

```typescript
hero: {
  badge: "Swiss AI Privacy · On-Device · GDPR/nDSG 🇨🇭",
  title1: "Swiss AI Privacy.",
  title2: "Use AI, Keep Your Data.",
  subtitle:
    "Multi-LLM desktop client with automatic on-device PII protection. Sensitive data is detected and stays local — before it reaches any AI.",
  downloadBtn: "Download",
  sourceBtn: "Source code on GitHub",
  tags: ["🔒 OS Keychain", "🇨🇭 GDPR / nDSG", "⚡ Offline-capable", "🧠 On-Device NER"],
},
```

- [x] **Step 3: Verify + Commit**

```bash
cd ~/projects/mingly-website
npx tsc --noEmit 2>&1 | head -20
git add src/i18n/en.ts
git commit -m "feat(i18n): update EN hero + meta for Swiss AI Privacy v0.7.0"
```

---

### Task 3: Reorder Features + Update Tags (DE)

**Files:**
- Modify: `~/projects/mingly-website/src/i18n/de.ts:53-129`

- [x] **Step 1: Reorder features array — Swiss AI Privacy first, On-Device NER second**

New order (10 items):
1. Swiss AI Privacy — tag: "Core", tagColor: C.rose
2. On-Device NER (NEW) — tag: "Core", tagColor: C.rose
3. Smart LLM Routing — tag: "Smart", tagColor: C.emerald
4. Dokumentenkontext — tag: "Free", tagColor: C.emerald
5. Wissensdatenbank (RAG) — tag: "Pro", tagColor: C.indigoLight
6. Tool-Anbindung (MCP) — tag: "Extensible", tagColor: C.indigoLight
7. Context Engineering — tag: "Smart", tagColor: C.indigo (remove "v0.5" tag)
8. Alle KI-Modelle, ein Chat — tag: "Chat", tagColor: C.indigo
9. Multi-Backend Routing — tag: "Network", tagColor: C.emerald
10. Kosten & Nutzung im Blick — tag: "Smart", tagColor: C.amber
11. Maximaler Datenschutz — tag: "Security", tagColor: C.rose

```typescript
items: [
  {
    icon: "🇨🇭",
    title: "Swiss AI Privacy",
    desc: "On-Device PII-Erkennung (Gesundheit, AHV, IBAN, Namen, Adressen) mit 4 Privacy-Modi: Shield, Vault, Transparent, Local Only. Sensible Daten bleiben lokal. nDSG-konform.",
    tag: "Core",
    tagColor: C.rose,
  },
  {
    icon: "🧠",
    title: "On-Device NER",
    desc: "piiranha-v1 (400M Parameter) erkennt 17 PII-Kategorien direkt auf deinem Gerät — unter 50ms, ohne Cloud. 3-Layer Pipeline: Regex + Swiss Patterns + Neural Network.",
    tag: "Core",
    tagColor: C.rose,
  },
  {
    icon: "🔀",
    title: "Smart LLM Routing",
    desc: "Mingly wählt automatisch das beste Modell — lokal, im Netzwerk oder aus der Cloud. Basierend auf Thema, Kosten und Sensibilität deiner Daten.",
    tag: "Smart",
    tagColor: C.emerald,
  },
  {
    icon: "📄",
    title: "Dokumentenkontext",
    desc: "Lade Dokumente im Chat hoch oder gib Ordner frei — die KI bezieht deine Dateien in die Antworten ein. Kostenlos für alle.",
    tag: "Free",
    tagColor: C.emerald,
  },
  {
    icon: "📚",
    title: "Wissensdatenbank (RAG)",
    desc: "Indexiere tausende Dokumente mit Vektordatenbanken. Semantische Suche, automatische Kontext-Injektion und Quellenangaben.",
    tag: "Pro",
    tagColor: C.indigoLight,
  },
  {
    icon: "🔌",
    title: "Tool-Anbindung (MCP)",
    desc: "Verbinde Mingly mit deinen Tools: Dateisystem, Datenbanken, Web-Suche und eigene Workflows — alles erweiterbar.",
    tag: "Extensible",
    tagColor: C.indigoLight,
  },
  {
    icon: "🧠",
    title: "Context Engineering",
    desc: "Fortschritts-Tracking, Fehler-Erhaltung und KV-Cache-Optimierung halten Agenten bei langen Aufgaben auf Kurs — inspiriert von Manus AI.",
    tag: "Smart",
    tagColor: C.indigo,
  },
  {
    icon: "🤖",
    title: "Alle KI-Modelle, ein Chat",
    desc: "Claude, GPT, Gemini, Llama und mehr — nahtlos wechseln, Antworten vergleichen, Gespräche fortführen.",
    tag: "Chat",
    tagColor: C.indigo,
  },
  {
    icon: "🌐",
    title: "Multi-Backend Routing",
    desc: "Verbinde mehrere Ollama-Instanzen im lokalen Netzwerk. Mingly verteilt Anfragen automatisch auf die schnellsten und am wenigsten ausgelasteten Server.",
    tag: "Network",
    tagColor: C.emerald,
  },
  {
    icon: "📊",
    title: "Kosten & Nutzung im Blick",
    desc: "Sieh genau, was jede Anfrage kostet. Setze monatliche Budgets, und Mingly warnt dich, bevor das Limit erreicht wird.",
    tag: "Smart",
    tagColor: C.amber,
  },
  {
    icon: "🔐",
    title: "Maximaler Datenschutz",
    desc: "Schlüssel im OS-Keychain, keine Telemetrie, DSGVO/DSG-konform. Circuit Breaker schützt vor Kostenexplosion, Canary Tokens erkennen System-Prompt-Leaks.",
    tag: "Security",
    tagColor: C.rose,
  },
],
```

- [x] **Step 2: Verify + Commit**

```bash
cd ~/projects/mingly-website && npx tsc --noEmit 2>&1 | head -20
git add src/i18n/de.ts
git commit -m "feat(i18n): reorder DE features — Swiss AI Privacy + NER first"
```

---

### Task 4: Reorder Features + Update Tags (EN)

**Files:**
- Modify: `~/projects/mingly-website/src/i18n/en.ts:53-128`

- [x] **Step 1: Mirror DE feature reorder to EN**

Same structure as Task 3 but in English:
1. Swiss AI Privacy: "On-device PII detection (health data, AHV, IBAN, names, addresses) with 4 privacy modes: Shield, Vault, Transparent, Local Only. Sensitive data stays local. nDSG compliant."
2. On-Device NER: "piiranha-v1 (400M parameters) detects 17 PII categories directly on your device — under 50ms, no cloud. 3-layer pipeline: Regex + Swiss Patterns + Neural Network."
3-11: Same reorder as DE, English text stays same, tags updated (remove "v0.7", "v0.5").

- [x] **Step 2: Verify + Commit**

```bash
cd ~/projects/mingly-website && npx tsc --noEmit 2>&1 | head -20
git add src/i18n/en.ts
git commit -m "feat(i18n): reorder EN features — Swiss AI Privacy + NER first"
```

---

### Task 5: Update Pricing Privacy Messaging (DE + EN)

**Files:**
- Modify: `~/projects/mingly-website/src/i18n/de.ts:384-480`
- Modify: `~/projects/mingly-website/src/i18n/en.ts:379-474`

- [x] **Step 1: Update DE pricing tiers with privacy messaging**

Free tier features — replace list:
```typescript
features: [
  "Lokale Modelle (Ollama)",
  "Dokumentenkontext (Uploads & Ordner)",
  "3 Gespräche pro Tag (Cloud)",
  "Swiss AI Privacy (volle PII-Protection)",
  "On-Device NER (piiranha-v1)",
  "Circuit Breaker & Guardrails",
  "Community-Support",
],
```

Pro tier — add after "Alles in Free, plus:":
```typescript
features: [
  "Alles in Free, plus:",
  "Cloud-APIs (Claude, GPT, Gemini)",
  "Unbegrenzte Gespräche",
  "4 Privacy-Modi (Shield/Vault/Transparent/Local Only)",
  "Wissensdatenbank (RAG)",
  "Datenklassifikation & Smart Routing",
  "Prompt-Vorlagen & -Verwaltung",
  "Multimodal (Bilder & Vision)",
  "Agentic Mode (ReAct + Tools)",
  "Modellvergleich mit Agenten",
  "Parallele Subagenten",
  "Context Engineering",
  "Multi-Backend Load Balancing",
  "Export (Markdown, PDF, JSON)",
  "Auto-Updates",
],
```

Team tier — add privacy audit:
```typescript
features: [
  "Alles in Pro, plus:",
  "Team-Arbeitsräume",
  "Geteilte Wissensbasen",
  "Privacy-Audit-Log",
  "Rollenverwaltung (RBAC)",
  "Nutzungs-Tracking pro User",
  "Audit-Logs & Canary Tokens",
  "SSO (OAuth / SAML)",
  "Priority-Support",
],
```

Enterprise tier — add compliance:
```typescript
features: [
  "Alles in Team, plus:",
  "On-Premise / Air-Gap",
  "nDSG/DSGVO Compliance-Dashboard",
  "Custom PII-Regeln",
  "LDAP / Active Directory",
  "Dedizierter Support & SLA",
  "Custom-Integrationen",
  "White-Label-Option",
],
```

- [x] **Step 2: Mirror to EN pricing**

Same changes in English translations.

- [x] **Step 3: Verify + Commit**

```bash
cd ~/projects/mingly-website && npx tsc --noEmit 2>&1 | head -20
git add src/i18n/de.ts src/i18n/en.ts
git commit -m "feat(i18n): update pricing tiers with privacy messaging (DE+EN)"
```

---

### Task 6: Reorder Use Cases + Add Lawyer (DE)

**Files:**
- Modify: `~/projects/mingly-website/src/i18n/de.ts:130-235`

- [x] **Step 1: Reorder use cases — Privacy-first order**

New order:
1. Hausarztpraxis (was #4) — already privacy-focused, stays same
2. Steuerberatung (was #1) — stays same
3. Anwaltskanzlei (NEW) — replaces Elektro Brunner
4. Marketing-Agentur (was #3) — add privacy angle

Replace Elektro Brunner (item[1]) with Anwaltskanzlei:
```typescript
{
  icon: "⚖️",
  color: C.indigoLight,
  badge: "KMU · Recht",
  meta: "6 Mitarbeitende · Hybrid-Modus",
  title: "Anwaltskanzlei Winterthur: Vertragsentwürfe und Recherche mit KI",
  desc: "Eine Wirtschaftskanzlei nutzt KI für Vertragsanalyse, Recherche und Mandantenkorrespondenz — ohne Daten in die Cloud zu senden.",
  toggleOpen: "Wie nutzen sie Mingly?",
  toggleClose: "Weniger anzeigen",
  details: [
    {
      label: "🔒 SWISS AI PRIVACY",
      text: "Mingly erkennt Mandantennamen, AHV-Nummern und Adressen automatisch und anonymisiert sie vor Cloud-Anfragen. Anwaltsgeheimnis gewahrt.",
    },
    {
      label: "📚 WISSENSDATENBANK",
      text: "OR, ZGB, Bundesgerichtsentscheide und interne Muster als RAG-Wissensbasis. Mingly zitiert mit Fundstelle.",
    },
    {
      label: "📝 VERTRÄGE",
      text: "Entwurf-Prompts mit Vertragsvorlagen kombiniert. Mingly generiert Erstversionen, die der Anwalt prüft und anpasst.",
    },
  ],
  metrics: ["⏱ Recherche: 60 Min. → 15 Min.", "🔒 Anwaltsgeheimnis gewahrt", "📄 500+ Dokumente indexiert"],
},
```

Reorder: [Arztpraxis, Steuerberatung, Anwaltskanzlei, Marketing-Agentur]

Update Marketing-Agentur details to add privacy angle — change first detail label:
```typescript
{
  label: "🔒 MULTI-CLIENT PRIVACY",
  text: "Jeder Kunde hat eine isolierte Wissensdatenbank. Swiss AI Privacy stellt sicher, dass Kundendaten nie an den falschen Provider gelangen.",
},
```

- [x] **Step 2: Verify + Commit**

```bash
cd ~/projects/mingly-website && npx tsc --noEmit 2>&1 | head -20
git add src/i18n/de.ts
git commit -m "feat(i18n): reorder DE use cases + add lawyer, privacy-first"
```

---

### Task 7: Reorder Use Cases + Add Lawyer (EN)

**Files:**
- Modify: `~/projects/mingly-website/src/i18n/en.ts:130-235`

- [x] **Step 1: Mirror DE use case changes to EN**

New order: [Family Practice, Tax Advisory, Law Firm (NEW), Marketing Agency]

Law Firm:
```typescript
{
  icon: "⚖️",
  color: C.indigoLight,
  badge: "SME · Legal",
  meta: "6 employees · Hybrid mode",
  title: "Law Firm Winterthur: Contract drafts and research with AI",
  desc: "A commercial law firm uses AI for contract analysis, research, and client correspondence — without sending data to the cloud.",
  toggleOpen: "How do they use Mingly?",
  toggleClose: "Show less",
  details: [
    {
      label: "🔒 SWISS AI PRIVACY",
      text: "Mingly automatically detects client names, AHV numbers, and addresses and anonymizes them before cloud requests. Attorney-client privilege maintained.",
    },
    {
      label: "📚 KNOWLEDGE BASE",
      text: "Swiss Code of Obligations, Civil Code, Federal Court decisions, and internal templates as RAG knowledge base. Mingly cites with reference.",
    },
    {
      label: "📝 CONTRACTS",
      text: "Draft prompts combined with contract templates. Mingly generates first versions that the lawyer reviews and refines.",
    },
  ],
  metrics: ["⏱ Research: 60 min → 15 min", "🔒 Attorney-client privilege", "📄 500+ docs indexed"],
},
```

Marketing Agency — update first detail:
```typescript
{
  label: "🔒 MULTI-CLIENT PRIVACY",
  text: "Each client gets an isolated knowledge base. Swiss AI Privacy ensures client data never reaches the wrong provider.",
},
```

- [x] **Step 2: Verify + Commit**

```bash
cd ~/projects/mingly-website && npx tsc --noEmit 2>&1 | head -20
git add src/i18n/en.ts
git commit -m "feat(i18n): reorder EN use cases + add lawyer, privacy-first"
```

---

### Task 8: Update FAQ Swiss AI Privacy Answer (DE + EN)

**Files:**
- Modify: `~/projects/mingly-website/src/i18n/de.ts:522-524`
- Modify: `~/projects/mingly-website/src/i18n/en.ts:517-519`

- [x] **Step 1: Expand FAQ answer with 3-Layer detail**

DE:
```typescript
{
  q: "Was ist Swiss AI Privacy?",
  a: "Mingly erkennt sensible Daten automatisch auf deinem Gerät — bevor sie an eine KI gesendet werden. Die 3-Layer-Pipeline (Regex + Swiss Patterns + piiranha-v1 NER) erkennt 17 PII-Kategorien: Namen, Adressen, AHV-Nummern, IBAN, Gesundheitsdaten und mehr. 4 Privacy-Modi (Shield, Vault, Transparent, Local Only) bestimmen, wie mit erkannten Daten umgegangen wird. Alles lokal, nDSG-konform.",
},
```

EN:
```typescript
{
  q: "What is Swiss AI Privacy?",
  a: "Mingly detects sensitive data automatically on your device — before it reaches any AI. The 3-layer pipeline (Regex + Swiss Patterns + piiranha-v1 NER) detects 17 PII categories: names, addresses, AHV numbers, IBAN, health data, and more. 4 privacy modes (Shield, Vault, Transparent, Local Only) determine how detected data is handled. Everything local, nDSG compliant.",
},
```

- [x] **Step 2: Verify + Commit**

```bash
cd ~/projects/mingly-website && npx tsc --noEmit 2>&1 | head -20
git add src/i18n/de.ts src/i18n/en.ts
git commit -m "feat(i18n): expand Swiss AI Privacy FAQ with 3-Layer detail (DE+EN)"
```

---

### Task 9: Update CTA + Footer (DE + EN)

**Files:**
- Modify: `~/projects/mingly-website/src/i18n/de.ts:531-537`
- Modify: `~/projects/mingly-website/src/i18n/en.ts:526-532`

- [x] **Step 1: Update CTA section**

DE:
```typescript
cta: {
  title1: "KI nutzen.",
  title2: "Daten behalten.",
  sub: "Swiss AI Privacy. Open Source. On-Device. Jetzt herunterladen oder den Quellcode forken.",
  downloadBtn: "Jetzt herunterladen",
  sourceBtn: "Quellcode auf GitHub →",
},
```

EN:
```typescript
cta: {
  title1: "Use AI.",
  title2: "Keep Your Data.",
  sub: "Swiss AI Privacy. Open source. On-device. Download now or fork the source code.",
  downloadBtn: "Download now",
  sourceBtn: "Source code on GitHub →",
},
```

- [x] **Step 2: Verify + Commit**

```bash
cd ~/projects/mingly-website && npx tsc --noEmit 2>&1 | head -20
git add src/i18n/de.ts src/i18n/en.ts
git commit -m "feat(i18n): update CTA for Swiss AI Privacy messaging (DE+EN)"
```

---

### Task 10: Update Version in downloads.ts

**Files:**
- Modify: `~/projects/mingly-website/src/lib/downloads.ts:1`

- [x] **Step 1: Bump version**

```typescript
export const MINGLY_VERSION = "0.7.0";
```

- [x] **Step 2: Verify URLs are correct**

Run: `cd ~/projects/mingly-website && grep -n "0.5.1" src/ -r`
Expected: No results (all references updated)

- [x] **Step 3: Commit**

```bash
cd ~/projects/mingly-website
git add src/lib/downloads.ts
git commit -m "chore: bump download version to 0.7.0"
```

---

## Chunk 2: Mingly App Updates

### Task 11: Version Bump (package.json)

**Files:**
- Modify: `~/mingly/package.json:3`

- [x] **Step 1: Bump version**

Change `"version": "0.5.1"` to `"version": "0.7.0"`

- [x] **Step 2: Commit**

```bash
cd ~/mingly
git add package.json
git commit -m "chore: bump version to 0.7.0"
```

---

### Task 12: CHANGELOG v0.7.0 Entry

**Files:**
- Modify: `~/mingly/CHANGELOG.md:1-5`

- [x] **Step 1: Add v0.7.0 entry at top**

Insert after `# Changelog` line:

```markdown
## [0.7.0] - 2026-03-17

### Added — Swiss AI Privacy (Phase 7b)
- **3-Layer PII Detection Pipeline** — Regex → Swiss Patterns → piiranha-v1 NER (400M ONNX, fp32). 17 PII-Kategorien: PERSON, EMAIL, PHONE, IBAN, AHV, CREDIT_CARD, ADDRESS, LOCATION, DATE_OF_BIRTH, PASSPORT, IP_ADDRESS, URL, ORGANIZATION, CUSTOM
- **On-Device NER** — piiranha-v1 (onnx-community/piiranha-v1-detect-personal-information-ONNX) läuft im Worker Thread, <50ms Inferenz, kein Cloud-Call
- **NER Model Manager** — Download, Status-Tracking, Cache-Management für ONNX-Modell (~1.15GB fp32)
- **4 Privacy-Modi** — Shield (anonymize before cloud), Vault (local-only for sensitive), Transparent (detect + warn), Local Only (never cloud)
- **Text Preprocessor** — Defeats evasion: Zero-Width Character Stripping, URL-Decoding, Unicode NFC, HTML-Entity Decoding, Fullwidth Normalization
- **Entity Dedup with Co-existence** — NER + Regex entities with different categories on overlapping spans are both kept (e.g., PERSON + EMAIL)
- **Privacy UI** — Settings page with model download, privacy mode selection, PII category toggles
- **Privacy IPC** — Full Electron IPC layer for privacy settings, detection, and NER model management

### Security
- **Red-Team Suite** — 143 test cases across 10 categories (encoding tricks, format embedding, language mixing, etc.)
- **3-Layer Results** — 84.9% detection rate (113/133), 0 CRITICAL failures
- **REGEX_STRUCTURAL_CATEGORIES** — EMAIL, PHONE, CREDIT_CARD, IP_ADDRESS, URL, IBAN, AHV, DATE_OF_BIRTH protected from NER override

### Technical
- 1254+ Tests, 143 Red-Team Tests
- Neue Dateien: 15+ (privacy modules, preprocessor, red-team infrastructure)
- TypeScript strict mode clean
```

- [x] **Step 2: Commit**

```bash
cd ~/mingly
git add CHANGELOG.md
git commit -m "docs: add v0.7.0 CHANGELOG entry — Swiss AI Privacy"
```

---

### Task 13: MEDIUM Backlog — HTML Entity Decoding

**Files:**
- Modify: `~/mingly/src/main/privacy/text-preprocessor.ts`
- Modify/Create: `~/mingly/tests/unit/text-preprocessor.test.ts`

- [x] **Step 1: Write failing test for HTML entity decoding**

```typescript
it('decodes HTML entities in PII-relevant characters', () => {
  const result = preprocessText('hans&#64;test&#46;ch')
  expect(result.normalized).toBe('hans@test.ch')
  expect(result.wasModified).toBe(true)
})

it('decodes named HTML entities', () => {
  const result = preprocessText('hans&commat;test&period;ch')
  expect(result.normalized).toBe('hans@test.ch')
  expect(result.wasModified).toBe(true)
})

it('preserves offset mapping through HTML entity decoding', () => {
  const result = preprocessText('a&#64;b')
  expect(result.normalized).toBe('a@b')
  // 'a' at 0 maps to original 0
  // '@' at 1 maps to original 1 (start of &#64;)
  // 'b' at 2 maps to original 6
  expect(result.toOriginalOffset(0)).toBe(0)
  expect(result.toOriginalOffset(2)).toBe(6)
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd ~/mingly && npx vitest run tests/unit/text-preprocessor.test.ts --reporter verbose 2>&1 | tail -20`
Expected: FAIL

- [x] **Step 3: Implement HTML entity decoding**

Add after URL-decode step (Step 2) and before NFC (Step 3) in `preprocessText()`:

```typescript
// Step 2b: Decode HTML entities commonly used in PII evasion
const preHtmlText = normalized
const preHtmlMap = [...offsetMap]

const htmlDecoded = decodeHtmlEntities(preHtmlText)
if (htmlDecoded.text !== preHtmlText) {
  wasModified = true
  normalized = htmlDecoded.text
  const newOffsetMap: number[] = []
  for (let ni = 0; ni < htmlDecoded.text.length; ni++) {
    const preHtmlIndex = htmlDecoded.toPreIndex(ni)
    newOffsetMap.push(preHtmlMap[preHtmlIndex] ?? preHtmlIndex)
  }
  offsetMap.length = 0
  offsetMap.push(...newOffsetMap)
}
```

Add new function:
```typescript
/** PII-relevant HTML entities */
const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&commat;': '@', '&period;': '.', '&plus;': '+',
  '&hyphen;': '-', '&dash;': '-', '&num;': '#',
  '&lpar;': '(', '&rpar;': ')',
}

function decodeHtmlEntities(text: string): {
  text: string
  toPreIndex(decodedIndex: number): number
} {
  const offsetMap: number[] = []
  let decoded = ''
  let i = 0

  while (i < text.length) {
    if (text[i] === '&') {
      // Try numeric entity: &#DD; or &#xHH;
      const numMatch = text.substring(i).match(/^&#(\d{1,4});/)
      const hexMatch = text.substring(i).match(/^&#x([0-9A-Fa-f]{1,4});/)
      // Try named entity
      let namedMatch: string | null = null
      for (const [entity, replacement] of Object.entries(HTML_ENTITY_MAP)) {
        if (text.substring(i, i + entity.length) === entity) {
          namedMatch = entity
          break
        }
      }

      if (numMatch) {
        const charCode = parseInt(numMatch[1], 10)
        if (charCode > 0 && charCode < 0x10000) {
          offsetMap.push(i)
          decoded += String.fromCharCode(charCode)
          i += numMatch[0].length
          continue
        }
      } else if (hexMatch) {
        const charCode = parseInt(hexMatch[1], 16)
        if (charCode > 0 && charCode < 0x10000) {
          offsetMap.push(i)
          decoded += String.fromCharCode(charCode)
          i += hexMatch[0].length
          continue
        }
      } else if (namedMatch) {
        offsetMap.push(i)
        decoded += HTML_ENTITY_MAP[namedMatch]
        i += namedMatch.length
        continue
      }
    }
    offsetMap.push(i)
    decoded += text[i]
    i++
  }

  return {
    text: decoded,
    toPreIndex(decodedIndex: number): number {
      return offsetMap[decodedIndex] ?? decodedIndex
    }
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd ~/mingly && npx vitest run tests/unit/text-preprocessor.test.ts --reporter verbose 2>&1 | tail -30`
Expected: PASS

- [x] **Step 5: Commit**

```bash
cd ~/mingly
git add src/main/privacy/text-preprocessor.ts tests/unit/text-preprocessor.test.ts
git commit -m "feat(privacy): add HTML entity decoding to text preprocessor"
```

---

### Task 14: MEDIUM Backlog — Fullwidth Normalization

**Files:**
- Modify: `~/mingly/src/main/privacy/text-preprocessor.ts`
- Modify: `~/mingly/tests/unit/text-preprocessor.test.ts`

- [x] **Step 1: Write failing test for fullwidth normalization**

```typescript
it('normalizes fullwidth ASCII characters', () => {
  // Fullwidth @ = U+FF20, fullwidth . = U+FF0E
  const result = preprocessText('hans\uFF20test\uFF0Ech')
  expect(result.normalized).toBe('hans@test.ch')
  expect(result.wasModified).toBe(true)
})

it('normalizes fullwidth digits', () => {
  // Fullwidth 0-9 = U+FF10-FF19
  const result = preprocessText('\uFF10\uFF17\uFF18 123 45 67')
  expect(result.normalized).toBe('078 123 45 67')
  expect(result.wasModified).toBe(true)
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd ~/mingly && npx vitest run tests/unit/text-preprocessor.test.ts --reporter verbose 2>&1 | tail -20`
Expected: FAIL

- [x] **Step 3: Implement fullwidth normalization**

Add after HTML entity step and before NFC:

```typescript
// Step 2c: Normalize fullwidth ASCII characters (U+FF01-FF5E → U+0021-007E)
const preFullwidthText = normalized
let fullwidthModified = false
let fullwidthResult = ''
for (let fi = 0; fi < preFullwidthText.length; fi++) {
  const code = preFullwidthText.charCodeAt(fi)
  if (code >= 0xFF01 && code <= 0xFF5E) {
    fullwidthResult += String.fromCharCode(code - 0xFEE0)
    fullwidthModified = true
  } else {
    fullwidthResult += preFullwidthText[fi]
  }
}
if (fullwidthModified) {
  wasModified = true
  normalized = fullwidthResult
  // Offset map stays same (1:1 character replacement)
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd ~/mingly && npx vitest run tests/unit/text-preprocessor.test.ts --reporter verbose 2>&1 | tail -30`
Expected: PASS

- [x] **Step 5: Run full test suite**

Run: `cd ~/mingly && npx vitest run 2>&1 | tail -20`
Expected: All tests pass

- [x] **Step 6: Commit**

```bash
cd ~/mingly
git add src/main/privacy/text-preprocessor.ts tests/unit/text-preprocessor.test.ts
git commit -m "feat(privacy): add fullwidth ASCII normalization to text preprocessor"
```

---

## Chunk 3: Build, Release, Deploy

### Task 15: Build Mingly Release

- [x] **Step 1: Run full test suite**

```bash
cd ~/mingly && npx vitest run 2>&1 | tail -30
```
Expected: All tests pass

- [x] **Step 2: Build macOS release**

```bash
cd ~/mingly && npm run dist:mac
```
Expected: DMG + ZIP in `dist/` directory

- [x] **Step 3: Verify build artifacts**

```bash
ls -la ~/mingly/dist/*.dmg ~/mingly/dist/*.zip 2>/dev/null
```

- [x] **Step 4: Commit any build-related changes if needed**

---

### Task 16: Create GitHub Release v0.7.0

- [x] **Step 1: Push all mingly commits**

```bash
cd ~/mingly && git push origin main
```

- [x] **Step 2: Create GitHub Release**

```bash
cd ~/mingly && gh release create v0.7.0 \
  --title "v0.7.0 — Swiss AI Privacy" \
  --notes "$(cat <<'EOF'
## Swiss AI Privacy

Mingly v0.7.0 introduces **Swiss AI Privacy** — automatic on-device PII protection.

### Highlights
- **3-Layer PII Detection**: Regex → Swiss Patterns → piiranha-v1 NER (400M ONNX)
- **17 PII Categories**: Names, addresses, AHV numbers, IBAN, health data, and more
- **4 Privacy Modes**: Shield, Vault, Transparent, Local Only
- **On-Device NER**: <50ms inference, no cloud required
- **Red-Team Tested**: 143 test cases, 84.9% detection rate, 0 critical failures

### Downloads
- **macOS**: DMG (Apple Silicon) or ZIP
- **Windows**: Installer or Portable
- **Linux**: AppImage or .deb

Full changelog: CHANGELOG.md
EOF
)" \
  dist/Mingly-0.7.0-arm64.dmg \
  dist/Mingly-0.7.0-arm64-mac.zip
```

---

### Task 17: Deploy Website

- [x] **Step 1: Push website changes**

```bash
cd ~/projects/mingly-website && git push origin main
```
Expected: Vercel auto-deploys on push

- [x] **Step 2: Verify deployment**

Check Vercel dashboard or `vercel ls` for successful deployment.

- [x] **Step 3: Verify live site**

Open mingly.ch, check:
- Hero shows "Swiss AI Privacy"
- Features show Swiss AI Privacy + NER first
- Pricing shows privacy messaging
- Use Cases show Arztpraxis first + Anwaltskanzlei
- Download links point to v0.7.0
- FAQ has expanded Swiss AI Privacy answer

---

### Task 18: Post-Release Verification

- [x] **Step 1: Test download links**

Verify that `https://github.com/Baldri/mingly/releases/download/v0.7.0/Mingly-0.7.0-arm64.dmg` returns 200.

- [x] **Step 2: Update memory**

Update `~/.claude/projects/-Users-holgervonellerts-projects/memory/MEMORY.md` with v0.7.0 release status.
