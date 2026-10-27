# Aufbewahrungsfristen für Sitzungsaufnahmen und Transkripte

**Stand: 27.10.2026** · Recherchegrundlage für den offenen Entscheid aus
`2026-10-25-transkriptions-service-design.md` Abschnitt 8 und für die Vorgabewerte
in `src/main/transcription/retention.ts`.

> Dies ist eine belegte Recherche, keine Rechtsberatung. Jede Aussage nennt ihre
> Quelle. Was nicht belegt ist, steht unter «Nicht beantwortet» — dort braucht es
> eine anwaltliche Einschätzung, bevor etwas davon in eine Kundenzusage einfliesst.

---

## 1. Kernbefund

**Für eine Sitzungsaufnahme und ihr Transkript gibt es keine gesetzliche
Aufbewahrungs*frist*. Das Gesetz verlangt das Gegenteil: Löschung, sobald der
Zweck erfüllt ist.**

Art. 6 Abs. 4 DSG im Wortlaut:

> «Sie werden vernichtet oder anonymisiert, sobald sie zum Zweck der Bearbeitung
> nicht mehr erforderlich sind.»

Die Kommentierung nennt das den **Grundsatz der zeitlichen Limitierung der
Datenbearbeitung** und zählt ihn zu den Bearbeitungsgrundsätzen, deren Verletzung
eine Persönlichkeitsverletzung darstellt (OK-Gaul, Art. 6 Abs. 3–5 DSG, N 30).

Die Frist ist damit **keine Zahl, die man nachschlägt, sondern eine Ableitung aus
dem Zweck.** Wer eine Zahl setzt, muss sie aus dem Zweck begründen können.

## 2. Was eine längere Aufbewahrung rechtfertigt

Eine weitere Bearbeitung kann nach Art. 31 Abs. 1 DSG gerechtfertigt sein. Die
Kommentierung nennt dafür (N 31):

| Grundlage | Frist | Gegenstand |
|---|---|---|
| Art. 958f OR | **10 Jahre** ab Ablauf des Geschäftsjahres | Geschäftsbücher, Buchungsbelege, Geschäftsbericht, Revisionsbericht |
| Art. 70 Abs. 2 MWSTG | bis zur absoluten Verjährung der Steuerforderung | Geschäftsbücher, Belege, Geschäftspapiere; Art. 958f OR vorbehalten |
| Art. 70 Abs. 3 MWSTG | **20 Jahre** | **nur** Unterlagen zur Einlageentsteuerung und zum Eigenverbrauch bei **unbeweglichen Gegenständen** |
| Verjährungsvorschriften, absehbare Rechtsstreitigkeiten | — | berechtigtes Interesse im Einzelfall (N 31) |

**Wichtig zur 20-Jahre-Frist:** die Fussnote der Kommentierung nennt sie ohne
Einschränkung. Der Gesetzestext bindet sie an Einlageentsteuerung und
Eigenverbrauch bei Liegenschaften — für Sitzungsaufnahmen also ohne Bedeutung.
Die Einschränkung ist eigens nachgeprüft worden.

**Alle diese Pflichten hängen an Rechnungswesen-Unterlagen, nicht an Aufnahmen.**
Siehe dazu Abschnitt 6.

## 3. Der eine Bereich, in dem das Recht eine Aufnahme *verlangt*

**MiFID II Art. 16 Abs. 7** (Richtlinie 2014/65/EU) verpflichtet Wertpapierfirmen,
Telefongespräche und elektronische Kommunikation aufzuzeichnen, die sich auf
Annahme, Übermittlung und Ausführung von Kundenaufträgen sowie auf den Eigenhandel
beziehen, und sie **mindestens fünf Jahre** aufzubewahren.

Das ist die Umkehrung des Normalfalls: hier ist die Aufnahme Pflicht und das
Löschen wäre der Verstoss. Relevant für Kunden im regulierten Finanzbereich —
auch für Schweizer Häuser, soweit sie EU-Kunden bedienen.

*Belegstärke:* ESMA-Q&A und Sekundärquellen; der Richtlinientext selbst wurde für
diese Notiz nicht gelesen. Eine schweizerische Entsprechung (FIDLEG) mit
Aufzeichnungs*pflicht* wurde nicht gefunden — FIDLEG verlangt Dokumentation der
Beratung, nicht deren Tonaufnahme.

## 4. Die Einwilligung begrenzt zusätzlich — und sie legt den Zweck fest

Der EDÖB zur Aufzeichnung von Gesprächen:

- Bei **Nicht-Telefongesprächen** ist das Aufnehmen ohne Einwilligung **aller**
  Beteiligten strafbar.
- Die Einwilligung muss «möglichst klar und transparent über die
  Gesprächsaufzeichnung und den Zweck der Aufzeichnung informieren».
- «Wichtig ist, dass die Einwilligung **vor** der Aufzeichnung eingeholt wird»,
  damit widersprochen werden kann.
