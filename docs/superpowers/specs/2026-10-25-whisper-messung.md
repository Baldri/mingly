# Whisper-Messung auf Apple M5 — Spike-Report

**Datum:** 2026-10-25
**Zweck:** Das Exit-Kriterium aus Abschnitt 5 des Transkriptions-Designs beantworten.
**Art:** Wegwerf-Spike. Die Messskripte liegen im Scratchpad, nicht im Repo.
**Zugehoeriges Design:** `2026-10-25-transkriptions-service-design.md`

---

## 1. Das Wichtigste in drei Saetzen

Auf Apple Silicon ist lokale Transkription **unproblematisch**: `large-v3` schafft
41,6 Minuten Audio in 3,7 Minuten (11x Echtzeit) bei **5,96 %** Wortfehlerrate auf
sauberer Sprache; ohne GPU sind es 1,50x Echtzeit, mit `turbo` 2,33x. Der entscheidende
Befund ist aber kein Leistungswert, sondern ein
**Parameter**: ohne `--max-context 0` laufen beide Modelle in Wiederholungsschleifen
und verlieren bis zu 58 % des Materials, bei Fehlerraten um 46 %. Schweizerdeutsch
wurde **nicht** gemessen, Sprechertrennung **nicht** getestet.

---

## 2. Messumgebung

| | |
|---|---|
| Maschine | Apple **M5**, 10 Kerne (4 Performance, 6 Efficiency), 32 GB |
| System | macOS 26.6.2 (Build 25G83) |
| Laufzeit | whisper.cpp **1.9.5** (Homebrew), Flash Attention an (Default) |
| Modelle | `ggml-large-v3-q5_0` (1031 MB), `ggml-large-v3-turbo-q5_0` (547 MB) |
| Aufruf | `-l de -t 4 -np -nt`, GPU per Metal, CPU-Laeufe mit `-ng` |

Alle Laeufe **strikt sequenziell** - parallele Laeufe teilen sich CPU und GPU und
verfaelschen genau die Messgroesse.

## 3. Testmaterial

Zwei selbst erzeugte Audiodateien, Sprachsynthese `say -v Anna` (de_DE), 16 kHz mono.
Der Referenztext ist damit **exakt** bekannt, was eine Fehlerrate erst messbar macht.

| Material | Laenge | Woerter | einmalige Woerter | Vielfalt |
|---|---|---|---|---|
| **Prosa** (Fachtext ueber Protokollfuehrung) | 366,1 s | 855 | 535 | 0,626 |
| **Baukasten** (generierte Sitzungssaetze) | 2497,9 s | 4813 | 76 | 0,016 |

Das Messwerkzeug fuer die Wortfehlerrate (Levenshtein auf Wortebene, eigene
Implementierung) wurde mit **neun Faellen mit bekanntem Erwartungswert** geprueft,
alle bestanden - darunter `"Rückfrage"` gegen `"Rueckfrage"` → 1,0.
Normalisierung: Kleinschreibung, Satzzeichen als Trenner, `ß` → `ss`.

---

## 4. Ergebnisse

### 4.1 Der Parameter entscheidet alles

Identische Laeufe, einzige Aenderung `-mc 0` (kein Textkontext zwischen Segmenten,
entspricht `condition_on_previous_text=False`):

| Lauf | Quote **ohne** `-mc 0` | Quote **mit** `-mc 0` | WER ohne | WER mit |
|---|---|---|---|---|
| Prosa, large-v3 | 77,5 % | **94,5 %** | 45,96 % | **5,96 %** |
| Prosa, turbo | 65,7 % | **92,9 %** | 40,58 % | **7,72 %** |
| 41,6 min, large-v3 | 84,6 % | **89,3 %** | - | - |
| 41,6 min, turbo | 42,4 % | **88,4 %** | - | - |

"Quote" ist das Verhaeltnis ausgegebener zu erwarteten Woertern. Ohne den Parameter
brechen die Transkripte mitten im Text ab und wiederholen einen Satz, obwohl im Audio
noch Sprache liegt (per Stille-Erkennung geprueft).

