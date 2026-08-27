# CH-Gateway Policy-Kern — Handoff

**Plan:** `docs/superpowers/plans/2026-08-26-ch-gateway-policy-core.md`
**Spec:** `docs/superpowers/specs/2026-08-26-ch-gateway-design.md`
**Branch:** `claude/ch-angebot-ki-orchestrierung-abfebf`

Ein Auftrag je Subagent. Jeder Subagent bekommt genau einen Task, arbeitet ihn nach TDD ab und
uebergibt. Zwischen den Wellen pruefe ich; du greifst an den Review-Punkten ein.

---

## Vor dem Start

**Einmalig im Worktree**, sonst scheitern Typecheck und `license-activation.test.ts` an der
fehlenden generierten Datei — das ist *nicht pruefbar*, nicht *rot*:

```bash
npm run prebuild:main
```

---

## H1 — Aufgabe fuer Holger: Infomaniak-Zugang

**Blockiert:** nur Welle 4 (Task 8). Wellen 1–3 laufen ohne dich. Zeitfenster also waehrend der
ersten drei Wellen, nicht davor.

Belegt am 26.08.2026 aus der Infomaniak-Dokumentation: ein AI-Produkt je Organisation, Kreditkarte
erforderlich, Rechnungs- oder Administratorrechte noetig. Die Basis-URL enthaelt die Produkt-ID.

1. Im Infomaniak Manager das Produkt **AI Tools** anlegen.
2. **Produkt-ID** notieren.
3. **API-Token** erstellen (Infomaniak-FAQ 2582).
4. Beides in `.env` im Projektwurzelverzeichnis ablegen — **nicht in den Chat**:
   ```
   INFOMANIAK_PRODUCT_ID=<id>
   INFOMANIAK_TOKEN=<token>
   ```
5. Modellliste abfragen und **mir nur diese Ausgabe** zurueckgeben:
   ```bash
   curl -s -H "Authorization: Bearer $INFOMANIAK_TOKEN" \
     "https://api.infomaniak.com/2/ai/$INFOMANIAK_PRODUCT_ID/openai/v1/models" | jq -r '.data[].id'
   ```
6. Preis je Million Tokens aus der Produktansicht notieren.

**Warum Schritt 5 nicht optional ist:** Ob **Apertus** bei Infomaniak laeuft, ist unbelegt. Die
Openstream-Tabelle der Bewertung behauptet es, der Infomaniak-Einstiegsleitfaden nennt es nicht.
Diese Ausgabe ist die einzige belastbare Quelle — und sie entscheidet, ob der Slice ueberhaupt
gegen Apertus vorgefuehrt werden kann oder zunaechst gegen ein anderes offenes Modell.

**Falls Apertus nicht in der Liste steht:** kein Abbruch. Task 8 laeuft trotzdem; der Endpunkt
traegt dann ein anderes offenes Modell, und die Apertus-Frage geht an Safe Swiss Cloud oder
PHOENIQS. Sag mir in dem Fall Bescheid, ich passe den Registry-Eintrag an.

---

## Gemeinsame Regeln fuer jeden Subagenten

Diese stehen in jedem Auftrag und gelten ausnahmslos:

- **Nur die im Task genannten Dateien anfassen.** Nichts nebenbei aufraeumen.
- **Bestehende Tests nicht aendern.** Ein roter Bestandstest ist ein Befund und wird gemeldet,
  nicht weggefixt.
- **TDD in der Reihenfolge des Plans:** Test schreiben → rot sehen → minimal implementieren →
  gruen sehen → committen. Der rote Lauf muss tatsaechlich stattgefunden haben.
- **Kein `any`**, TypeScript strict.
- **Vor dem Commit:** `npm run typecheck` und `npm test`, beide mit **echtem Exit-Code** pruefen —
  nicht durch eine Pipe leiten, `tail` verschluckt den Status.
- **Kein Push, kein PR.**
- **Wenn der Code aus dem Plan nicht kompiliert:** melden mit der Fehlermeldung, nicht
  eigenmaechtig umbauen. Der Plan ist gepruefter Entwurf, kein Diktat — aber Abweichungen sind
  Entscheide, keine Reparaturen.

