"""Known whisper hallucinations, per language.

Taken over unchanged from TranscriboZH (`data/const.py`). Whisper reproduces
these subtitle credits from its training data when it hears silence or unclear
audio. The list is hand-maintained from real operation and cannot be derived
from anything, which is why it is taken over rather than rebuilt.

----------------------------------------------------------------------------
Taken over from https://github.com/machinelearningZH/audio-transcription

MIT License

Copyright (c) 2025 Canton of Zurich / Department of Justice and Home Affairs /
Statistical Office / Team Data

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
----------------------------------------------------------------------------

Upstream in turn credits https://github.com/openai/whisper/discussions/928 as
the source of the list.
"""

# Upstream defect, kept as found and verified at byte level on 2026-10-25: the
# "ru" and "zh" entries contain literal ASCII question marks, not Cyrillic or
# Chinese text. Upstream lost those characters at some point in its own
# history. The entries are therefore dead weight — they can never match a real
# Russian or Chinese hallucination. They are kept so that this file stays a
# faithful copy, but Russian and Chinese are NOT covered by the cleanup.
data_leaks: dict[str, list[str]] = {
    "en": [
        " www.mooji.org",
    ],
    "nl": [
        " Ondertitels ingediend door de Amara.org gemeenschap",
        " Ondertiteld door de Amara.org gemeenschap",
        " Ondertiteling door de Amara.org gemeenschap",
    ],
    "de": [
        " Untertitelung aufgrund der Amara.org-Community Untertitel im Auftrag des ZDF für funk, 2017",
        " Untertitel von Stephanie Geiges",
        " Untertitel der Amara.org-Community",
        " Untertitel im Auftrag des ZDF, 2017",
        " Untertitel im Auftrag des ZDF, 2020",
        " Untertitel im Auftrag des ZDF, 2018",
        " Untertitel im Auftrag des ZDF, 2021",
        " Untertitelung im Auftrag des ZDF, 2021",
        " Copyright WDR 2021",
        " Copyright WDR 2020",
        " Copyright WDR 2019",
        " SWR 2021",
        " SWR 2020",
    ],
    "fr": [
        " Sous-titres réalisés para la communauté d'Amara.org",
        " Sous-titres réalisés par la communauté d'Amara.org",
        " Sous-titres fait par Sous-titres par Amara.org",
        " Sous-titres réalisés par les SousTitres d'Amara.org",
        " Sous-titres par Amara.org",
        " Sous-titres par la communauté d'Amara.org",
        " Sous-titres réalisés pour la communauté d'Amara.org",
        " Sous-titres réalisés par la communauté de l'Amara.org",
        " Sous-Titres faits par la communauté d'Amara.org",
        " Sous-titres par l'Amara.org",
        " Sous-titres fait par la communauté d'Amara.org Sous-titrage ST' 501",
        " Sous-titrage ST'501",
        " Cliquez-vous sur les sous-titres et abonnez-vous à la chaîne d'Amara.org",
        " ?? par SousTitreur.com",
    ],
    "it": [
        " Sottotitoli creati dalla comunità Amara.org",
        " Sottotitoli di Sottotitoli di Amara.org",
        " Sottotitoli e revisione al canale di Amara.org",
        " Sottotitoli e revisione a cura di Amara.org",
        " Sottotitoli e revisione a cura di QTSS",
        " Sottotitoli e revisione a cura di QTSS.",
        " Sottotitoli a cura di QTSS",
    ],
    "es": [
        " Subtítulos realizados por la comunidad de Amara.org",
        " Subtitulado por la comunidad de Amara.org",
        " Subtítulos por la comunidad de Amara.org",
        " Subtítulos creados por la comunidad de Amara.org",
        " Subtítulos en español de Amara.org",
        " Subtítulos hechos por la comunidad de Amara.org",
        " Subtitulos por la comunidad de Amara.org Más información www.alimmenta.com",
        " www.mooji.org",
    ],
    "gl": [" Subtítulos realizados por la comunidad de Amara.org"],
    "pt": [
        " Legendas pela comunidade Amara.org",
        " Legendas pela comunidade de Amara.org",
        " Legendas pela comunidade do Amara.org",
        " Legendas pela comunidade das Amara.org",
        " Transcrição e Legendas pela comunidade de Amara.org",
    ],
    "la": [
        " Sottotitoli creati dalla comunità Amara.org",
        " Sous-titres réalisés para la communauté d'Amara.org",
    ],
    "ln": [" Sous-titres réalisés para la communauté d'Amara.org"],
    "pl": [
        " Napisy stworzone przez spolecznosc Amara.org",
        " Napisy wykonane przez spolecznosc Amara.org",
        " Zdjecia i napisy stworzone przez spolecznosc Amara.org",
        " napisy stworzone przez spolecznosc Amara.org",
        " Tlumaczenie i napisy stworzone przez spolecznosc Amara.org",
        " Napisy stworzone przez spolecznosci Amara.org",
        " Tlumaczenie stworzone przez spolecznosc Amara.org",
        " Napisy robione przez spolecznosc Amara.org www.multi-moto.eu",
    ],
    "ru": [" ???????? ????????? ?.???????? ????????? ?.???????"],
    "tr": [
        " Yorumlariniziza abone olmayi unutmayin.",
    ],
    "su": [" Sottotitoli creati dalla comunità Amara.org"],
    "zh": ["???Amara.org????", "?????Amara.org????"],
}
