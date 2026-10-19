# Doom Gauge

A daily index of how bleak the news is. Toy metric, straight face.

## How it works

1. `fetch_doom.py` (stdlib-only Python) pulls RSS/Atom from the feeds in
   `feeds.json`, scores each headline against `doom_lexicon.json`
   (word-boundary keyword weights, clamped 0–100), merges near-duplicate
   stories across sources (Jaccard ≥ 0.45 or 70% word-subset overlap), and
   writes `doom.json` (current snapshot) plus `history.json` (daily rollup,
   90 days).
2. The score is **doom prevalence**: the share of today's unique stories
   scoring ≥ 20. Verdicts: <15 "Mostly survivable.", <30 "Getting spicy.",
   <50 "Rough out there.", ≥50 "Everything is terrible."
3. `.github/workflows/doom.yml` runs the fetcher hourly and commits the
   JSON back. `index.html` + `doom.css` + `doom.js` render it — no build step.

## Deploy

1. Create a public repo (suggested name: `DoomGauge`) and push the contents
   of `doom-gauge-github/` to its root.
2. Repo Settings → Pages → Deploy from branch → `main` / `/ (root)`.
3. The workflow runs on the next hour; the page reads `doom.json` live.
   `doom.json`/`history.json` ship with seed data from the first local run.

No secrets needed — `GITHUB_TOKEN` handles the data commits.

## Tuning

- Add/remove feeds in `feeds.json` (`{"name": ..., "url": ...}`). Dead feeds
  are skipped with a stderr note; they don't break the run.
- Adjust keyword weights in `doom_lexicon.json`. `DOOM_CUTOFF` (default 20)
  and verdict bands live in `fetch_doom.py`.

## Honest limits

- Measures the sources, not your personal reading.
- Keyword scoring is crude — sports metaphors and sarcasm will fool it.
- AP / Reuters / CNN block automated fetches (403/401/dropped connections);
  the default feed list only includes outlets that serve RSS to scripts.