---

## Welle 1 — Fundament

### S1 · Task 1: Provider-Registry mit Herkunft

**Auftrag:** Fuehre Task 1 aus. Erweitere `src/shared/provider-types.ts` um die Herkunftstypen und
lege `src/main/routing/provider-registry.ts` an.

**Lies zuerst:** Task 1 im Plan, `src/shared/provider-types.ts`, `tests/unit/activity-logger.test.ts`
(fuer den Teststil dieses Repos).

**Liefert:** `Residency`, `HostingMode`, `WeightsLicense`, `DpaStatus`, `ProviderOrigin`,
`ProviderCapabilities`, `RegistryEntry`, `ProviderRegistry`, `getProviderRegistry`,
`setProviderRegistry`.

**Verifikation:** `npm test -- tests/unit/provider-registry.test.ts` → 5 Tests gruen.

**Kernpunkt, den du nicht verwaessern darfst:** `registerTenant` **verwirft** die Herkunft aus der
uebergebenen Konfiguration und setzt `residency: 'unknown'`. Nicht mergen, nicht nur ueberschreiben
wenn leer. Das ist Invariante I2 — ein falsch beschrifteter Endpunkt wuerde sonst das gesamte
Residenzversprechen aushebeln, und der Audit-Trail wuerde die Verletzung als regelkonform
protokollieren.

**Review-Punkt fuer Holger:** keiner. Reine Typarbeit.

---

## Welle 2 — parallel, getrennte Dateien

### S2 · Task 2: Schutzbedarfs-Typen

**Auftrag:** Fuehre Task 2 aus. Lege `src/main/policy/policy-types.ts` an.

**Lies zuerst:** Task 2 im Plan, `src/main/privacy/pii-types.ts` (Zeilen 25–46).

**Liefert:** `SENSITIVITY_ORDER`, `atLeast`, `maxSensitivity`, `Classification`, `PolicyRule`,
`PolicySet`, `PolicyDecision`.

**Verifikation:** `npm test -- tests/unit/policy-types.test.ts` → 5 Tests gruen.

**Kernpunkt:** `PIISensitivity` wird **wiederverwendet**, kein Parallel-Typ. Ein zweiter
Schutzbedarfs-Typ waere eine Uebersetzungstabelle, die auseinanderlaeuft.

### S6 · Task 6: Audit-Schreiber

**Auftrag:** Fuehre Task 6 aus. Lege `src/main/policy/audit-writer.ts` an.

**Lies zuerst:** Task 6 im Plan, `src/main/audit/activity-logger.ts`, `src/main/audit/types.ts`.

**Liefert:** `RoutingDecisionRecord`, `logRoutingDecision`.

**Verifikation:** `npm test -- tests/unit/policy-audit-writer.test.ts` → 3 Tests gruen.

**Kernpunkt:** **Nie Inhalte ins Log.** Das Log ist das Dokument, das ein Kunde einer Aufsicht
vorlegt — Prompt- oder Antworttext darin waere das Datenschutzproblem statt sein Nachweis. Der
dritte Test prueft genau das und darf nicht gelockert werden.

Nebenbei: dies ist der **erste Produktionsaufrufer** von `ActivityLogger`. Bisher importierte ihn
nur sein eigener Unit-Test.

---

## Welle 3 — parallel, getrennte Dateien

### S3 · Task 3: Sensitivitaets-Klassifikator

**Auftrag:** Fuehre Task 3 aus. Lege `src/main/policy/sensitivity-classifier.ts` an.

**Lies zuerst:** Task 3 im Plan, `src/main/privacy/pii-types.ts`, Spec §4.2 (Invariante I3).

**Liefert:** `classify(entities, workspaceClass): Classification`.

**Verifikation:** `npm test -- tests/unit/sensitivity-classifier.test.ts` → 6 Tests gruen.