Mit `-mc 0` ist die Verarbeitung **zusaetzlich schneller**, weil keine Schleifen mehr
dekodiert werden: Faktor 0,117 → 0,080 (large) und 0,053 → 0,029 (turbo).

### 4.2 Durchsatz mit korrektem Parameter

| Modell | Rechenwerk | Faktor | Echtzeit | 1 Stunde Audio braucht |
|---|---|---|---|---|
| large-v3 | Metal (GPU) | 0,088 | 11,4x | **5,3 min** |
| large-v3 | CPU, 4 Threads | 0,668 | 1,50x | **40 min** |
| turbo | CPU, 4 Threads | 0,429 | 2,33x | **26 min** |
| turbo | Metal (GPU) | 0,036 | 27,6x | **2,2 min** |

### 4.3 Laengenverhalten (ohne `-mc 0`, Material konstant)

Diese Reihe diente der Ursachensuche und zeigt, wie der Defekt mit der Laenge waechst:

| Audio | turbo | large-v3 |
|---|---|---|
| 6,0 min | 80,4 % | 86,6 % |
| 12,0 min | 79,4 % | 84,1 % |
| 24,0 min | 63,4 % | 84,3 % |
| 41,6 min | **42,4 %** | 84,6 % |

`large-v3` bleibt ueber die Laenge stabil, `turbo` kollabiert. **Mit** `-mc 0`
verschwindet der Unterschied (88,4 % gegen 89,3 %).

---

## 5. Antwort auf das Exit-Kriterium aus Design-Abschnitt 5

| Kriterium | Ergebnis |
|---|---|
| (a) MacBook Apple Silicon, Faktor unter 1,0 | **bestanden**, mit grossem Abstand (0,088 bzw. 0,036) |
| (b) Linux-Container, 4 vCPU ohne GPU | **haengt am Modell**: `large-v3` 1,50x, `turbo` 2,33x Echtzeit - auf echter Container-Hardware ungemessen |
| Fehlerrate fuer Protokollzwecke brauchbar | **ja** auf sauberer Sprache (5,96 %), fuer echte Sitzungen **unbekannt** |

**Zu (b), praezisiert nach dem CPU-Lauf mit `-mc 0`:** Die Antwort haengt am Modell.
`large-v3` bleibt bei 1,50x Echtzeit - eine Stunde Audio in 40 Minuten, zu knapp fuer
einen Dienst mit mehreren gleichzeitigen Nutzern. `turbo` erreicht **2,33x Echtzeit**
(eine Stunde in 26 Minuten) und ist auf CPU brauchbar, zum Preis von 7,72 % statt
5,96 % Fehlerrate.

Einschraenkung: vier Apple-M5-Performance-Kerne sind **staerker** als typische
Cloud-vCPUs. Ein 4-vCPU-x86-Container liegt darunter, moeglicherweise nahe 1x. Das ist
**nicht gemessen** und waere vor einer Zusage auf der Zielhardware zu pruefen.

**Produktfolge:** GPU ist Voraussetzung fuer die **Qualitaetsoption** (`large-v3`).
Fuer `turbo` ist ein CPU-Container denkbar, aber knapp und auf der Zielhardware
ungemessen. Entscheid 3 lautet damit nicht "GPU oder nicht", sondern "welches Modell
in welcher Betriebsform".

---

## 6. Vier Messfehler, offen dokumentiert

Drei der vier waren **Werkzeugfehler**, nicht Denkfehler - jedes Mal sah das Ergebnis
plausibel aus und war falsch. Das ist der eigentliche Lehrsatz dieses Spikes.

1. **`ue/ae/oe` statt Umlaute im Referenztext**, zweimal in derselben Sitzung.
   Die Sprachsynthese spricht die Buchstabenfolge anders, das Modell schreibt korrekte
   Umlaute, **jedes Umlautwort zaehlt als Substitution**. Signatur: 588 Substitutionen
   bei nur 96 Auslassungen. Festgeschrieben in Memory `tts-testmaterial-braucht-echte-umlaute`.