- Für straflos ohne vorherige Information aufgenommene Massengeschäfte gilt: sie
  dürfen «ausschliesslich zur Beweissicherung verwendet werden», und «auch die
  Auswertung solcher Aufnahmen über Beweiszwecke hinaus ist unzulässig».

**Der EDÖB nennt auf dieser Seite keine Aufbewahrungsfrist.** Das ist kein
Versäumnis, sondern folgerichtig: die Frist ergibt sich aus dem Zweck, und den
legt die Einwilligung fest.

**Praktische Folge für das Produkt:** Lautet die Einwilligung «zur Erstellung des
Protokolls», ist der Zweck erfüllt, sobald das Protokoll vorliegt. Eine
Aufbewahrung darüber hinaus braucht einen eigenen Grund — und die Einwilligung
sollte die Frist von Anfang an nennen.

## 5. «Vernichten» ist mehr als «Löschen» — das trifft unsere Umsetzung

Die Kommentierung (N 32):

> «Vernichten bedeutet im eigentlichen Sinne die unwiederbringliche Zerstörung
> bzw. Entfernung der Daten.»

Und ausdrücklich: «Übliche Löschbefehle oder eine reine Umformatierung stellen
gemäss Botschaft zum DSG kein Vernichten im datenschutzrechtlichen Sinn dar.»

Dazu: «Bei elektronischen Daten ist nicht nur relevant, wie diese gespeichert
werden, sondern auch, wie diese erhalten wurden.» Zwischenkopien zählen mit.

**Was das für uns heisst:**
- `fs.rmSync` ist ein üblicher Löschbefehl. Die Blöcke bleiben auf dem Datenträger.
- Die Spool-Kopie ist genau so eine Zwischenkopie.

**Nicht abschliessend geklärt:** Die Kommentierung hält fest, dass die Literatur
mehrheitlich annimmt, es handle sich bei Art. 6 Abs. 4 DSG um ein redaktionelles
Versehen und Löschen genüge — und schliesst sich dem an, sofern kein Personenbezug
mehr herstellbar ist (N 33). Die Frage ist also **umstritten, nicht entschieden.**
Für eine Zusage gegenüber Kunden braucht es hier eine anwaltliche Einschätzung.

## 6. Ist eine Aufnahme ein Buchungsbeleg?

**Keine der konsultierten Quellen behandelt diese Frage.** Weder die Kommentierung
noch die Ratgeberliteratur zu Art. 958f OR erwähnt Ton- oder Videoaufnahmen.

Die Systematik spricht dagegen: Art. 958f OR nennt Geschäftsbücher,
Buchungsbelege, Geschäftsbericht und Revisionsbericht. Eine Sitzungsaufnahme ist
keines davon.

**Das Protokoll ist eine andere Sache.** Art. 713 Abs. 3 OR verlangt ein Protokoll
über die Verhandlungen und Beschlüsse des Verwaltungsrats, unterzeichnet vom
Vorsitzenden und vom Protokollführer (Sekundärquelle, Gesetzestext nicht gelesen).
Das Protokoll ist das Arbeitsergebnis — die Aufnahme ist das Rohmaterial dazu.

Das ist die wichtigste Unterscheidung dieser Notiz: **Aufnahme, Transkript und
Protokoll sind drei Dinge mit drei verschiedenen Lebensdauern**, und nur das
letzte hat überhaupt eine Chance, unter eine Aufbewahrungspflicht zu fallen.

## 7. Was die Kommentierung ausdrücklich von Software verlangt

N 35: Die Verantwortlichen sollen sich eine Übersicht über die Datenbearbeitungen
verschaffen und «sodann sollten die jeweiligen Aufbewahrungs- und Löschfristen
festgelegt werden», praktischerweise als interne Richtlinie
(«Aufbewahrungsrichtlinie» / «Data Retention Policy»).

N 36, wörtlich:

> «Hilfreich für die Umsetzung ist es, wenn die zur Datenverarbeitung verwendete
> Software bereits entsprechende Funktionalitäten für automatisierten Löschung
> anbietet, wobei zum einen darauf geachtet werden sollte, dass diese in
> technischer Hinsicht den datenschutzrechtlichen Anforderungen genügen, zum
> anderen, dass die Pflicht zur Löschung im Rahmen von
> Auftragsdatenbearbeitungsverträgen mit dem IT-Provider/Cloud-Anbieter auch
> vertraglich hinreichend abgedeckt wird.»

**Das ist unsere Produktanforderung, von der Quelle her formuliert:** automatische
Löschung in der Software, einstellbare Fristen, und die Löschpflicht im AVV
abgebildet. Genau das ist `purgeExpired` plus Fristen pro Arbeitsbereich.

## 8. Folgerung für Mingly

**Wir setzen die Fristen des Kunden nicht fest.** Der Kunde ist der
Verantwortliche im Sinne von Art. 5 lit. j DSG und legt seine Fristen in seiner
Aufbewahrungsrichtlinie fest. Das entspricht dem Entscheid «Lieferant zuerst,
Betrieb als zweite Stufe» aus dem Design.

