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
DOOM_CUTOFF = 15  # a headline scoring >= this counts as doom
HISTORY_DAYS = 90
STREAK_THRESHOLD = 35  # a day this doom or worse extends the streak
MIN_FEEDS_OK = 5    # abort the run if fewer feeds than this succeed
MIN_HEADLINES = 40  # abort the run if fewer headlines than this were fetched

STOPWORDS = set(
    "the a an and or of to in on for with as at by from is are was were be been "
    "it its this that these those will would can could has have had not no vs via "
    "after amid among into over under more most".split()
)

# Topic buckets for the "what kind of doom" breakdown. A doom headline
# counts toward every topic with at least one keyword hit.
TOPICS = {
    "War": ["war", "invasion", "airstrike", "missile", "troops", "ceasefire",
            "battlefield", "military", "bombing", "bomb", "shelling", "nuclear",
            "offensive", "siege", "combat", "casualties", "warship", "drone strike"],
    "Disaster": ["earthquake", "flood", "hurricane", "wildfire", "tsunami",
                 "tornado", "storm", "drought", "landslide", "volcano",
                 "avalanche", "disaster", "evacuate", "evacuation", "rescue"],
    "Economy": ["recession", "inflation", "crash", "layoffs", "unemployment",
                "stocks", "debt", "default", "bankrupt", "tariff", "sanctions",
                "selloff", "market"],
    "Crime": ["murder", "shooting", "stabbing", "kidnapping", "arrested",
              "prison", "sentenced", "gunman", "robbery", "assault",
              "trafficking", "cartel", "gang", "homicide"],
    "Politics": ["election", "coup", "protest", "impeach", "scandal",
                 "corruption", "resign", "parliament", "crackdown",
                 "martial law", "authoritarian"],
    "Health": ["outbreak", "pandemic", "epidemic", "virus", "disease",
               "vaccine", "hospital", "ebola", "cholera", "dengue",
               "infection", "quarantine"],
}


def compile_topics():
    out = {}
    for topic, keys in TOPICS.items():
        pats = []
        for k in keys:
            base = r"\b" + re.escape(k)
            tail = r"\b" if k.endswith("s") else r"(?:s|es)?\b"
            pats.append(re.compile(base + tail, re.IGNORECASE))
        out[topic] = pats
    return out


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


def clean_gnews_title(t, url):
    """Google News RSS appends ' - Outlet' to every title; strip it."""
    if "news.google.com" in url and " - " in t:
        return t.rsplit(" - ", 1)[0].strip()
    return t


def compile_lexicon(lex):
    """Word-boundary matching, case-insensitive, with optional plural s/es."""
    pats = []
    for k, w in lex.get("weights", {}).items():
        base = r"\b" + re.escape(k)
        tail = r"\b" if k.endswith("s") else r"(?:s|es)?\b"
        pats.append((k, re.compile(base + tail, re.IGNORECASE), w))
    return pats


def score_headline(text, patterns):
    return max(0, min(100, sum(w for _, rx, w in patterns if rx.search(text))))


def score_breakdown(text, patterns):
    """Which lexicon keywords fired, with weights, heaviest first."""
    hits = [(k, w) for k, rx, w in patterns if rx.search(text)]
    hits.sort(key=lambda kw: -kw[1])
    return [{"keyword": k, "weight": w} for k, w in hits]


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


