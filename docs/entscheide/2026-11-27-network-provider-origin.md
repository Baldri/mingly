# Entscheidungsvorlage: Origin fuer `network:*`-Provider und LAN-Pooling

Stand 27.11.2026, gegen `origin/main` gemessen (348 Commits, `5a27b23` — nachgemessen mit `git rev-parse`, nicht aus `git log`).
Anlass: die zwei Review-Punkte aus [#54](https://github.com/Baldri/mingly/pull/54)
(gemergt 26.11., alle 9 Checks gruen).

---

## Kurzfassung

**Entscheid 1 ist kein Entscheid, sondern ein Befund.** Ein LAN-Server war nicht
nur unbenutzbar — die Wahl eines Rechners im eigenen Netz liess harmlosen Inhalt
still **nach `anthropic`** gehen, also in die US-Cloud. **Zugestellt als Bugfix
mit dieser Vorlage** (roter Test zuerst, siehe «Wie gemessen wurde»), nicht als
Feature. Was gebaut wurde: `LocalAIBridge.registerServer()` traegt den Provider
ins Registry ein, `unregisterServer()` nimmt ihn wieder heraus, und die Origin
wird erzwungen wie bei einem Tenant-Endpunkt.

**Entscheid 2: keinen neuen `Residency`-Wert.** Ein LAN-Pool braucht eine eigene
Provider-ID, aber keinen neuen Wert in der Union — `'unknown'` liefert bereits das
richtige Verhalten. Ein neuer Wert wird erst noetig, wenn **vertrauliche** Inhalte
auf die eigenen LAN-GPUs duerfen, und das ist eine Zusicherung des Nutzers, die die
App nicht pruefen kann.

---

## Entscheid 1 — Origin fuer `network:*`

### Was heute passiert (gemessen, mit Positivkontrolle im selben Lauf)

`applyResidencyPolicy` vergleicht die gewaehlte Provider-ID gegen
`registry.all()`. `network:*`-Provider stehen **nicht** im Registry
(`registerTenant` ist in `src/` nirgends aufgerufen), also ist die ID in
`decision.allowed` nie enthalten — auch nicht auf der niedrigsten Stufe, denn der
`!rule`-Zweig von `evaluate()` listet ebenfalls nur Registry-IDs.

| Provider | Schutzstufe | erlaubt? | Vorschlag |
|---|---|---|---|
| `ollama` (Positivkontrolle) | public | **ja** | – |
| `ollama` | internal | **ja** | – |
| `ollama` | confidential | **ja** | – |
| `network:192.168.1.50:11434` | public | **nein** | **`anthropic`** |
| `network:192.168.1.50:11434` | internal | **nein** | **`anthropic`** |
| `network:192.168.1.50:11434` | confidential | **nein** | `ollama` |

`guardDispatch` wechselt auf `suggestedProvider`, **ohne den Trust-Guard erneut zu
fahren**. Die Folge ist dieselbe Klasse wie der Defekt in #52, nur eine ID-Ebene
weiter — und in der Wirkung deutlich unangenehmer: wer bewusst einen Rechner im
eigenen Netz waehlt, sendet nach `anthropic`.

Dass es bisher niemand gemerkt hat, passt zur Reichweite aus #54:
`network-ai-servers.json` existiert auf diesem Install nicht, und nichts entdeckt
LAN-Hosts von selbst.

### Erreichbar, nicht bloss theoretisch (nachgemessen am Sendepfad)

Der Verdacht lag nahe, dass der Lauf vorher an einer Provider-Pruefung stirbt und
der Inhalt `anthropic` nie erreicht. Gemessen am Quelltext des Chat-Pfads trifft
das nicht zu, und zwar wegen der **Reihenfolge**:

| Stelle | Was passiert |
|---|---|
| `ipc-handlers.ts:176` | `guardDispatch` laeuft |
| `ipc-handlers.ts:191` | `dispatch.switched?.leavesDevice` wirft — **greift hier nicht**: eine nicht registrierte ID gilt schon als Cloud, also ist Cloud -> Cloud kein Verlassen des Geraets |
| `ipc-handlers.ts:196` | `provider = dispatch.provider` — ab hier ist der Provider `anthropic` |
| `ipc-handlers.ts:309` | `validateProvider(provider)` — sieht `anthropic` und **laesst durch** |

Die Provider-Pruefung haette den `network:*`-Lauf abgelehnt, aber sie kommt zu
spaet: zu dem Zeitpunkt ist der Provider bereits ersetzt. Das ist dieselbe
Beobachtung wie bei den Guard-Fallen in CLAUDE.md — eine Pruefstelle schuetzt
nicht vor einem Zustand, der an ihr vorbei entsteht; hier nicht am **Scope**,
sondern am **Zeitpunkt**.

Nebenwirkung derselben Luecke, mit behoben: `validateProvider` entscheidet auch,
ob ein Provider einen Schluessel im Schluesselbund halten darf
(`api-key-handlers.ts`). Ein `network:*`-Server mit `apiKeyRequired: true` konnte
das vorher nicht.

### Was `registerTenant` daraus macht (gemessen)

| Schutzstufe | erlaubt? | Vorschlag |
|---|---|---|
| public | **ja** | – |
| internal | nein | `anthropic` |
| confidential | nein | `ollama` |

```
origin erzwungen : {"residency":"unknown","operator":"tenant-supplied",
                    "weightsLicense":"closed","hostingMode":"rented","dpaStatus":"none"}
Trust            : public       (unveraendert — keine Vertrauensstufe gewonnen)
gilt als Cloud   : true         -> Sensitive-Scan + Upload-Consent laufen
ollama unberuehrt: confidential / nicht-Cloud
```

Das ist genau das gewuenschte Verhalten, und es entsteht **ohne** Aenderung an der
Policy, an `residencyIsCloud` oder an der `Residency`-Union:

- harmloser Inhalt geht auf den gewaehlten Rechner statt in die US-Cloud;
- ab `medium` bleibt der Rechner abgelehnt, weil die App nicht verifizieren kann,
  wer ihn betreibt — das ist die Logik von I2 und sie trifft hier zu;
- der Consent-Zweig laeuft, weil Inhalt das Geraet verlaesst;
- I2 bleibt gewahrt: die Origin wird erzwungen, die Config kann sie nicht setzen.

### Was umgesetzt wurde

1. `LocalAIBridge.registerServer()` traegt den Provider ins Registry ein;
   `unregisterServer()` ruft `registry.remove(providerId)` — die Methode ist fuer
   genau diesen Fall da und dokumentiert («configuration can be withdrawn»).
2. Nicht `registerTenant` wortwoertlich, sondern `registerLocalNetwork` daneben:
   `operator: 'tenant-supplied'` und `hostingMode: 'rented'` sind fuer einen
   Rechner in der eigenen Wohnung sachlich falsch. Beide Methoden teilen
   `registerWithForcedOrigin`, damit I2 an **einer** Stelle durchgesetzt wird und
   die zwei Registrierungen nicht auseinanderlaufen koennen.
3. Die Provider-Config wird **einmal** gebaut und an Client-Manager *und*
   Registry gegeben. Koennte der deklarierte Endpunkt vom gewaehlten abweichen,
   waere genau der Defekt aus #54 wieder moeglich.
4. Roter Test zuerst, gemessen am Rueckgabewert von `preflightGuard` — dem Wert,
   den `ipc-handlers.ts:196` dem Sendepfad uebergibt.

**Was NICHT gemacht wurde:** die Provider gar nicht registrieren und statt dessen
den Guard anpassen. Das ist derselbe Irrweg wie bei #52 — der Guard ist richtig,
das Vokabular war unvollstaendig.

### Korrektur gegenueber dem ersten Entwurf: `dpaStatus`

Der erste Entwurf dieser Vorlage empfahl `dpaStatus: 'not-applicable'`. Das ist
geaendert zu **`'none'`**, aus zwei Gruenden:

- Der Typ-Kommentar in `provider-types.ts:230-237` bindet `'not-applicable'` an
  «endpoints where no third party processes anything — on-device execution» und
  stellt es ausdruecklich `'none'` gegenueber, «which means an agreement is
  missing». Bei einem Rechner im Netz ist genau das der Fall: die App sieht eine
  Adresse und weiss nicht, wer die Maschine betreibt.
- Heute macht es keinen Unterschied — `trustFromOrigin` deckt nur `'signed'` und
  `'byok-tenant'`, beides fuehrt zu `PUBLIC`. Aber der Kommentar laedt dazu ein,
  `'not-applicable'` spaeter als gedeckt zu lesen. Dann wuerde ein LAN-Server
  still Vertrauen gewinnen. `'none'` kann das nie. Praezedenz fuer dieselbe
  Vorsicht steht in `transcription-targets.ts:64`.

### Welche Origin-Felder ueberhaupt tragen (gemessen 27.11.)

Gegengemessen ueber alle Leser der Felder in `src/`:

| Feld | Gelesen von | Wirkung |
|---|---|---|
| `residency` | `policy-engine.ts:69`, `residencyIsCloud`, `provider-trust.ts:44-50`, Audit | tragend |
| `dpaStatus` | `provider-trust.ts:46` | tragend |
| `operator`, `weightsLicense`, `hostingMode` | nichts ausser dem Audit-Eintrag | Dokumentation |

Darum liegt die Sorgfalt auf den ersten zwei; die anderen drei tragen die
vorsichtige Lesart (`weightsLicense: 'closed'`, weil ein
`openai-compatible`-Server im LAN beliebiges weiterreichen kann) statt einer
Vermutung.

---

## Entscheid 2 — LAN-Pooling und ein eigener `Residency`-Wert

### Was ein neuer Wert kosten wuerde

`Residency` wird an genau fuenf entscheidenden Stellen gelesen:
`residencyIsCloud` (`provider-types.ts:222`), `trustFromOrigin` drei Mal
(`provider-trust.ts:44,49,50`), und `evaluate()` ueber `allowedResidency`
(`policy-engine.ts:69`). Dazu die Audit-Zeile (`audit-writer.ts:23`) und
`DEFAULT_POLICY` selbst. Ein neuer Wert heisst also: vier Guards neu entscheiden,
die Policy-Version hochziehen, und die Invarianten-Tests nachziehen.

### Warum er nicht gebraucht wird

Ein LAN-Pool ist aus Sicht der Policy **dasselbe** wie ein einzelner LAN-Server:
Inhalt verlaesst das Geraet, und die App kann nicht verifizieren, wer die Maschinen
betreibt. Beides beschreibt `'unknown'` korrekt. Pooling ueber mehrere Maschinen
braucht also **eine eigene Provider-ID** (etwa `lan-pool`, mit eigenem Balancer
oder einem nach Klasse getrennten Pool) — aber keinen neuen Wert in der Union.

Der einzige Grund fuer einen neuen Wert waere, **vertrauliche** Inhalte auf die
eigenen LAN-GPUs zu lassen. Das ist keine technische, sondern eine rechtliche
Aussage: betreibt der Nutzer die Maschine selbst, gibt es keinen Auftragsverarbeiter
und damit auch keine DPA-Frage — nur kann die App das nicht feststellen, sie sieht
eine IP. Die Aussage muesste also vom Nutzen kommen.

### Empfehlung

**Jetzt: nichts bauen.** Mit dem Fix aus Entscheid 1 ist ein LAN-Server fuer
gewoehnliche Inhalte nutzbar, und das deckt den Anwendungsfall «mehr Durchsatz auf
der Maschine im Keller» fuer alles ab, was nicht vertraulich ist.

**Wenn es kommt, in dieser Reihenfolge:**

1. eigene Provider-ID fuer den Pool, Origin `'unknown'` — rein mechanisch, keine
   Policy-Aenderung, kein neuer Wert;
2. erst wenn vertraulicher Inhalt dorthin soll: neuer Wert (Vorschlag
   `'self-hosted-lan'`), hinter einer **ausdruecklichen Zusicherung** des Nutzers
   («diese Maschinen betreibe ich selbst, in meinem Netz»), die als Datum im
   Audit-Eintrag landet — nicht als Default, nicht aus der Konfiguration
   abgeleitet, und mit einer eigenen Policy-Regel statt einer Erweiterung von
   `sensitive-stays-ch`.

Punkt 2 ist Produkt- und Datenschutzentscheid, nicht Implementierung. Vorher
lohnt die Frage, ob ihn ueberhaupt jemand will — bisher hat ihn niemand angefragt,
und der Datei-Header des Balancers haelt die Faehigkeit bereits als verschoben fest.

---

## Nebenbefund, geprueft und unbedenklich

`src/main/transcription/transcription-targets.ts:39` fuehrt eine **zweite**
`residency: 'on-device'`-Deklaration. Sie hat **nicht** die Form von #54: hinter
dem Eintrag steht kein konfigurierbarer Endpunkt und kein Pool, sondern eine
statische Liste, aus der `resolveTarget` den ersten von der Policy erlaubten
Eintrag nimmt. Die Fitness-Werte sind bewusst auf 0, damit ein Transkriptionsziel
keine Chat-Routing-Entscheidung gewinnen kann. Kein Handlungsbedarf.

Der `ch-endpoint`-Eintrag daneben traegt einen `DEBT:`-Marker mit sauberer
Upgrade-Bedingung — unveraendert gueltig, hier nur zur Vollstaendigkeit erwaehnt.

---

## Wie gemessen wurde

Zwei Probe-Skripte gegen `origin/main` in einem eigenen Worktree, mit der **echten**
`seedBuiltInProviders`-Seeding und der **echten** `DEFAULT_POLICY`; im selben Lauf
jeweils `ollama` als Positivkontrolle, damit ein «nein» fuer `network:*` nicht bloss
ein kaputtes Probe-Skript ist. Die Skripte sind nach der Messung entfernt; der
Bugfix aus Entscheid 1 bringt die Messung als Test mit, nicht als Skript.

Der Fix selbst ist an einem **roten Test** gebaut, nicht an den Skripten:
`tests/unit/network-provider-has-an-origin.test.ts`. Vor der Aenderung
**7 rot / 8 gruen**, danach 15 gruen. Die aussagekraeftigste rote Zeile war
`expected 'anthropic' to be 'network:192.168.1.50:11434'` — gemessen am
Rueckgabewert von `preflightGuard`, also an dem Wert, den der Sendepfad als
Provider uebernimmt, nicht an einem Zwischenergebnis. Dass 8 Tests im selben Lauf
gruen blieben (Klassifikation, abgelehnte vertrauliche Inhalte, `ollama` als
Kontrolle, erfundene ID weiter abgelehnt), unterscheidet einen Code-Befund von
einem Umgebungsfehler: `Tests 0 failed` bei roten Dateien waere Umgebung gewesen.

Eine Messung unterwegs war erst falsch und ist korrigiert: ein `grep -c` mit
`\|`-Alternation durch mehrere Quoting-Schichten meldete **0** Treffer fuer
`assertOnDevice` in `origin/main`, obwohl `c8fa916` in `main` steht. Gegengemessen
mit Python: 3 Treffer. Die Zaehlung war das Instrument, nicht der Befund.
