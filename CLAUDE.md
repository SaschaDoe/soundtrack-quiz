# Soundtrack-Quiz

Statische Web-App (GitHub Pages, kein Build) für Soundtrack-Quizabende.
Live: https://saschadoe.github.io/soundtrack-quiz/

- `index.html`, `style.css`, `app.js` – die App (Vanilla JS, YouTube IFrame API)
- `lists/*.json` – veröffentlichte Listen, `lists/index.json` wird vom Skript generiert (nie von Hand pflegen)
- `drafts/*.json` – Entwürfe, an denen Sascha und Claude gemeinsam arbeiten
- `scripts/quiz.mjs` – `check`, `publish [--push] [--force]`, `index`

## Ablauf „Such mir Soundtracks zum Thema X“

1. **Brainstormen**: 10–15 Tracks zum Thema, Mischung aus Film, Serie, Spiel, Anime; leicht bis schwer;
   gern auch deutsche Klassiker. Bekannte, wiedererkennbare Stücke bevorzugen.
2. **YouTube-Links finden** mit yt-dlp (per `pip install --user yt-dlp` installiert):
   `python -m yt_dlp "ytsearch5:<Werk> <Stück> <Komponist>" --flat-playlist --print "%(id)s | %(duration)s | %(channel)s | %(title)s"`
   - Bevorzugt: offizielle Kanäle, „<Künstler> - Topic“-Kanäle, Label-Kanäle.
   - Keine Extended/1-Stunden-Versionen, keine Covers – außer das Original ist gesperrt (dann im Trivia erwähnen).
3. **Trivia**: 2–3 kurze, *stimmende* Fakten pro Track (auf Deutsch). Bei Unsicherheit per Websuche prüfen
   oder weglassen. Optional `hint` (Tipp für die Ratenden) und `start`/`end` in Sekunden für den Ausschnitt.
4. Entwurf als `drafts/<thema-slug>.json` speichern (Format unten), dann
   `node scripts/quiz.mjs check drafts/<datei>.json` – prüft Existenz, Ländersperre (DE), Einbett-Erlaubnis und ergänzt `duration`.
   Gesperrte Tracks ersetzen, bevor die Liste gezeigt wird.
5. Liste im Chat als kompakte Tabelle zeigen (Nr, Werk, Stück, Komponist/Jahr, Link). Sascha ändert → Entwurf anpassen.
6. Erst wenn Sascha sagt „passt / hochladen“: `node scripts/quiz.mjs publish drafts/<datei>.json --push`.
   Danach den Link zur Liste nennen: `https://saschadoe.github.io/soundtrack-quiz/#/liste/<id>` (Pages braucht ~1 Min).
   Erneutes Publish desselben Entwurfs überschreibt die Liste (id steht dann im Entwurf).

## Listenformat

```json
{
  "title": "Drachen",
  "theme": "drachen",
  "description": "Ein Satz für die Übersicht.",
  "tracks": [
    {
      "work": "Deutscher Titel des Films/Spiels",
      "workOriginal": "Originaltitel (optional)",
      "title": "Name des Stücks",
      "type": "Film | Serie | Spiel | Anime-Film | ...",
      "year": 2010,
      "composer": "John Powell",
      "url": "https://www.youtube.com/watch?v=XXXXXXXXXXX",
      "start": 0,
      "end": 60,
      "hint": "optional",
      "trivia": ["Fakt 1", "Fakt 2"]
    }
  ]
}
```
`id`, `created` und `duration` setzt das Skript. `duration` hilft der App, Werbung vom echten Video zu unterscheiden.

## Wie der Player Werbung behandelt (app.js, `TrackPlayer`)

„Vorbereiten“ startet das eingebettete Video **stumm**. Läuft die Zeit des echten Videos (richtige Video-ID,
Länge ≈ `duration`), wird pausiert, an `start` gespult und auf „Start“ gewartet (Start schaltet Ton an – muss ein
Klick sein, sonst blockiert Mobile-Safari den Ton). Zwischenwerbung während des Abspielens wird über „Zeit steht trotz
PLAYING“ erkannt und stumm geschaltet. Beim Start eines Tracks wird der nächste automatisch stumm vorgeladen.

Hinweis: Manche Label-Videos (Universal/Warner) verweigern das Einbetten auf `localhost` / `127.0.0.1`
(Fehler 150), funktionieren aber auf github.io. Zum Testen also die Live-Seite nehmen.