Was wir liefern müssen:
1. den Mechanismus (automatische Löschung),
2. die Einstellbarkeit pro Arbeitsbereich — ein Betrieb hat je Kunde andere Fristen,
3. eine Vorgabe, die ohne Konfiguration verteidigbar ist,
4. die Dokumentation, damit der Kunde sie in seine Richtlinie übernehmen kann.

**Drei Uhren statt zwei.** Die heutige Umsetzung kennt `audioDays` und
`transcriptDays`. Die Recherche legt eine dritte Grösse nahe, die wir bisher nicht
führen: die Job-Zeile selbst. Sie enthält nach dem Purge keinen Inhalt mehr — aber
bei einem abgelehnten Auftrag den Dateinamen des Nutzers, und ein Dateiname kann
ein Gespräch beschreiben. Das ist im Code bereits offen benannt.

### Zur Vorgabe

Die aktuelle Vorgabe (30 Tage Audio, 365 Tage Transkript) stammt von niemandem —
sie wurde beim Bauen gesetzt, weil ein Wert nötig war.

Aus der Recherche ergibt sich kein gesetzlicher Wert, aber ein Massstab: **die
Vorgabe soll die kürzeste Frist sein, die den Zweck noch erfüllt.** Für die
Aufnahme ist der Zweck mit dem geprüften Transkript erfüllt; was danach bleibt,
ist allein der Wunsch, bei einem Fehler neu transkribieren zu können. Das sind
Tage, keine Monate. Für das Transkript ist der Zweck das Arbeitsergebnis — hier
entscheidet die Dokumentationslage des Kunden, und 365 Tage sind eine plausible,
aber eben kundenseitige Grösse.

**Das bleibt ein Produktentscheid, kein Rechtsgebot.** Die Recherche sagt nur,
in welche Richtung er zu begründen ist.

## 9. Nicht beantwortet — hierfür braucht es eine anwaltliche Einschätzung

1. **Genügt `unlink` als «Vernichten»?** Umstritten (Abschnitt 5). Betrifft jede
   Zusage, die wir zum Löschen machen.
2. **Ist eine Stimmaufnahme ein besonders schützenswertes Personendatum?**
   Art. 5 lit. c Ziff. 4 DSG nennt «biometrische Daten, die eine natürliche Person
   eindeutig identifizieren». **Keine konsultierte Quelle behandelt die Stimme.**
   Die naheliegende Lesart — nur wenn zur Identifikation verarbeitet — ist eine
   Schlussfolgerung, kein Beleg.
3. **Kann eine Aufnahme je Buchungsbeleg sein?** Keine Quelle (Abschnitt 6).
4. **Branchenspezifische Pflichten** der Zielbranche. Die Zielbranche ist im
   Design noch offen (Entscheid 5); erst mit ihr lässt sich das prüfen. Kandidaten:
   Finanzsektor (MiFID II, GwG), Gesundheitswesen (kantonale Patientendossiers),
   Anwaltschaft (Berufsgeheimnis).
5. **MiFID-II-Betroffenheit** schweizerischer Kunden mit EU-Geschäft.

---

## Quellen

- **Art. 6 Abs. 4 DSG, Wortlaut und Kommentierung:** Caroline Gaul, Kommentierung
  zu Art. 6 Abs. 3–5 DSG, in: Thomas Steiner / Anne-Sophie Morand / Daniel
  Hürlimann (Hrsg.), Onlinekommentar zum Bundesgesetz über den Datenschutz,
  Stand der Bearbeitung 28.03.2025, DOI 10.17176/20250328-214043-0.
  <https://onlinekommentar.ch/de/kommentare/dsg6abs3-5>
- **EDÖB, Aufzeichnung von Gesprächen:**
  <https://www.edoeb.admin.ch/de/aufzeichnung-von-gespraechen>
- **Art. 958f OR:** <https://justement.ch/de/doc/act/ch/220/div_3/tit_32/chap_1/art_958_f>
  und <https://www.droit-bilingue.ch/de-en/2/22/220-958f-1336.html>
- **Art. 70 MWSTG:** <https://justement.ch/de/doc/act/ch/641_20/tit_5/chap_1/art_70>
- **MiFID II Art. 16:** <https://gesetze.legal/eu/rl_2014_65_eu/16>, ESMA-Q&A
  <https://www.esma.europa.eu/node/204118>
- **Art. 5 lit. c DSG, Kategorien:**
  <https://onlinekommentar.ch/de/kommentare/dsg5c> ·
  <https://www.pwc.ch/de/insights/regulierung/besonders-schuetzenswerte-personendaten.html>

**Nicht erreichbar:** Fedlex (`fedlex.admin.ch`) gibt über automatisierten Abruf
nur die Sprachauswahl heraus — HTML, PDF und XML gleichermassen. Der
DSG-Wortlaut in Abschnitt 1 stammt daher aus dem Normtext, den der
Onlinekommentar seiner Kommentierung voranstellt, nicht aus der amtlichen
Sammlung. Vor einer Kundenzusage am amtlichen Text gegenprüfen.
