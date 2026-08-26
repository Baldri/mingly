# CH-Gateway — Design Spec

**Datum:** 2026-08-26
**Status:** Entwurf, zur Review
**Anlass:** Strategiesession zum Stripe/OpenRouter-Deal (FAZ, 26.08.2026) und der Bewertung
`CH-Angebot_KI-Orchestrierung_Bewertung.md`
**Firma:** digital opua GmbH (Produkt), digital nalu GmbH (Beratungsmandate) — Zuordnung offen, siehe §11

---

## 1. Zweck und Abgrenzung

Ein Schweizer Gateway fuer KI-Orchestrierung: eine Policy-Schicht, die pro Anfrage entscheidet,
**welches Modell die Anfrage ueberhaupt bearbeiten darf**, den Aufruf gegen den zulaessigen
Endpunkt ausfuehrt und die Entscheidung nachweisbar protokolliert.

Verkauft wird Governance, nicht Inferenz. Das Modellportfolio reicht von Schweizer
Open-Weights-Endpunkten (Apertus und andere) ueber europaeische bis zu Frontier-Modellen.

**Nicht Gegenstand dieses Dokuments:** Preisgestaltung im Detail, Vertragswerk,
Gesellschaftszuordnung, Go-to-Market. Diese haengen am Design, sind aber eigene Entscheide.

---

## 2. Entscheide (26.08.2026, Holger)

| # | Entscheid | Konsequenz |
|---|---|---|
| E1 | **Eigener Gateway, Web zuerst.** Die Web-Oberflaeche ist der Normalfall fuer KMU; die Mingly-Desktop-App wird zur Haertungsstufe bei erhoehtem Schutzbedarf, nicht zur Voraussetzung. | Mingly ist der erste Konsument des Gateways, nicht sein einziger. Fremdsysteme koennen spaeter ohne Umbau dazukommen. |
| E2 | **Vertragsmodell gepaart.** CH-Tokens laufen immer auf unserem Vertrag und sind inbegriffen; Frontier wahlweise per BYOK oder ueber unser Pooling. | Erzwingt Credential-Resolution pro Anfrage und zwei getrennte Abrechnungspfade. |
| E3 | **CH-Tokens zum Selbstkostenpreis, Prepaid.** Keine Handelsspanne auf Inferenz. Abo mit Startguthaben, zukaufbares Guthaben, spaeter Reload-Funktion. | Umgeht die Margenfalle aus §4 des Apertus-Papiers und haelt die CH-Anbieter in der Partnerrolle. Prepaid ist negatives Working Capital. |
| E4 | **Ausfuehrungsschicht: gemietete CH-Endpunkte.** Kein eigenes GPU-Hosting im Normalfall; Eigenbetrieb inkl. Tuning bei konkreten Kundenanfragen. | Die Faehigkeit zum Eigenbetrieb ist Teil des Unterscheidungsmerkmals und bereits belegt (§6). Bei Eigenbetrieb traegt der Betreiber die AUP-Pflichten selbst (§6); wer bei gemieteten Endpunkten als Betreiber gilt, wenn wir fuer einen Kunden routen, ist **offen** — §11. |
| E5 | **Betriebsort Schweiz.** Der Gateway laeuft nicht auf Vercel fra1. | Kippt den ratifizierten Entscheid aus ADR-053/054 fuer dieses Produkt. Braucht einen eigenen ADR, siehe §11. |
| E6 | **Kapazitaet: 8–12 Tage/Monat.** | Der Schnitt in §7 ist damit in rund 8–12 Wochen lieferbar. Voraussetzung: kein vierter paralleler Strang. |

---

## 3. Ausgangslage — was im Repo tatsaechlich steht

Gemessen am 26.08.2026 gegen den Worktree, nicht aus Projektdokumentation uebernommen.

