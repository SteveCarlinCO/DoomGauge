#!/usr/bin/env python3
"""Doom Gauge fetcher — stdlib only.

Fetches RSS/Atom feeds, scores headlines against doom_lexicon.json,
dedupes cross-source stories, and writes doom.json (current snapshot)
plus history.json (daily rollup, 90 days).

Designed to run hourly from GitHub Actions; also runs locally:
    python3 fetch_doom.py
"""
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
DENVER = ZoneInfo("America/Denver")
UA = {"User-Agent": "DoomGauge/1.0 (+https://github.com/stevecarlinco/DoomGauge)"}
DEDUP_JACCARD = 0.45
DEDUP_SUBSET = 0.7
DOOM_CUTOFF = 20  # a headline scoring >= this counts as doom
HISTORY_DAYS = 90
STREAK_THRESHOLD = 35  # a day this doom or worse extends the streak

STOPWORDS = set(
    "the a an and or of to in on for with as at by from is are was were be been "
    "it its this that these those will would can could has have had not no vs via "
    "after amid among into over under more most".split()
)


def load(name, default):
    try:
        return json.loads((HERE / name).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save(name, obj):
    (HERE / name).write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n",
                             encoding="utf-8")


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=25) as r:
        return r.read()


def titles_from_xml(raw):
    """Return [(title, link)] from RSS (<item>) or Atom (<entry>)."""
    out = []
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return out
    for item in root.iter("item"):
        t = item.findtext("title")
        if t and t.strip():
            l = item.findtext("link") or ""
            out.append((t.strip(), l.strip()))
    if not out:
        # RSS 1.0 / RDF: items live in the http://purl.org/rss/1.0/ namespace
        ns1 = "{http://purl.org/rss/1.0/}"
        for item in root.iter(ns1 + "item"):
            t = item.findtext(ns1 + "title")
            if t and t.strip():
                l = item.findtext(ns1 + "link") or ""
                out.append((t.strip(), l.strip()))
    if not out:
        ns = {"a": "http://www.w3.org/2005/Atom"}
        for e in root.findall("a:entry", ns):
            t = e.findtext("a:title", "", ns)
            if t and t.strip():
                link = e.find("a:link", ns)
                href = link.get("href", "") if link is not None else ""
                out.append((t.strip(), href.strip()))
    return out


def compile_lexicon(lex):
    return [(re.compile(r"\b" + re.escape(k) + r"\b", re.IGNORECASE), w)
            for k, w in lex.get("weights", {}).items()]


def score_headline(text, patterns):
    return max(0, min(100, sum(w for rx, w in patterns if rx.search(text))))


def norm_words(text):
    return {w for w in re.findall(r"[a-z]{4,}", text.lower())
            if w not in STOPWORDS}


def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def dedupe(headlines):
    """Drop near-duplicate stories across sources; keep highest score."""
    kept = []
    for h in sorted(headlines, key=lambda x: -x["score"]):
        words = norm_words(h["title"])
        dup = False
        for k in kept:
            kw = norm_words(k["title"])
            j = jaccard(words, kw)
            sub = (len(words & kw) / min(len(words), len(kw))) if words and kw else 0
            if j >= DEDUP_JACCARD or sub >= DEDUP_SUBSET:
                dup = True
                break
        if not dup:
            kept.append(h)
    return kept


def verdict(score):
    # score = % of today's unique stories that are doom (prevalence)
    if score < 15:
        return "Mostly survivable."
    if score < 30:
        return "Getting spicy."
    if score < 50:
        return "Rough out there."
    return "Everything is terrible."


def main():
    feeds = load("feeds.json", [])
    lex = load("doom_lexicon.json", {"weights": {}})
    patterns = compile_lexicon(lex)

    per_source = []
    all_heads = []
    for f in feeds:
        name, url = f["name"], f["url"]
        try:
            items = titles_from_xml(fetch(url))
        except Exception as ex:  # noqa: BLE001 - one bad feed must not kill the run
            print(f"FEED FAIL {name}: {type(ex).__name__}: {ex}", file=sys.stderr)
            continue
        scored = [{"title": t, "link": l, "score": score_headline(t, patterns),
                   "source": name} for t, l in items]
        all_heads.extend(scored)
        prev = (round(100 * sum(1 for h in scored if h["score"] >= DOOM_CUTOFF)
                      / len(scored), 1) if scored else 0.0)
        per_source.append({"name": name, "score": prev, "count": len(scored),
                           "doom": sum(1 for h in scored
                                       if h["score"] >= DOOM_CUTOFF)})
        print(f"FEED OK {name}: {len(scored)} headlines, doom share {prev}%")

    if not per_source:
        print("No feeds succeeded; nothing written.", file=sys.stderr)
        sys.exit(1)

    unique = dedupe(all_heads)
    n = len(unique)
    overall = (round(100 * sum(1 for h in unique if h["score"] >= DOOM_CUTOFF) / n, 1)
               if n else 0.0)
    top = sorted(unique, key=lambda h: -h["score"])[:8]

    total_doom = sum(s["doom"] for s in per_source)
    champ = max(per_source, key=lambda s: s["doom"])
    contributor = ({"name": champ["name"],
                    "share": round(100 * champ["doom"] / total_doom, 1)}
                   if total_doom else None)

    now_denver = datetime.now(DENVER)
    today = now_denver.strftime("%Y-%m-%d")

    history = load("history.json", [])
    entry = {"date": today, "score": overall, "verdict": verdict(overall),
             "sources": {s["name"]: s["score"] for s in per_source},
             "top": [{"title": h["title"], "score": h["score"],
                      "source": h["source"]} for h in top[:5]]}
    history = [h for h in history if h["date"] != today] + [entry]
    history = history[-HISTORY_DAYS:]

    streak = 0
    for h in reversed(history):
        if h["score"] >= STREAK_THRESHOLD:
            streak += 1
        else:
            break

    doom = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "date": today,
        "score": overall,
        "verdict": verdict(overall),
        "sources": per_source,
        "headlines": [{"title": h["title"], "score": h["score"],
                       "source": h["source"], "link": h["link"]} for h in top],
        "top_contributor": contributor,
        "streak_days": streak,
        "feed_count": len(per_source),
        "headline_count": len(all_heads),
        "unique_stories": len(unique),
    }
    save("doom.json", doom)
    save("history.json", history)
    print(f"DONE score={overall} feeds={len(per_source)} "
          f"headlines={len(all_heads)} unique={len(unique)} streak={streak}")


if __name__ == "__main__":
    main()