**Kernpunkt:** `bySource` zaehlt je **Detektorschicht**, nicht je Kategorie. Dieselbe Kategorie
kommt aus Schichten mit unterschiedlicher Reichweite und — im Web — unterschiedlichem
Verarbeitungsort: `ADDRESS` liefert die Schweizer Regex-Schicht nur fuer Schweizer Formen, NER
allgemein. Der Test «distinguishes the same category coming from two layers» ist der Kern, nicht
ein Randfall.

### S4 · Task 4: Policy-Engine

**Auftrag:** Fuehre Task 4 aus. Lege `src/main/policy/policy-engine.ts` an.

**Lies zuerst:** Task 4 im Plan, Ergebnis von S1 und S2, Spec §4.2.

**Liefert:** `DEFAULT_POLICY`, `evaluate(policy, classification, candidates): PolicyDecision`.

**Verifikation:** `npm test -- tests/unit/policy-engine.test.ts` → 7 Tests gruen.

**Kernpunkt:** Eine leere zulaessige Menge **bleibt leer**. Kein Fallback auf «dann eben alle» —
das wuerde den strengsten Fall in den freizuegigsten verwandeln. Der letzte Test prueft genau das.
Und die Regelauswahl laeuft ueber die **hoechste zutreffende Schwelle**, nicht ueber Listenreihenfolge
oder die Laenge von `allowedResidency`; beides machte das Ergebnis davon abhaengig, wie der
Regelsatz zufaellig geschrieben ist.

### S5 · Task 5: Router liest aus der Registry

**Auftrag:** Fuehre Task 5 aus. Aendere `src/main/routing/intelligent-router.ts` und ergaenze
`seedBuiltInProviders` in `src/main/routing/provider-registry.ts`.

**Lies zuerst:** Task 5 im Plan, `src/main/routing/intelligent-router.ts` vollstaendig,
`tests/unit/intelligent-router.test.ts`.

**Liefert:** `PROVIDER_CAPABILITIES` entfernt, `selectProvider` bewertet ueber die Registry,
`seedBuiltInProviders`.

**Verifikation:** `npm test -- tests/unit/intelligent-router.test.ts` → alle bestehenden Tests plus
der neue gruen.

**Kernpunkt:** Der `|| 0.5`-Fallback verschwindet ersatzlos. Er war der Grund, warum ein Schweizer
Endpunkt fuer den Router ein Modell ohne Eigenschaften war. Ein unbekannter Anbieter bekommt jetzt
`0`, und eine leere Menge liefert `suggestedProvider: ''` mit `confidence: 0` statt irgendetwas.

**Achtung Dateikonflikt:** S5 ist in dieser Welle der einzige Auftrag, der `provider-registry.ts`
anfasst. Nicht parallel zu S8 ausfuehren.

**Review-Punkt fuer Holger:** Die Faehigkeitswerte fuer Anthropic, OpenAI und Google in
`seedBuiltInProviders` sind aus der bisherigen hart verdrahteten Tabelle uebernommen — also
uebernommene Schaetzungen, keine Messungen. Wenn sie dir nicht plausibel sind, ist jetzt der
Zeitpunkt.

---

## Welle 4 — Schweizer Endpunkt (braucht H1)

### S8 · Task 8: Infomaniak eintragen

**Auftrag:** Fuehre Task 8 aus. Ergaenze `seedSwissProviders` in
`src/main/routing/provider-registry.ts`.

**Lies zuerst:** Task 8 im Plan, das Ergebnis von H1 (Modellliste), Spec §6.

**Liefert:** `seedSwissProviders(registry, infomaniakProductId)`.

**Verifikation:** `npm test -- tests/unit/provider-registry.test.ts` → 9 Tests gruen.

**Kernpunkte, beide nicht verhandelbar:**

1. **Die Basis-URL ist kontospezifisch** — `https://api.infomaniak.com/2/ai/{product_id}/openai/v1`,
   ein Produkt je Organisation. Sie wird aus `INFOMANIAK_PRODUCT_ID` gebaut, nie als Konstante
   eingetragen. Ohne konfigurierte ID wird **nichts** registriert, nicht eine URL, die nicht
   antworten kann.