| Baustein | Stand | Fundstelle |
|---|---|---|
| OpenAI-kompatibler Client | **vorhanden**, inkl. Streaming und Tool-Use | `src/main/llm-clients/generic-openai-client.ts` |
| Custom-Provider mit `apiBase` | **vorhanden** | `src/shared/provider-types.ts` (`createCustomProvider`), `client-manager.ts:89` |
| Provider-Herkunft (Land, Betreiber, Lizenz) | **fehlt** — `ProviderConfig` beschreibt nur Faehigkeiten | `src/shared/provider-types.ts` |
| Router | **vorhanden, falsche Achse** — klassifiziert `code｜creative｜analysis｜conversation`, nicht Schutzbedarf | `src/main/routing/intelligent-router.ts` |
| `PROVIDER_CAPABILITIES` | **hart auf `anthropic｜openai｜google` verdrahtet**; unbekannte Provider fallen auf `0.5` | `intelligent-router.ts` |
| Sensitivitaet / Residenz / Jurisdiktion | **kommt in `src/` nicht vor** (Positivkontrolle im selben Suchlauf: `mistral` an vier Stellen gefunden) | — |
| PII-Pipeline | **vorhanden, dreischichtig** | `src/main/privacy/detector-pipeline.ts` |
| — Layer 1 Regex, Layer 2 Schweiz | reines RegExp, **browsertauglich, 0 MB** | `regex-detector.ts`, `swiss-detector.ts` |
| — Layer 3 NER | ONNX, **676 MB gemessen** (`~/.mingly/models/Xenova/bert-base-multilingual-cased-ner-hrl/onnx/model.onnx`) | `model-manager.ts` |
| Audit | Tabelle in Migration 8 vorhanden, `ActivityLogger` **von keinem Produktionspfad importiert** (nur vom eigenen Unit-Test; Positivkontrolle: `getRouter()` an drei Produktionsstellen) | `src/main/audit/activity-logger.ts`, `database/index.ts:518` |
| Server-Modus | vorhanden: `/health /info /providers /chat /chat/stream /conversations` mit API-Auth | `src/main/server/mingly-api-server.ts` |
| Tiers | `'free' ｜ 'pro' ｜ 'team' ｜ 'enterprise'` | `src/shared/types.ts:358` |
| Renderer-Kopplung an IPC | 28 von 57 Dateien referenzieren `window.electron` | `src/renderer/` |

**Folgerung:** CH-Endpunkte anzubinden ist Konfiguration. Die eigentliche Arbeit liegt in der
Provider-Registry, der Policy-Schicht, dem Ausgabefilter, dem Ledger und darin, den Audit-Trail
vom Schema zum laufenden Trail zu machen.

---

## 4. Architektur

### 4.1 Bausteine

| Baustein | Aufgabe |
|---|---|
| Anonymisierung | PII erkennen und ersetzen, gestaffelt nach Client (§4.3) |
| Sensitivitaets-Klassifikator | Anfrage → Schutzbedarf |
| Policy-Engine | `(Schutzbedarf, Aufgabe, Budget, Mandant)` → **zulaessige** Anbietermenge |
| Provider-Registry | Modelle mit Herkunft: `residency`, `operator`, `weightsLicense`, `hostingMode`, `dpaStatus` |
| Credential-Resolver | `(Mandant, Zielmodell)` → Schluessel + Abrechnungspfad |
| Ausfuehrung | Aufruf gegen den gewaehlten Endpunkt (bestehende Clients) |
| **Ausgabefilterkette** | Filter auf der Antwort, erstes Glied: AUP-Hashfilter (§4.5) |
| **Guthaben-Ledger** | Reservieren, buchen, freigeben (§4.6) |
| Audit-Schreiber | jede Entscheidung nachweisbar, **ohne Inhalte** |

`PROVIDER_CAPABILITIES` wird aus der Registry gelesen statt auf drei IDs verdrahtet. Erst dadurch
ist ein weiteres europaeisches Modell ein Datensatz statt ein Code-Change.

### 4.2 Policy filtert, Router waehlt darin

Zwei getrennte Achsen:

- Der bestehende Router beantwortet **«welches Modell kann das am besten»**.
- Die Policy-Engine beantwortet **«welches Modell darf das»**.