2. **Falsche Ursachenvermutung.** Der Wortverlust wurde zuerst mit einem
   Repetitions-Kollaps durch monotones Material erklaert - plausibel, und die Ausgabe
   las sich genau so. Die eigene A/B-Messung bei gleicher Laenge widerlegte es:
   `turbo` lieferte auf abwechslungsreicher Prosa **weniger** Text als auf monotonem
   Material. Die naheliegende Ursache war die falsche.
3. **BSD-`sed` kennt `\|` nicht.** Ein Suchausdruck ueber Exporte ergab **null**
   Treffer; derselbe Ausdruck mit `-E` ergab zehn. Der Nullbefund kam vom Werkzeug.
4. **`--max-context` auf Default `-1`.** Vier Laeufe haben die eigene Aufrufzeile
   gemessen, nicht die Modellqualitaet.

---

## 7. Was NICHT gemessen wurde

- **Schweizerdeutsch.** Es gibt keine `de_CH`-Stimme auf diesem Rechner, und beide
  ernsthaften Korpora sind non-commercial (STT4SG-350 unter META-SHARE
  NonCommercial-NoRedistribution und nur gegen eingesandtes Formular, SDS-200 unter
  CC BY-NC 4.0) - fuer eine Messung, die einen kommerziellen Entscheid stuetzt, die
  falsche Grundlage. **Der lizenzfreie Weg ist eine eigene Referenzaufnahme von zehn
  Minuten mit Hand-Transkript.** Ohne diese Zahl gibt es kein Dialekt-Versprechen.
- **Echte Sprache.** Sprachsynthese ist sauberer als ein Sitzungsraum. Die 5,96 % sind
  eine **Untergrenze**, kein Produktwert. Akzent, Nebengeraeusche, Durcheinanderreden,
  Entfernung zum Mikrofon fehlen vollstaendig.
- **Sprechertrennung.** Nicht getestet. Das Material hat eine einzige Stimme.
- **Der Rest der Parameter.** `--entropy-thold`, `--logprob-thold`,
  `--temperature-inc`, `--no-fallback` und die Sprachaktivitaetserkennung (`-vsd`,
  `-vmsd`) wurden nicht variiert. Nach dem Befund zu `--max-context` ist offen, wie
  viel dort noch liegt - in beide Richtungen.
- **CPU auf der Zielhardware.** Gemessen wurde auf vier Apple-M5-Performance-Kernen,
  nicht auf einem 4-vCPU-x86-Container. Die Werte sind damit optimistisch fuer genau
  die Betriebsform, um die es geht.

## 8. Produktfolgen

1. **GPU ist Voraussetzung fuer `large-v3`**, nicht zwingend fuer `turbo` (2,33x
   Echtzeit auf CPU). Entscheid 3 ist damit zu einer Modellfrage geworden - und die
   Zielhardware eines Containers ist noch zu messen.
2. **Die lokale App auf Apple Silicon ist unproblematisch** - 11x bis 28x Echtzeit.
3. **turbo ist der Default-Kandidat, large-v3 die Qualitaetsoption.** 7,72 % gegen
   5,96 % Fehlerrate bei 2,4-facher Geschwindigkeit. Das ist genau die "schnelle und
   genaue" Wahl aus dem Design, und sie ist jetzt mit Zahlen belegt.
4. **Die Parameterwahl ist ein Produktmerkmal, kein Detail.** Ein naiver Aufruf von
   `whisper-cli` liefert bei einer Stunde Sitzung Material mit ueber 40 % Fehlerrate.
   Das ist ein Argument fuer das Einbetten von TranscriboZH, wo diese Entscheidungen
   an echtem Schweizer Verwaltungsmaterial getroffen wurden (Entscheid 1).
5. **Das Produkt braucht eine eigene Qualitaetsmessung.** Ein Kunde hat keinen Ground
   Truth und wuerde einen 40-%-Fehlerlauf nicht erkennen. Wer Transkription verkauft,
   muss ihre Guete selbst pruefbar machen.