2. **`capabilities` bleibt auf dem Unmeasured-Default `0.5`** und `models` bleibt leer. Fuer
   Apertus 1.5 existieren keine publizierten Benchmarkzahlen, und die Eignungspruefung ist gegen
   diesen Endpunkt nicht gelaufen. Einen Wert einzutragen hiesse, im Code eine Zusage zu machen,
   wo das Angebot eine Pruefung verkauft — und dort erkennt sie spaeter niemand mehr als
   Marketingaussage.

**Review-Punkt fuer Holger:** Der Eintrag traegt `dpaStatus: 'signed'`. Das ist eine **Annahme**
bis der Infomaniak-Auftragsverarbeitungsvertrag tatsaechlich unterzeichnet ist. Bis dahin ist der
korrekte Wert `'none'` — sag mir, welcher gilt.

---

## Welle 5 — Verdrahtung

### S7 · Task 7: Reihenfolge festnageln

**Auftrag:** Fuehre Task 7 aus. Ergaenze `routeWithPolicy` in `src/main/services/service-layer.ts`
und lege `tests/unit/policy-invariants.test.ts` an.

**Lies zuerst:** Task 7 im Plan, `src/main/services/service-layer.ts`, die Ergebnisse von S1–S6,
Spec §4.2 vollstaendig.

**Liefert:** `ServiceLayer.routeWithPolicy`, drei Invariantentests.

**Verifikation:** `npm run typecheck && npm test` — beide Exit-Code 0, gesamte Suite gruen.

**Kernpunkt:** Die drei Aufrufe stehen in genau einer zulaessigen Reihenfolge — klassifizieren,
Policy auswerten, dann routen. Der Router bekommt eine bereits gefilterte Menge und kann sie nur
weiter verengen, nie erweitern. Das ist Invariante I1. Die Tests sind als **Umgehungstests**
geschrieben, nicht als Randfaelle: der bestbewertete Anbieter muss gegen die Policy verlieren, eine
leere Menge darf sich nicht aufloesen, und ein mandantenseitig eingetragener Endpunkt mit
CH-Behauptung darf keine sensible Anfrage bekommen.

**Bekannte Grenze, gehoert in die Uebergabe:** Die Vollform von I1 — Credential-Resolver **nach**
der Policy — ist hier noch nicht testbar, weil es den Resolver erst in Plan 2 gibt. Was dieser Task
absichert, ist die Vorstufe: Policy vor Router. Das gehoert so in die Abschlussmeldung, damit
niemand I1 fuer vollstaendig geprueft haelt.

**Review-Punkt fuer Holger:** letzter Gate vor dem Abschluss des Slice.

---

## Reihenfolge auf einen Blick

```
Welle 1   S1  ────────────────────────────────────────────►  Registry + Herkunftstypen
Welle 2   S2 ║ S6  ──────────────────────────────────────►  Policy-Typen ║ Audit-Schreiber
Welle 3   S3 ║ S4 ║ S5  ───────────────────────────────►  Klassifikator ║ Engine ║ Router
Welle 4   S8  ────────────────────────────────────────────►  CH-Endpunkt      (braucht H1)
Welle 5   S7  ────────────────────────────────────────────►  Verdrahtung + Invarianten

H1 (Holger, Infomaniak)  ────────────────────┘  jederzeit waehrend Welle 1–3
```

Die Wellenbildung folgt **Dateikonflikten**, nicht Themen: S5 und S8 aendern beide
`provider-registry.ts` und duerfen deshalb nicht parallel laufen. Alles andere in einer Welle
schreibt in getrennte Dateien.

---

## Abbruchbedingungen

Ich stoppe die Kette und frage nach, statt weiterzumachen, wenn:

- ein Subagent einen **bestehenden** Test rot meldet — das ist ein Befund am Bestand, kein Hindernis;
- der Code aus dem Plan nicht kompiliert und die Reparatur eine Entwurfsentscheidung waere;
- H1 ergibt, dass Infomaniak kein brauchbares offenes Modell fuehrt — dann ist die Anbieterwahl neu
  zu treffen, nicht der Code anzupassen;
- ein Invariantentest nur gruen wird, indem man ihn abschwaecht.