Reihenfolge ist bindend: Policy filtert zuerst, der Router waehlt innerhalb der zulaessigen Menge.
Nie umgekehrt — sonst entscheidet Qualitaet ueber Zulaessigkeit, und das ist einem Auditor nicht
erklaerbar. Nebenwirkung: der `|| 0.5`-Fallback des Routers verschwindet, weil jeder Registry-
Eintrag seine Faehigkeiten mitbringt.

### 4.3 Datenfluss

```
Browser                          Gateway (CH)                    Anbieter
───────                          ────────────                    ────────
Text
 └─ Layer 1+2 lokal ────────────► Layer 3: NER ──► Klassifikator
    (Regex + CH-Muster, 0 MB)        (CH)              │
    Session-Map bleibt hier                           ▼
                                               Policy-Engine
                                        (zulaessige Anbietermenge)
                                                      ▼
                                        Router waehlt darin ──────► CH-Endpunkt
                                                      │             oder Frontier
                                        Credential-Resolver
                                        Guthaben reservieren
                                                      ▼
 ◄──────────────────────────────  Ausgabefilterkette  ◄──────────────┘
 └─ Rehydration lokal              Guthaben buchen
                                   Audit-Eintrag (ohne Inhalte)
```

Die Desktop-App unterscheidet sich an genau einer Stelle: Layer 3 laeuft ebenfalls lokal.

### 4.4 Was wir ueber Datenschutz sagen duerfen

Der Web-Modus darf **nicht** behaupten «Ihre Daten verlassen Ihr Geraet nie» — Layer 3 laeuft
serverseitig. Belegbar ist:

> AHV, IBAN, Telefon, E-Mail und Schweizer Adressen verlassen Ihr Geraet nie.
> Namen und uebrige Ortsangaben werden im Schweizer Gateway ersetzt und verlassen die Schweiz nie.

Praeziser Zuschnitt, gemessen an den Detektoren (26.08.2026):

| Schicht | Kategorien | im Browser |
|---|---|---|
| 1 — Regex (`regex-detector.ts`) | `EMAIL` `PHONE` `CREDIT_CARD` `IP_ADDRESS` `DATE_OF_BIRTH` `AGE` `URL` | ja |
| 2 — Schweiz (`swiss-detector.ts`) | `AHV` `IBAN` `PHONE` `ADDRESS` `LOCATION` | ja |
| 3 — NER (`ner-worker.ts`) | `PERSON` `ORGANIZATION` `LOCATION` | nein (676 MB) |

Layer 2 erkennt Adressen nur in **Schweizer** Form: `CH_STREET_PATTERN` verlangt eine deutsche
Strassenendung, `CH_PLZ_CITY_PATTERN` eine vierstellige Schweizer Postleitzahl. Eine
auslaendische Adresse faellt an Layer 3 und wird dort als `LOCATION` erkannt, nicht als
`ADDRESS`. Personennamen kommen ausschliesslich aus Layer 3.

**Daraus folgt die Stufung, und zwar belegbar statt behauptet:** im Web bleiben die
strukturierten Kennzeichen und Schweizer Adressen auf dem Geraet, Namen werden im Gateway
ersetzt. In der App bleiben auch die Namen auf dem Geraet. Das ist der Mehrwert der
Haertungsstufe, in einem Satz und nachpruefbar.

Das ist zugleich die technische Begruendung dafuer, warum die App bei erhoehtem Schutzbedarf die
Empfehlung ist, statt eine vertriebliche Behauptung zu sein.

**Sperre:** Kein Angebot, das Datenschutz mit Modellherkunft begruendet (Ausschlusskriterium des
Apertus-Papiers, §8 dort). Der Schutz kommt aus Anonymisierung und Verarbeitungsort, nicht daraus,
dass ein Modell schweizerisch ist.

### 4.5 Ausgabefilterkette

