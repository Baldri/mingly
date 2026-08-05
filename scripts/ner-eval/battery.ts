/**
 * Ground-truth battery for comparing candidate NER models.
 *
 * Purpose: pick a model for person-name detection BY MEASUREMENT, not by
 * model card. piiranha-v1 documents 93%/78% recall for GIVENNAME/SURNAME and
 * delivers zero on every sentence below — that is exactly why this file
 * exists.
 *
 * `persons` are the spans that MUST be found (the capability we are buying).
 * `alsoExpected` are categories piiranha currently delivers; they are listed
 * so a swap makes visible what it would COST, not only what it gains.
 */

export interface Case {
  text: string
  /** Person names that must be detected. Empty = must NOT produce a person. */
  persons: string[]
  /** Non-person spans piiranha currently finds — regression surface on swap. */
  alsoExpected?: { address?: string[]; location?: string[]; dob?: string[] }
  note?: string
}

export const BATTERY: Case[] = [
  // ── German, the primary target ────────────────────────────────────
  { text: 'Anna Meier arbeitet in Bern.', persons: ['Anna Meier'], alsoExpected: { location: ['Bern'] } },
  { text: 'Ich heisse Anna Meier.', persons: ['Anna Meier'] },
  { text: 'Mein Name ist Anna Meier und ich wohne in Bern.', persons: ['Anna Meier'], alsoExpected: { location: ['Bern'] } },
  { text: 'Sehr geehrte Frau Anna Meier, Ihre Bestellung ist unterwegs.', persons: ['Anna Meier'] },
  { text: 'Bitte überweise den Betrag an Hans Müller.', persons: ['Hans Müller'] },
  {
    text: 'Der Patient Hans Müller, geboren 1980, wohnt an der Bahnhofstrasse 12 in Zürich.',
    persons: ['Hans Müller'],
    alsoExpected: { address: ['Bahnhofstrasse', '12'], location: ['Zürich'], dob: ['1980'] },
    note: 'Positivkontrolle fuer den Bestand: piiranha liefert hier vier Entitaeten, aber keinen Namen.'
  },
  { text: 'Termin mit Dr. Sandra Keller am Dienstag.', persons: ['Sandra Keller'] },
  { text: 'Zürcher-Gehrig AG, Ansprechpartner: Beat Zimmermann.', persons: ['Beat Zimmermann'] },

  // ── English ───────────────────────────────────────────────────────
  { text: 'My name is John Smith and I live in Boston.', persons: ['John Smith'], alsoExpected: { location: ['Boston'] } },
  { text: 'Please contact Sarah Johnson about the invoice.', persons: ['Sarah Johnson'] },
  { text: 'Patient: John Smith, DOB: 01/02/1980, Address: 12 Main Street, Boston.', persons: ['John Smith'], alsoExpected: { address: ['Main Street'], location: ['Boston'], dob: ['01/02/1980'] } },

  // ── Must NOT fire: no person present ──────────────────────────────
  { text: 'Heute ist ein schöner Tag.', persons: [] },
  { text: 'Die Rechnung ist am Montag faellig.', persons: [] },
  {
    text: 'Kontakt: anna.meier@example.ch',
    persons: [],
    note: 'Der Regex-Layer matcht die ganze E-Mail. Ein Namenstreffer INNERHALB davon erzeugt genau die verschachtelten Spans, die PR #12 aufgeloest hat — hier also unerwuenscht.'
  },

  // ── Haertere Faelle ───────────────────────────────────────────────
  // Die Basis-Batterie oben trennt zwei gute Kandidaten nicht (beide 11/11).
  // Diese Faelle sollen unterscheiden: Nachname allein, Titel, invertierte
  // Schreibweise, Kleinschreibung, Name neben Organisation, und LOC-only-
  // Saetze, in denen KEIN Name stehen darf.
  { text: 'Wir treffen Herrn Meier morgen um zehn.', persons: ['Meier'], note: 'Nachname allein, ohne Vorname' },
  { text: 'Ich habe mit Bundesrat Cassis gesprochen.', persons: ['Cassis'], note: 'Titel + Nachname, CH-Kontext' },
  { text: 'Schmid, Andrea — Abteilung Einkauf', persons: ['Schmid', 'Andrea'], note: 'Invertiert mit Komma' },
  { text: 'Betreff: Kündigung von Peter Zwahlen per 31.12.', persons: ['Peter Zwahlen'] },
  { text: 'Es grüsst Sie freundlich, M. Brunner', persons: ['Brunner'], note: 'Initial + Nachname' },
  { text: 'Die Firma Nestlé hat Frau Sommaruga eingeladen.', persons: ['Sommaruga'], note: 'ORG und PER im selben Satz — Verwechslungsgefahr' },
  { text: 'Dr. Jane Q. Public will attend the meeting.', persons: ['Jane', 'Public'], note: 'Mittelinitial' },

  // Kein Name — aber Ortsnamen, die als Personen missdeutet werden koennten
  { text: 'Der Zug fährt über Olten nach Basel.', persons: [], alsoExpected: { location: ['Olten', 'Basel'] } },
  { text: 'Bern ist die Hauptstadt der Schweiz.', persons: [], alsoExpected: { location: ['Bern'] } },
  { text: 'Zürich und St. Gallen sind gut verbunden.', persons: [], alsoExpected: { location: ['Zürich'] } },
  {
    text: 'muster ist ein haeufiger nachname in der schweiz.',
    persons: [],
    note: 'Kleinschreibung + generische Aussage: ein Treffer waere ein Fehlalarm, kein Fund.'
  }
]

/** Labels a candidate may use for a person, normalised upper-case. */
export const PERSON_LABELS = new Set([
  'PER', 'PERSON', 'B-PER', 'I-PER', 'B-PERSON', 'I-PERSON',
  'GIVENNAME', 'SURNAME', 'I-GIVENNAME', 'I-SURNAME'
])

export const ADDRESS_LABELS = new Set(['STREET', 'I-STREET', 'BUILDINGNUM', 'I-BUILDINGNUM', 'ADDRESS'])
export const LOCATION_LABELS = new Set(['LOC', 'I-LOC', 'B-LOC', 'CITY', 'I-CITY', 'LOCATION', 'GPE'])
export const DOB_LABELS = new Set(['DATEOFBIRTH', 'I-DATEOFBIRTH', 'DATE_OF_BIRTH', 'DATE'])