# ---------------------------------------------------------------------------
# OG share image: pure-stdlib PNG writer + 3x5 pixel font. No dependencies.
# ---------------------------------------------------------------------------
FONT_3X5 = {
 "0": ("###","#.#","#.#","#.#","###"),
 "1": (".#.","##.",".#.",".#.","###"),
 "2": ("###","..#","###","#..","###"),
 "3": ("###","..#",".##","..#","###"),
 "4": ("#.#","#.#","###","..#","..#"),
 "5": ("###","#..","###","..#","###"),
 "6": ("###","#..","###","#.#","###"),
 "7": ("###","..#","..#",".#.",".#."),
 "8": ("###","#.#","###","#.#","###"),
 "9": ("###","#.#","###","..#","###"),
 "A": (".#.","#.#","###","#.#","#.#"),
 "B": ("##.","#.#","##.","#.#","##."),
 "C": (".##","#..","#..","#..",".##"),
 "D": ("##.","#.#","#.#","#.#","##."),
 "E": ("###","#..","##.","#..","###"),
 "F": ("###","#..","##.","#..","#.."),
 "G": (".##","#..","#.#","#.#",".##"),
 "H": ("#.#","#.#","###","#.#","#.#"),
 "I": ("###",".#.",".#.",".#.","###"),
 "J": ("..#","..#","..#","#.#",".#."),
 "K": ("#.#","#.#","##.","#.#","#.#"),
 "L": ("#..","#..","#..","#..","###"),
 "M": ("#.#","###","###","#.#","#.#"),
 "N": ("#.#","###","#.#","#.#","#.#"),
 "O": (".#.","#.#","#.#","#.#",".#."),
 "P": ("##.","#.#","##.","#..","#.."),
 "Q": (".#.","#.#","#.#","##.",".##"),
 "R": ("##.","#.#","##.","#.#","#.#"),
 "S": (".##","#..",".#.","..#",".##"),
 "T": ("###",".#.",".#.",".#.",".#."),
 "U": ("#.#","#.#","#.#","#.#","###"),
 "V": ("#.#","#.#","#.#","#.#",".#."),
 "W": ("#.#","#.#","###","###","#.#"),
 "X": ("#.#","#.#",".#.","#.#","#.#"),
 "Y": ("#.#","#.#",".#.",".#.",".#."),
 "Z": ("###","..#",".#.","#..","###"),
 " ": ("...","...","...","...","..."),
 ".": ("...","...","...","...",".#."),
 "%": ("#.#","..#",".#.","#..","#.#"),
 ",": ("...","...","...",".#.","#.."),
 "!": (".#.",".#.",".#.","...",".#."),
 "-": ("...","...","###","...","..."),
 "+": ("...",".#.","###",".#.","..."),
 ":": ("...",".#.","...",".#.","..."),
}

VERDICT_HEX = {
    "Mostly survivable.": "#7ee2a8",
    "Getting spicy.": "#ffd166",
    "Rough out there.": "#ff9f5a",
    "Everything is terrible.": "#ff5a52",
}


def _hexrgb(s):
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


def _write_png(path, w, h, px):
    import struct
    import zlib

    def chunk(tag, data):
        c = tag + data
        return (struct.pack(">I", len(data)) + c +
                struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF))

    rows = b"".join(b"\x00" + b"".join(bytes(p) for p in row) for row in px)
    blob = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows))
            + chunk(b"IEND", b""))
    Path(path).write_bytes(blob)


def _draw_text(px, x, y, text, scale, color):
    h, w = len(px), len(px[0])
    for ch in text.upper():
        glyph = FONT_3X5.get(ch, FONT_3X5[" "])
        for r, row in enumerate(glyph):
            for c, on in enumerate(row):
                if on == "#":
                    for dy in range(scale):
                        for dx in range(scale):
                            yy, xx = y + r * scale + dy, x + c * scale + dx
                            if 0 <= yy < h and 0 <= xx < w:
                                px[yy][xx] = color
        x += 4 * scale
    return x