Neu gegenueber der Desktop-App: dort geht die Antwort nur durch die Rehydration. Der Gateway
braucht eine Filterkette auf dem Antwortpfad, weil die Apertus-AUP einen **Ausgabefilter**
vorschreibt (§6). Ein nachtraeglich eingezogener Ausgabefilter fasst jeden Streaming-Pfad erneut
an — deshalb von Anfang an als Kette angelegt, auch wenn zunaechst nur ein Glied darin haengt.

### 4.6 Guthaben-Ledger

1. **Ledger statt Saldo.** Der Kontostand ist die Summe von Buchungen, nie ein ueberschriebenes
   Feld. Andernfalls ist der Audit-Trail wertlos.
2. **Zwei Buchungsarten.** Pooling belastet Guthaben, BYOK wird nur gemessen. Gehoert ins
   Datenmodell, nicht in eine Bedingung im Abrechnungscode.
3. **Reservieren → buchen → freigeben.** Der Verbrauch steht erst nach der Antwort fest; ohne
   Reservierung laeuft ein Mandant bei parallelen Streams ins Minus.
4. **Zwei Guthabenarten.** Monatliches Inklusivkontingent aus dem Abo (verfaellt) plus gekauftes
   Guthaben (verfaellt nicht). Verbrauch zieht zuerst das Inklusivkontingent.

### 4.7 Audit

`ActivityLogger` wird verdrahtet. Je Anfrage: Mandant, Nutzer, Schutzbedarfsklasse, greifende
Policy-Regel und deren Version, gewaehlter Anbieter, `residency`, Modell, Tokenzahl,
Vertragspfad, angewandte Ausgabefilter. **Keine Inhalte** — sonst ist das Log selbst das
Datenschutzproblem.

---

## 5. Mandantenfaehigkeit

Ein Mandant = eine Organisation, flach, ohne Rollenmodell im ersten Wurf. Pro Mandant:
Policy-Satz (Standard plus Ueberschreibungen), Schluessel, Guthaben, Audit.

---

## 6. Apertus — Rahmenbedingungen aus der eigenen Vorarbeit

Quelle: `~/projects/Strategiepapiere/2026-07-31-apertus-einsatzpruefung-und-angebot.md`
(Primaerquellen am 31.07.2026 geprueft) sowie die LoRA-Messreihe in
`~/projects/nexbid-apertus-lora/`. **Diese Angaben sind nicht neu zu erheben.**

**Gemessen (publiziert):**

| | ohne Finetuning | mit LoRA + Schema-Zwang |
|---|---|---|
| Apertus 1.5, gueltige schemakonforme Ausgabe | 1 von 4 | 24 von 24 |
| Qwen3-8B, gueltige schemakonforme Ausgabe | 4 von 4 | — |

Die Fehler ohne Anpassung waren **formaler** Natur — inhaltlich lag das Modell oft richtig.
Genau diese Fehlerklasse verschwand. Constrained Decoding wird fuer strukturierte Ausgaben
unabhaengig vom Modell empfohlen.

**Betriebspflichten aus der Acceptable Use Policy (Fassung 1.0 vom 01.09.2025):**

- Der Betreiber verarbeitet Personendaten als **eigenstaendig Verantwortlicher**; ETH und EPFL
  sind ausdruecklich nicht Auftragsverarbeiter.
- Der Betreiber stellt ETH Zuerich und EPFL von Anspruechen Dritter frei.
- Loeschbegehren werden ueber eine **Hashwert-Datei** abgebildet, die der Betreiber als
  **Ausgabefilter** anwendet; Empfehlung halbjaehrliche Erneuerung.
- Selbstbetrieb ueber Hugging Face setzt voraus, dass **Holger persoenlich** die AUP annimmt.
  Nicht delegierbar.

Laut Papier verkauft kein Hoster diesen Prozess und kein Modellanbieter uebernimmt ihn. Das ist
der Grund, warum der Ausgabefilter (§4.5) ein Produktmerkmal ist und nicht nur eine Pflicht.

**Weitere harte Grenzen:**