def make_og_image(score, verdict_text, date_str, n_sources, path):
    """Render a 1200x630 share card with today's score. Stdlib only."""
    W, H = 1200, 630
    bg, muted, light = (11, 14, 26), (139, 147, 167), (232, 234, 240)
    px = [[bg] * W for _ in range(H)]
    for y in range(14):  # red accent bar
        for x in range(W):
            px[y][x] = (229, 57, 53)
    vcolor = _hexrgb(VERDICT_HEX.get(verdict_text, "#e8eaf0"))

    def centered(y, text, scale, color):
        _draw_text(px, (W - len(text) * 4 * scale) // 2, y, text, scale, color)

    _draw_text(px, 60, 70, "DOOM GAUGE", 6, muted)
    _draw_text(px, 60, 130, date_str, 5, muted)
    centered(220, f"{score}%", 34, vcolor)
    centered(445, verdict_text, 9, light)
    centered(560, f"{n_sources} SOURCES - UPDATED HOURLY", 5, muted)
    _write_png(path, W, H, px)


def headline_topics(title, topic_pats):
    """Names of every topic bucket with at least one keyword hit in title."""
    return [t for t, pats in topic_pats.items()
            if any(p.search(title) for p in pats)]


def mark_stale(feeds_ok, total_heads, n_feeds):
    """Too few feeds/headlines for an honest score. Keep the last good
    doom.json, flag it stale, and exit 0 so the workflow commits the
    flag instead of failing silently."""
    doom = load("doom.json", None)
    if doom is None:
        print(f"ABORT: only {feeds_ok}/{n_feeds} feeds ok, "
              f"{total_heads} headlines — and no previous doom.json to keep.",
              file=sys.stderr)
        sys.exit(1)
    reason = (f"only {feeds_ok}/{n_feeds} feeds ok, {total_heads} headlines "
              f"(minimums: {MIN_FEEDS_OK} feeds, {MIN_HEADLINES} headlines)")
    doom["stale"] = True
    doom["stale_reason"] = reason
    doom["last_attempt"] = datetime.now(timezone.utc).isoformat()
    doom["generated_at"] = doom["last_attempt"]
    save("doom.json", doom)
    print(f"STALE: {reason} — kept last good score {doom.get('score')}.")
    sys.exit(0)


def main():
    feeds = load("feeds.json", [])
    lex = load("doom_lexicon.json", {"weights": {}})
    patterns = compile_lexicon(lex)

    per_source = []
    all_heads = []
    health = []
    for f in feeds:
        name, url = f["name"], f["url"]
        try:
            items = titles_from_xml(fetch(url))
            if "news.google.com" in url:
                items = [(clean_gnews_title(t, url), l) for t, l in items]
        except Exception as ex:  # noqa: BLE001 - one bad feed must not kill the run
            print(f"FEED FAIL {name}: {type(ex).__name__}: {ex}", file=sys.stderr)
            health.append({"name": name, "url": url, "ok": False, "headlines": 0,
                           "error": type(ex).__name__, "sample": []})
            continue
        scored = [{"title": t, "link": l, "score": score_headline(t, patterns),
                   "source": name} for t, l in items]
        health.append({"name": name, "url": url, "ok": True, "headlines": len(items),
                       "error": None,
                       "sample": [{"title": h["title"], "score": h["score"],
                                   "link": h["link"]}
                                  for h in sorted(scored, key=lambda h: -h["score"])[:8]]})
        all_heads.extend(scored)
        prev = (round(100 * sum(1 for h in scored if h["score"] >= DOOM_CUTOFF)
                      / len(scored), 1) if scored else 0.0)
        per_source.append({"name": name, "score": prev, "count": len(scored),
                           "doom": sum(1 for h in scored
                                       if h["score"] >= DOOM_CUTOFF)})
        print(f"FEED OK {name}: {len(scored)} headlines, doom share {prev}%")

    feeds_ok, total_heads = len(per_source), len(all_heads)
    if feeds_ok < MIN_FEEDS_OK or total_heads < MIN_HEADLINES:
        mark_stale(feeds_ok, total_heads, len(feeds))

    # Sources that returned nothing, or whose headlines matched zero keywords,
    # carry no signal — exclude them from the score.
    signaling = {h["source"] for h in all_heads if h["score"] > 0}
    calc_heads = [h for h in all_heads if h["source"] in signaling]
    n_dropped_src = len({h["source"] for h in all_heads}) - len(signaling)
    if n_dropped_src:
        print(f"EXCLUDED {len(all_heads) - len(calc_heads)} headlines from "
              f"{n_dropped_src} non-signaling sources: "
              f"{sorted({h['source'] for h in all_heads} - signaling)}")

    unique = dedupe(calc_heads)
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

    doom_heads = [h for h in unique if h["score"] >= DOOM_CUTOFF]
    topic_pats = compile_topics()
    topics = []
    for topic, pats in topic_pats.items():
        n = sum(1 for h in doom_heads
                if any(p.search(h["title"]) for p in pats))
        if n:
            topics.append({"name": topic, "count": n,
                           "share": round(100 * n / len(doom_heads), 1)})
    topics.sort(key=lambda t: -t["count"])

    history = load("history.json", [])
    prev_day = next((h for h in reversed(history) if h["date"] < today), None)
    delta = round(overall - prev_day["score"], 1) if prev_day else None
    delta_date = prev_day["date"] if prev_day else None
    entry = {"date": today, "score": overall, "verdict": verdict(overall),
             "sources": {s["name"]: s["score"] for s in per_source
                         if s["name"] in signaling},
             "topics": {t["name"]: t["share"] for t in topics},
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
        "fetched_at": now_denver.strftime("%Y-%m-%d %H:%M %Z"),
        "date": today,
        "score": overall,
        "stale": False,
        "verdict": verdict(overall),
        "delta": delta,
        "delta_date": delta_date,
        "sources": per_source,
        "topics": topics,
        "headlines": [{"title": h["title"], "score": h["score"],
                       "source": h["source"], "link": h["link"],
                       "topics": headline_topics(h["title"], topic_pats),
                       "hits": score_breakdown(h["title"], patterns)}
                      for h in top],
        "top_contributor": contributor,
        "streak_days": streak,
        "feed_health": health,
        "feed_count": len(per_source),
        "headline_count": len(all_heads),
        "unique_stories": len(unique),
    }
    save("doom.json", doom)
    save("history.json", history)
    make_og_image(overall, doom["verdict"], today, len(feeds),
                  HERE / "og-image.png")
    print(f"DONE score={overall} feeds={len(per_source)} "
          f"headlines={len(all_heads)} unique={len(unique)} streak={streak}")


if __name__ == "__main__":
    main()