- Kein Leistungsversprechen gegen GPT, Claude oder Gemini. Der technische Bericht zu 1.5 stand am
  31.07.2026 aus; publizierte Benchmarkzahlen existieren nicht. Wir verkaufen eine Pruefung.
- Die Apertus-Quantisate in der Ollama-Registry sind Community-Uploads; 8B und 70B sind v1.0
  (`2509`), nicht v1.5. Ein Ergebnis daraus als «Apertus 1.5» auszuweisen waere eine Falschaussage.
  Relevant, weil Mingly einen Ollama-Client hat.
- Apertus v1.5 ist ein multimodaler Wrapper. Fuer reinen Textbetrieb muss der Sprachturm
  herausgeloest werden (924 → 451 Tensoren, Vokabular 266'752 → 131'072). Betrifft nur den
  Eigenbetrieb; bei gemieteten Endpunkten hat der Anbieter das erledigt.

---

## 7. Schnitt — erster Wurf

Ziel: **ein Pfad, produktiv, mit Log, vorfuehrbar.**

- Provider-Registry mit Herkunftsattributen; `PROVIDER_CAPABILITIES` aus der Registry gelesen
- Ein CH-Endpunkt (Infomaniak, Apertus) neben den bestehenden Frontier-Clients
- Sensitivitaets-Klassifikator als **Regel**, kein ML. Zwei Eingaben:
  (a) die hoechste Sensitivitaetsstufe der gefundenen PII-Entitaeten — `PII_SENSITIVITY` in
  `PIISensitivity` in `src/main/privacy/pii-types.ts:25` definiert die Skala
  `critical ｜ high ｜ medium ｜ low`, die Zuordnung je Kategorie steht in `PII_SENSITIVITY` (:89);
  (b) die Datenklasse des Arbeitsbereichs, in dem die Anfrage gestellt wird — ein pro Mandant
  konfigurierter Wert derselben Skala (z. B. Arbeitsbereich «Mandantendossier» = `critical`,
  «Marketing» = `low`). Der Schutzbedarf ist das Maximum aus (a) und (b).
- Policy-Engine deklarativ und versioniert, mit **einer** Regel: `Schutzbedarf >= high → nur
  residency=CH`
- Credential-Resolver fuer Pool und BYOK
- Guthaben-Ledger mit Reservierung; **Aufladen manuell**
- Ausgabefilterkette mit dem AUP-Hashfilter als erstem Glied
- Audit-Schreiber verdrahtet, ohne Inhalte
- Anonymisierung: Layer 1+2 im Browser, Layer 3 im Gateway
- Web-Oberflaeche fuer Chat, Guthabenstand und Audit-Einsicht. **Neubau, keine Portierung:**
  28 der 57 Renderer-Dateien haengen an `window.electron` (§3); den Renderer zu entkoppeln waere
  teurer als eine schlanke Weboberflaeche gegen die Gateway-API. Gemeinsam genutzt werden die
  Layer-1/2-Detektoren, die reines RegExp sind.

---

## 8. Nicht im Umfang

Routing-SLM · Auto-Reload und Zahlungsautomatik · Rollen und Rechte innerhalb eines Mandanten ·
eigenes GPU-Hosting · DocMind und RAG-Wissen als weitere Konsumenten · Selbstbedienungs-Onboarding ·
Marktplatz, Handelsspanne auf Inferenz, eigenes Modelltraining.

---

## 9. Testkonzept

- **Policy-Engine:** Tabellengetriebene Tests. Zu jeder Regel ein Fall, der greift, **und** einer,
  der nicht greifen darf. Ein Guard, der nur die Treffer prueft, ist nicht geprueft.
- **Klassifikator:** gegen einen Satz Beispieltexte mit erwarteter Klasse; Fehlklassifikation nach
  unten (zu niedriger Schutzbedarf) ist ein harter Fehler, nach oben eine Warnung.
- **Ledger:** Nebenlaeufigkeit explizit — parallele Streams gegen dasselbe Guthaben duerfen nicht
  ins Minus fuehren.
- **Ausgabefilter:** Positivkontrolle im selben Lauf (der Filter muss einen bekannten Hash finden),
  sonst ist ein Nullbefund kein Befund.
- **Eignungspruefung:** **nicht neu bauen.** Vorhanden ist `~/projects/eval-framework/` mit
  `data/suites/ch_kmu_v1.json` (fuenf KMU-Aufgaben, Inhalte erfunden, darf an Kunden gehen),
  `eval/generation.py` — dessen OpenAI-kompatibles Backend im Papier «der Apertus-Slot» heisst —
  und `examples/modell_eignungspruefung.py`. Bekannte Grenze: der Judge vergibt auf diesem Set fast
  nur zwei Werte; das traegt fuer Eignung, nicht fuer eine Rangfolge.

---

## 10. Risiken

| Risiko | Umgang |
|---|---|
| Der Gateway wird als Reseller gelesen | E3: Selbstkostenpreis, keine Spanne. Governance ist das Produkt. |
| Partnerausfall entwertet das CH-Versprechen | Zwei CH-Anbieter von Anfang an (Infomaniak und Safe Swiss Cloud). |
| Betreiberstatus nach AUP unklar, wenn wir fuer Kunden routen | §11, vor dem ersten Mandat anwaltlich klaeren. Wir richten Prozesse ein, wir wuerdigen nicht rechtlich. |
| Apertus unterliegt fachlich | Wir verkaufen die Pruefung, nicht das Ergebnis. Routing statt Ersatz. |
| Ledger-Fehler = Geldfehler | Buchungen statt Saldi, Nebenlaeufigkeitstests, kein Auto-Reload im ersten Wurf. |
| Marketingtexte driften gegen den Code | Am 26.08.2026 real eingetreten (NER-Modell). Modellnamen gehoeren an genau eine Stelle im Code, Doku verweist dorthin. |
| Vierter paralleler Strang | E6 gilt nur, solange Nexbid in Wartung bleibt. |

---

## 11. Offene Entscheide

- **[OPEN] ADR zu E5.** Der Gateway laeuft in der Schweiz statt auf Vercel fra1. Das kippt
  ADR-053/054 fuer dieses Produkt und ist zu dokumentieren, nicht implizit zu umgehen.
- **[OPEN] Betreiberstatus nach Apertus-AUP**, wenn wir fuer einen Kunden ueber unseren
  Anbietervertrag routen. Rechtsfrage, gehoert an eine Kanzlei.
- **[OPEN] Gesellschaftszuordnung.** Produkt unter Opua, Beratungsmandate unter Nalu — oder beides
  Opua?
- **[OPEN] Apertus-Zugang.** Seit dem 31.07.2026 der blockierende Schritt. Infomaniak zuerst
  (Konto und Schluessel genuegen), danach Konditionen bei einem zweiten Anbieter.
- **[OPEN] Pilotkunde** mit regulatorischem Zwang.
- **[ANNAHME]** Die Anbieter- und Preisangaben der Bewertung (Openstream-Tabelle) sind dort selbst
  als nicht nachverifiziert gekennzeichnet und vor jeder Kalkulation zu pruefen.

---

## 12. Quellen

**Intern**
- `CH-Angebot_KI-Orchestrierung_Bewertung.md` (26.08.2026) — Anlass, Marktscan, Optionen
- `~/projects/Strategiepapiere/2026-07-31-apertus-einsatzpruefung-und-angebot.md` — Apertus-
  Einsatzpruefung, Primaerquellen geprueft, dreistufiges Angebot
- `~/projects/nexbid-apertus-lora/`, `~/projects/nexbid/docs/blog/apertus-qwen-lora-datenqualitaet-de.md`
  — LoRA-Messreihe und publizierte Zahlen
- `~/projects/eval-framework/` — Eignungspruefungs-Verfahren
- ADR-049 (Mingly als Orchestrator), ADR-053/054 (Model-Routing, durch E5 fuer dieses Produkt beruehrt)

**Repo-Messungen vom 26.08.2026:** siehe §3, jede Zeile mit Fundstelle.
