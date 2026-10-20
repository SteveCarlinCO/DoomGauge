/* Doom Gauge — renders doom.json + history.json. No build step. */
(function () {
  "use strict";

  var ARC = 251.33; // half-circumference of the r=80 gauge arc

  function bandColor(score) {
    if (score < 15) return "#34d17b";
    if (score < 30) return "#f5a623";
    if (score < 50) return "#ff7a45";
    return "#ff453a";
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtDate(isoDate) {
    // "2026-10-19" -> "SUNDAY, OCTOBER 19" in America/Denver
    try {
      var d = new Date(isoDate + "T12:00:00");
      var parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Denver", weekday: "long",
        month: "long", day: "numeric"
      }).formatToParts(d);
      var get = function (t) {
        var p = parts.find(function (x) { return x.type === t; });
        return p ? p.value : "";
      };
      return (get("weekday") + ", " + get("month") + " " + get("day")).toUpperCase();
    } catch (e) { return isoDate; }
  }

  var openLexicon = null;

  function renderUpdated(iso) {
    var el = document.getElementById("updated");
    var datePart, tzPart;
    try {
      var dt = new Date(iso);
      datePart = dt.toLocaleString("en-US", {
        timeZone: "America/Denver", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit"
      });
      tzPart = dt.toLocaleString("en-US", {
        timeZone: "America/Denver", timeZoneName: "short"
      }).split(" ").pop();
    } catch (e) {
      el.textContent = "Updated " + iso + " · fetches hourly";
      return;
    }
    el.innerHTML = "Updated " + esc(datePart) +
      ' <button id="tzBtn" class="tz-btn" title="Review the doom lexicon">' +
      esc(tzPart) + "</button> · fetches hourly";
    document.getElementById("tzBtn").addEventListener("click", function () {
      if (openLexicon) openLexicon();
    });
  }

  function renderGauge(score) {
    var color = bandColor(score);
    var fill = document.getElementById("gaugeFill");
    fill.setAttribute("stroke", color);
    fill.setAttribute("stroke-dasharray", (ARC * score / 100).toFixed(1) + " " + ARC);
    var num = document.getElementById("gaugeNum");
    num.textContent = Math.round(score) + "%";
    num.setAttribute("fill", color);
    return color;
  }

  function sparkline(scores) {
    // 7-day trail, oldest first. Pure SVG, no dependencies.
    if (!scores || scores.length < 2) {
      return '<span class="spark none" title="Not enough history yet">—</span>';
    }
    var w = 64, h = 18, pts = [];
    for (var i = 0; i < scores.length; i++) {
      var x = (i / (scores.length - 1) * w).toFixed(1);
      var y = (h - 2 - (Math.min(100, scores[i]) / 100) * (h - 4)).toFixed(1);
      pts.push(x + "," + y);
    }
    var c = bandColor(scores[scores.length - 1]);
    return '<svg class="spark" viewBox="0 0 ' + w + " " + h + '" aria-hidden="true">' +
      '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + c +
      '" stroke-width="1.5"/></svg>';
  }

  var LOGOS = {
    "NPR": "npr.org", "BBC": "bbc.com", "Al Jazeera": "aljazeera.com",
    "CBS": "cbsnews.com", "PBS": "pbs.org", "ABC": "abcnews.go.com",
    "NBC": "nbcnews.com", "Sky": "news.sky.com", "DW": "dw.com",
    "France24": "france24.com", "Guardian": "theguardian.com",
    "The Hill": "thehill.com", "ZeroHedge": "zerohedge.com",
    "ReliefWeb": "reliefweb.int", "TOI": "timesofindia.indiatimes.com",
    "ABC-AU": "abc.net.au", "Slate": "slate.com",
    "Times of Israel": "timesofisrael.com", "Vox": "vox.com",
    "Euronews": "euronews.com", "CNBC": "cnbc.com", "Politico": "politico.com",
    "ProPublica": "propublica.org", "Dawn": "dawn.com",
    "Japan Times": "japantimes.co.jp", "The Diplomat": "thediplomat.com",
    "Reason": "reason.com", "The Hindu": "thehindu.com",
    "Jerusalem Post": "jpost.com", "FOX News": "foxnews.com",
    "CNN": "cnn.com", "MSNBC": "msnbc.com", "CBC": "cbc.ca"
  };
  function logoFor(name) {
    var d = LOGOS[name];
    if (!d) return '<span class="src-name">' + esc(name) + "</span>";
    return '<img class="src-logo" alt="' + esc(name) + '" title="' + esc(name) + '"' +
      ' src="https://www.google.com/s2/favicons?domain=' + d + '&sz=64"' +
      " onerror=\"this.style.display='none';this.nextElementSibling.style.display='inline'\">" +
      '<span class="src-name" style="display:none">' + esc(name) + "</span>";
  }

  function renderSources(sources, history) {
    var el = document.getElementById("sources");
    var rows = sources.filter(function (s) { return s.score > 0; })
      .slice().sort(function (a, b) { return b.score - a.score; });
    el.innerHTML = rows.map(function (s) {
      var c = bandColor(s.score);
      var trail = [];
      (history || []).slice(-7).forEach(function (day) {
        if (day.sources && typeof day.sources[s.name] === "number") {
          trail.push(day.sources[s.name]);
        }
      });
      return '<div class="src-row">' + logoFor(s.name) +
        '<div class="src-bar"><div class="src-fill" style="width:' +
        Math.min(100, s.score).toFixed(1) + "%;background:" + c + ';"></div></div>' +
        sparkline(trail) +
        '<span class="src-val">' + s.score.toFixed(0) + "</span></div>";
    }).join("");
  }

  var topicFilter = null;
  var lastHeadlines = [];
  var lastTopics = [];

  function renderHeadlines(headlines) {
    lastHeadlines = headlines;
    var el = document.getElementById("headlines");
    var list = topicFilter
      ? headlines.filter(function (h) {
          return h.topics && h.topics.indexOf(topicFilter) !== -1;
        })
      : headlines;
    var note = topicFilter
      ? '<div class="filter-note">Showing ' + esc(topicFilter) +
        " only — click the topic again to clear.</div>"
      : "";
    if (!list.length) {
      el.innerHTML = note + '<div class="empty">' +
        (topicFilter ? "No headlines tagged " + esc(topicFilter) + "."
                     : "No headlines scored yet.") + "</div>";
      return;
    }
    el.innerHTML = note + list.map(function (h) {
      var c = bandColor(h.score);
      var title = esc(h.title);
      var body = h.link
        ? '<a href="' + esc(h.link) + '" target="_blank" rel="noopener">' + title + "</a>"
        : title;
      var hits = (h.hits && h.hits.length)
        ? h.hits.map(function (hit) {
            return '<span class="hit">' + esc(hit.keyword) +
              " <b>+" + hit.weight + "</b></span>";
          }).join("")
        : '<span class="hit none">no keyword breakdown recorded</span>';
      return '<div class="hl-wrap"><div class="hl" role="button" tabindex="0" ' +
        'title="Click to inspect score"><div>' + body +
        ' <span class="src">' + esc(h.source) + "</span></div>" +
        '<span class="hl-score" style="color:' + c + '">' + h.score + "</span></div>" +
        '<div class="hl-hits" hidden>' + hits + "</div></div>";
    }).join("");
    Array.prototype.forEach.call(el.querySelectorAll(".hl"), function (row) {
      function toggle(e) {
        if (e && e.target && e.target.closest && e.target.closest("a")) return;
        var det = row.parentNode.querySelector(".hl-hits");
        det.hidden = !det.hidden;
        row.classList.toggle("open", !det.hidden);
      }
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(e); }
      });
    });
  }

  var historyRange = 7;
  var lastHistory = [];

  function renderWeek(history) {
    lastHistory = history;
    var el = document.getElementById("week");
    var days = history.slice(-historyRange);
    if (!days.length) {
      el.innerHTML = '<div class="empty">History builds up day by day.</div>';
      return;
    }
    var today = days[days.length - 1].date;
    var showLabels = historyRange <= 7;
    el.innerHTML = days.map(function (h) {
      var c = bandColor(h.score);
      var d = new Date(h.date + "T12:00:00");
      var lbl = showLabels
        ? '<div class="lbl">' + "SMTWTFS"[d.getDay()] + "</div>"
        : "";
      var cls = h.date === today ? "day today" : "day";
      return '<div class="' + cls + '" title="' + h.date + ": " + h.score + '%">' +
        '<div class="bar" style="height:' +
        Math.max(4, h.score) + "px;background:" + c + ';"></div>' + lbl + "</div>";
    }).join("");
    document.getElementById("historyTitle").textContent =
      historyRange <= 7 ? "THE WEEK" : "THE MONTH";
  }

  function initRangeToggle() {
    var w = document.getElementById("rangeWeek");
    var m = document.getElementById("rangeMonth");
    function set(n) {
      historyRange = n;
      w.classList.toggle("on", n === 7);
      m.classList.toggle("on", n === 30);
      renderWeek(lastHistory);
      renderBleakWeek(lastHistory);
      renderTopicTrends(lastHistory);
    }
    w.addEventListener("click", function () { set(7); });
    m.addEventListener("click", function () { set(30); });
  }
  initRangeToggle();

  function renderBleakWeek(history) {
    var el = document.getElementById("bleakWeek");
    var days = history.slice(-7);
    if (!days.length) {
      el.innerHTML = '<div class="empty">History builds up day by day.</div>';
      return;
    }
    var sums = {}, counts = {};
    days.forEach(function (h) {
      var srcs = h.sources || {};
      Object.keys(srcs).forEach(function (name) {
        sums[name] = (sums[name] || 0) + srcs[name];
        counts[name] = (counts[name] || 0) + 1;
      });
    });
    var rows = Object.keys(sums).map(function (name) {
      return { name: name, avg: sums[name] / counts[name] };
    }).filter(function (r) { return r.avg > 0; })
      .sort(function (a, b) { return b.avg - a.avg; });
    var max = rows.length ? rows[0].avg : 0;
    el.innerHTML = rows.map(function (r, i) {
      var pct = max ? (100 * r.avg / max) : 0;
      return '<div class="src-row"><span class="src-rank">' + (i + 1) +
        "</span>" + logoFor(r.name) +
        '<div class="src-bar"><div class="src-fill" style="width:' +
        pct.toFixed(1) + "%;background:" + bandColor(r.avg) +
        '"></div></div><span class="src-val">' + r.avg.toFixed(1) + "%</span></div>";
    }).join("") + '<div class="note">Average daily share of bleakness, last ' +
      days.length + " day" + (days.length === 1 ? "" : "s") + ".</div>";
  }

  function renderTopicTrends(history) {
    var el = document.getElementById("topicTrends");
    var days = history.slice(-historyRange).filter(function (h) { return h.topics; });
    if (!days.length) {
      el.innerHTML = '<div class="note">Topic history starts with the next fetch.</div>';
      return;
    }
    var names = {};
    days.forEach(function (h) {
      Object.keys(h.topics).forEach(function (n) { names[n] = true; });
    });
    var rows = Object.keys(names).map(function (n) {
      var pts = days.map(function (h) { return h.topics[n] || 0; });
      var avg = pts.reduce(function (a, b) { return a + b; }, 0) / pts.length;
      return { name: n, pts: pts, avg: avg };
    }).sort(function (a, b) { return b.avg - a.avg; });
    el.innerHTML = rows.map(function (r) {
      return '<div class="src-row"><span class="src-name">' + esc(r.name) +
        "</span>" + sparkline(r.pts) +
        '<span class="src-val">' + r.avg.toFixed(1) + "%</span></div>";
    }).join("");
  }

  var HAPPY = ["😀","😜","🏖️","🥲","😁","🤸‍♂️","😂","🙂","😤","🥳","🤸","🤸‍♀️","🤣","😃","😄","☺️","🌞","😎"];
  var SCARY = ["💀","☠️","👹","👺","🧟","🪦","⚰️","😱","😨","😧","🔪","🗡️","😈","😠","👿","😤","😡","💢","👹","🤬","💩"];

  function moodFor(score) {
    if (score < 15) return HAPPY[Math.floor(Math.random() * HAPPY.length)];
    if (score > 70) return SCARY[Math.floor(Math.random() * SCARY.length)];
    return "";
  }

  function doomForecast(history) {
    var days = history.slice(-7);
    if (days.length < 2) return null;
    var n = days.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    days.forEach(function (h, i) {
      sx += i; sy += h.score; sxx += i * i; sxy += i * h.score;
    });
    var denom = n * sxx - sx * sx;
    var slope = denom ? (n * sxy - sx * sy) / denom : 0;
    var intercept = (sy - slope * sx) / n;
    var pred = intercept + slope * n;
    return Math.max(0, Math.min(100, Math.round(pred * 10) / 10));
  }

  function forecastQuip(pred) {
    if (pred < 15) return "Mostly survivable. Pack sunscreen and low expectations.";
    if (pred < 30) return "Getting spicy. Maybe skip the comments section.";
    if (pred < 50) return "Rough out there. Hug your chickens.";
    return "Everything is terrible. Cancel your plans.";
  }

  function renderForecast(history) {
    var el = document.getElementById("forecast");
    var pred = doomForecast(history);
    if (pred === null) {
      el.innerHTML = '<div class="note">Not enough history to guess. Check back tomorrow.</div>';
      return;
    }
    el.innerHTML = '<span class="forecast-num">' + pred.toFixed(1) + '%</span>' +
      '<span class="forecast-quip">' + esc(forecastQuip(pred)) + "</span>" +
      '<div class="note">Extrapolated from the last 7 days. ' +
      "About as reliable as a horoscope.</div>";
  }

  function renderTopics(topics) {
    lastTopics = topics;
    var el = document.getElementById("topics");
    if (!topics.length) {
      el.innerHTML = '<div class="empty">No doom to categorize. Suspiciously peaceful.</div>';
      return;
    }
    el.innerHTML = topics.map(function (t) {
      var c = bandColor(t.share);
      var active = topicFilter === t.name ? " active" : "";
      return '<div class="src-row topic-row' + active + '" data-topic="' +
        esc(t.name) + '" role="button" tabindex="0" title="Click to filter headlines">' +
        '<span class="src-name">' + esc(t.name) + "</span>" +
        '<div class="src-bar"><div class="src-fill" style="width:' +
        Math.min(100, t.share).toFixed(1) + "%;background:" + c + ';"></div></div>' +
        '<span class="src-val">' + t.share.toFixed(0) + "</span></div>";
    }).join("");
    Array.prototype.forEach.call(el.querySelectorAll(".topic-row"), function (row) {
      function toggle() {
        var t = row.getAttribute("data-topic");
        topicFilter = (topicFilter === t) ? null : t;
        renderTopics(lastTopics);
        renderHeadlines(lastHeadlines);
      }
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });
  }

  var feedHealthData = [];
  function renderHealth(health, fetchedAt) {
    feedHealthData = health;
    var el = document.getElementById("health");
    el.innerHTML = health.map(function (h, i) {
      var sub = h.ok ? h.headlines + " headlines" : esc(h.error || "failed");
      return '<button class="pill' + (h.ok ? "" : " bad") + '" data-i="' + i + '">' +
        '<span class="dot"></span>' + logoFor(h.name) +
        '<span class="pill-sub">' + sub + "</span></button>";
    }).join("");
    document.getElementById("healthNote").textContent =
      "Last checked " + (fetchedAt || "—") + ".";
    el.querySelectorAll("button.pill").forEach(function (b) {
      b.addEventListener("click", function () {
        showFeed(feedHealthData[+b.getAttribute("data-i")]);
      });
    });
  }

  function showFeed(h) {
    if (!h) return;
    var modal = document.getElementById("feedModal");
    document.getElementById("feedTitle").textContent = h.name.toUpperCase();
    var html = '<div class="feed-meta">' +
      (h.ok ? h.headlines + " headlines fetched" : "Failed: " + esc(h.error || "unknown")) +
      "</div>";
    if (h.url) {
      html += '<div class="feed-url"><a href="' + esc(h.url) +
        '" target="_blank" rel="noopener">' + esc(h.url) + "</a></div>";
    }
    html += (h.sample && h.sample.length) ? h.sample.map(function (s) {
      var row = '<div class="feed-story"><span class="feed-score">' + s.score + "</span>";
      row += s.link
        ? '<a href="' + esc(s.link) + '" target="_blank" rel="noopener">' + esc(s.title) + "</a>"
        : "<span>" + esc(s.title) + "</span>";
      return row + "</div>";
    }).join("") : '<div class="empty">No headlines sampled.</div>';
    document.getElementById("feedBody").innerHTML = html;
    modal.hidden = false;
  }

  function initFeedModal() {
    var modal = document.getElementById("feedModal");
    var close = document.getElementById("feedClose");
    function shut() { modal.hidden = true; }
    close.addEventListener("click", shut);
    modal.addEventListener("click", function (e) { if (e.target === modal) shut(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") shut(); });
  }
  initFeedModal();

  function getJSON(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(path + " " + r.status);
      return r.json();
    });
  }

  function initFeedsModal() {
    var btn = document.getElementById("feedsBtn");
    var modal = document.getElementById("feedsModal");
    var close = document.getElementById("feedsClose");
    var list = document.getElementById("feedsList");
    var loaded = false;
    function open() {
      modal.hidden = false;
      if (loaded) return;
      loaded = true;
      list.innerHTML = '<div class="empty">Loading…</div>';
      getJSON("feeds.json").then(function (feeds) {
        document.getElementById("feedCount").textContent = feeds.length;
        list.innerHTML = feeds.map(function (f) {
          return '<div class="feed-row"><div class="feed-name">' + esc(f.name) +
            '</div><div class="feed-url"><a href="' + esc(f.url) +
            '" target="_blank" rel="noopener">' + esc(f.url) + "</a></div></div>";
        }).join("");
      }).catch(function () {
        list.innerHTML = '<div class="empty">Could not load feeds.json.</div>';
      });
    }
    function shut() { modal.hidden = true; }
    btn.addEventListener("click", open);
    close.addEventListener("click", shut);
    modal.addEventListener("click", function (e) {
      if (e.target === modal) shut();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") shut();
    });
  }
  initFeedsModal();

  function initLexiconModal() {
    var modal = document.getElementById("lexModal");
    var close = document.getElementById("lexClose");
    var list = document.getElementById("lexList");
    var loaded = false;
    function shut() { modal.hidden = true; }
    function open() {
      modal.hidden = false;
      if (loaded) return;
      loaded = true;
      list.innerHTML = '<div class="empty">Loading…</div>';
      getJSON("doom_lexicon.json").then(function (lex) {
        var weights = lex.weights || {};
        var keys = Object.keys(weights).sort(function (a, b) {
          return weights[b] - weights[a];
        });
        document.getElementById("lexCount").textContent = keys.length;
        list.innerHTML = '<div class="lex-grid">' + keys.map(function (k) {
          var w = weights[k];
          var cls = w < 0 ? "hit good" : "hit";
          var sign = w > 0 ? "+" : "";
          return '<span class="' + cls + '">' + esc(k) +
            " <b>" + sign + w + "</b></span>";
        }).join("") + "</div>" +
          '<div class="note">Negative weights are anti-doom dampeners. ' +
          "Weights sum per headline, clamped 0–100. Deliberately crude.</div>";
      }).catch(function () {
        list.innerHTML = '<div class="empty">Could not load doom_lexicon.json.</div>';
      });
    }
    openLexicon = open;
    close.addEventListener("click", shut);
    modal.addEventListener("click", function (e) {
      if (e.target === modal) shut();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") shut();
    });
  }
  initLexiconModal();

  /* ---- v1.19.0: nine enhancements ---- */
  var allHeads = [];
  var doomScore = 0, doomVerdict = "";

  function renderPct(score, history) {
    var el = document.getElementById("pct");
    var scores = history.map(function (h) { return h.score; });
    if (scores.length < 3) { el.hidden = true; return; }
    el.hidden = false;
    var below = scores.filter(function (s) { return s < score; }).length;
    var pct = Math.round(100 * below / scores.length);
    el.textContent = "Bleaker than " + pct + "% of " + scores.length + " recorded days.";
  }

  function renderWhy(tally) {
    var el = document.getElementById("why");
    if (!tally || tally.length < 3) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = "Driven by " +
      tally.slice(0, 3).map(function (k) { return "\u2018" + k.keyword + "\u2019"; }).join(", ") + ".";
  }

  function renderCloud(tally) {
    var el = document.getElementById("wordCloud");
    if (!tally || !tally.length) {
      el.innerHTML = '<div class="empty">No keywords today.</div>';
      return;
    }
    var max = tally[0].weight || 1;
    el.innerHTML = tally.map(function (k, i) {
      var f = k.weight / max;
      var size = 14 + Math.round(26 * f);
      var op = (0.45 + 0.5 * f).toFixed(2);
      var hue = Math.round(200 + 80 * (i / tally.length));
      var delay = (-(i * 0.6)).toFixed(2);
      return '<span class="cloud-word" style="font-size:' + size + "px;opacity:" + op +
        ";color:hsl(" + hue + ",70%,80%);" +
        "text-shadow:0 0 14px hsla(" + hue + ",80%,70%,0.55);" +
        "animation-delay:" + delay + 's" title="' +
        k.weight + ' doom-weight">' + esc(k.keyword) + "</span>";
    }).join(" ");
    floatCloud();
  }

  function floatCloud() {
    var el = document.getElementById("wordCloud");
    if (!el) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var words = el.querySelectorAll(".cloud-word");
    if (!words.length) return;
    var H = 230;
    el.style.position = "relative";
    el.style.height = H + "px";
    el.style.overflow = "hidden";
    el.style.textAlign = "left";
    el.style.lineHeight = "1.4";
    var W = el.clientWidth || 600;
    var cols = 5, rows = 4, items = [];
    Array.prototype.forEach.call(words, function (w, i) {
      w.style.position = "absolute";
      w.style.margin = "0";
      w.style.left = "0";
      w.style.top = "0";
      var ww = w.offsetWidth || 80, wh = w.offsetHeight || 28;
      var col = i % cols, row = Math.floor(i / cols) % rows;
      var x = ((col + 0.5) / cols) * W + (Math.random() - 0.5) * 50 - ww / 2;
      var y = ((row + 0.5) / rows) * H + (Math.random() - 0.5) * 24 - wh / 2;
      x = Math.max(0, Math.min(W - ww, x));
      y = Math.max(0, Math.min(H - wh, y));
      var ang = Math.random() * Math.PI * 2, sp = 5 + Math.random() * 11;
      items.push({ el: w, x: x, y: y,
        vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp * 0.7 });
    });
    var last = null;
    function tick(now) {
      if (last === null) last = now;
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      var W2 = el.clientWidth || W;
      items.forEach(function (it) {
        it.x += it.vx * dt;
        it.y += it.vy * dt;
        var ww = it.el.offsetWidth || 80, wh = it.el.offsetHeight || 28;
        if (it.x <= 0) { it.x = 0; it.vx = Math.abs(it.vx); }
        else if (it.x + ww >= W2) { it.x = W2 - ww; it.vx = -Math.abs(it.vx); }
        if (it.y <= 0) { it.y = 0; it.vy = Math.abs(it.vy); }
        else if (it.y + wh >= H) { it.y = H - wh; it.vy = -Math.abs(it.vy); }
        it.el.style.transform = "translate(" + it.x.toFixed(1) + "px," + it.y.toFixed(1) + "px)";
      });
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function renderBias(history) {
    var el = document.getElementById("bias");
    var days = history.slice(-7);
    var sums = {}, counts = {}, total = 0, n = 0;
    days.forEach(function (h) {
      Object.keys(h.sources || {}).forEach(function (name) {
        sums[name] = (sums[name] || 0) + h.sources[name];
        counts[name] = (counts[name] || 0) + 1;
        total += h.sources[name]; n++;
      });
    });
    if (!n) { el.innerHTML = '<div class="empty">History builds up day by day.</div>'; return; }
    var overall = total / n;
    var rows = Object.keys(sums).map(function (name) {
      return { name: name, bias: sums[name] / counts[name] - overall };
    }).sort(function (a, b) { return b.bias - a.bias; });
    var maxAbs = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.bias); }).concat([1]));
    el.innerHTML = rows.map(function (r) {
      var w = Math.max(2, Math.round(50 * Math.abs(r.bias) / maxAbs));
      var fill = r.bias >= 0
        ? '<div class="bias-fill hot" style="left:50%;width:' + w + '%"></div>'
        : '<div class="bias-fill cool" style="right:50%;width:' + w + '%"></div>';
      var v = (r.bias >= 0 ? "+" : "") + r.bias.toFixed(1);
      return '<div class="bias-row">' + logoFor(r.name) +
        '<div class="bias-track">' + fill + '</div>' +
        '<span class="bias-val">' + v + "</span></div>";
    }).join("");
  }

  function initSearch() {
    var input = document.getElementById("search");
    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      var box = document.getElementById("headlines");
      if (!q) { renderHeadlines(lastHeadlines); return; }
      var hits = allHeads.filter(function (h) {
        return h[0].toLowerCase().indexOf(q) !== -1;
      }).slice(0, 60);
      box.innerHTML = hits.length ? hits.map(function (h) {
        return '<div class="hl-wrap"><div class="hl"><div><a href="' + esc(h[3] || "#") +
          '" target="_blank" rel="noopener">' + esc(h[0]) + "</a>" +
          ' <span class="src">' + esc(h[2]) + "</span></div>" +
          '<span class="hl-score">' + h[1] + "</span></div></div>";
      }).join("") : '<div class="empty">No headlines match.</div>';
    });
  }
  initSearch();

  function initShare() {
    document.getElementById("shareBtn").addEventListener("click", function () {
      var c = document.createElement("canvas");
      c.width = 800; c.height = 420;
      var x = c.getContext("2d");
      x.fillStyle = "#0e1424"; x.fillRect(0, 0, 800, 420);
      x.fillStyle = "#e8eaf0"; x.font = "bold 44px sans-serif"; x.textAlign = "center";
      x.fillText("DOOM GAUGE", 400, 80);
      x.fillStyle = "#ffb020"; x.font = "bold 120px sans-serif";
      x.fillText(doomScore.toFixed(1) + "%", 400, 220);
      x.fillStyle = "#c8cddb"; x.font = "32px sans-serif";
      x.fillText(doomVerdict, 400, 290);
      x.fillStyle = "#8b93a7"; x.font = "24px sans-serif";
      x.fillText(new Date().toLocaleDateString("en-US",
        { year: "numeric", month: "long", day: "numeric" }), 400, 350);
      var a = document.createElement("a");
      a.href = c.toDataURL("image/png");
      a.download = "doom-gauge.png";
      document.body.appendChild(a); a.click(); a.remove();
    });
  }
  initShare();

  function renderIntraday() {
    var el = document.getElementById("intraday");
    getJSON("intraday.json").catch(function () { return []; }).then(function (data) {
      var fmt = new Intl.DateTimeFormat("en-CA",
        { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
      var today = fmt.format(new Date());
      var hours = {};
      (data || []).forEach(function (e) {
        var d = new Date(e.t);
        if (fmt.format(d) !== today) return;
        var h = parseInt(new Intl.DateTimeFormat("en-US",
          { timeZone: "America/Denver", hour: "numeric", hour12: false }).format(d), 10) % 24;
        hours[h] = e.score;
      });
      var keys = Object.keys(hours).map(Number).sort(function (a, b) { return a - b; });
      if (!keys.length) {
        el.innerHTML = '<div class="empty">Hourly data starts accumulating today.</div>';
        return;
      }
      var max = Math.max.apply(null, keys.map(function (k) { return hours[k]; }).concat([1]));
      el.innerHTML = '<div class="intraday-wrap" style="display:flex;align-items:flex-end;gap:3px;height:90px;width:100%">' +
        keys.map(function (k) {
          var hgt = Math.max(4, Math.round(86 * hours[k] / max));
          return '<div class="hour-bar" style="height:' + hgt + "px;background:" +
            bandColor(hours[k]) + '" title="' + k + ":00 — " + hours[k].toFixed(1) +
            '%"><span class="hh">' + k + "</span></div>";
        }).join("") + "</div>";
    });
  }

  function renderDigest(history) {
    var el = document.getElementById("digest");
    var days = history.slice(-7);
    if (days.length < 2) {
      el.innerHTML = '<div class="empty">The weekly digest needs a few days of history.</div>';
      return;
    }
    var avg = days.reduce(function (a, h) { return a + h.score; }, 0) / days.length;
    var high = days.reduce(function (a, b) { return b.score > a.score ? b : a; });
    var low = days.reduce(function (a, b) { return b.score < a.score ? b : a; });
    var kw = {};
    days.forEach(function (h) {
      (h.top_keywords || []).forEach(function (k) { kw[k] = (kw[k] || 0) + 1; });
    });
    var topKw = Object.keys(kw).sort(function (a, b) { return kw[b] - kw[a]; }).slice(0, 3);
    el.innerHTML =
      '<div class="digest-row"><span class="digest-k">7-day average</span><b>' + avg.toFixed(1) + "%</b></div>" +
      '<div class="digest-row"><span class="digest-k">Bleakest day</span><b>' + high.date + " — " + high.score.toFixed(1) + "%</b></div>" +
      '<div class="digest-row"><span class="digest-k">Calmest day</span><b>' + low.date + " — " + low.score.toFixed(1) + "%</b></div>" +
      (topKw.length ? '<div class="digest-row"><span class="digest-k">Recurring doom words</span><b>' +
        topKw.map(esc).join(", ") + "</b></div>" : "");
  }

  (function initEmbedMode() {
    var q = "";
    try { q = window.location.search || ""; } catch (e) {}
    if (q.indexOf("embed=1") === -1) return;
    document.body.classList.add("embed-mode");
    var brand = document.querySelector(".brand");
    if (brand) {
      var a = document.createElement("a");
      a.className = "brand";
      a.href = "https://stevecarlinco.github.io/DoomGauge/";
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = brand.textContent;
      brand.parentNode.replaceChild(a, brand);
    }
  })();

  function initEmbed() {    var modal = document.getElementById("embedModal");
    var btn = document.getElementById("embedBtn");
    var close = document.getElementById("embedClose");
    var code = document.getElementById("embedCode");
    var copy = document.getElementById("embedCopy");
    function shut() { modal.hidden = true; }
    btn.addEventListener("click", function () {
      code.value = '<iframe src="https://stevecarlinco.github.io/DoomGauge/?embed=1" ' +
        'style="width:100%;max-width:600px;height:400px;border:0" title="Doom Gauge"></iframe>';
      modal.hidden = false;
    });
    close.addEventListener("click", shut);
    modal.addEventListener("click", function (e) { if (e.target === modal) shut(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") shut(); });
    copy.addEventListener("click", function () {
      code.select();
      if (navigator.clipboard) navigator.clipboard.writeText(code.value);
      else document.execCommand("copy");
      copy.textContent = "Copied!";
      setTimeout(function () { copy.textContent = "Copy"; }, 1500);
    });
  }
  initEmbed();

  Promise.all([getJSON("doom.json"), getJSON("history.json").catch(function () { return []; })])
    .then(function (res) {
      var d = res[0], history = res[1];
      document.getElementById("date").textContent = fmtDate(d.date);
      var color = renderGauge(d.score);
      var v = document.getElementById("verdict");
      v.textContent = d.verdict;
      v.style.color = color;
      document.getElementById("mood").textContent = moodFor(d.score);
      var deltaEl = document.getElementById("delta");
      if (d.delta === null || d.delta === undefined) {
        deltaEl.hidden = true;
      } else {
        deltaEl.hidden = false;
        var cls = d.delta > 0 ? "up" : d.delta < 0 ? "down" : "flat";
        var when = d.delta_date ? "vs " + d.delta_date : "vs yesterday";
        deltaEl.className = "delta " + cls;
        deltaEl.textContent = d.delta === 0 ? "No change " + when :
          (d.delta > 0 ? "▲ " : "▼ ") + Math.abs(d.delta).toFixed(1) +
          " pts " + when;
      }
      if (d.stale) {
        var badge = document.createElement("div");
        badge.className = "stale-badge";
        badge.textContent = "STALE DATA — last good fetch " + (d.fetched_at || "unknown");
        if (d.stale_reason) badge.title = d.stale_reason;
        var hero = document.querySelector(".hero");
        hero.parentNode.insertBefore(badge, hero);
      }
      var contrib = d.top_contributor
        ? "Top contributor: " + d.top_contributor.name + " — " +
          d.top_contributor.share + "% of bleakness<br/>"
        : "";
      var streak = d.streak_days > 0
        ? "Streak: " + d.streak_days + " day" + (d.streak_days === 1 ? "" : "s") +
          " at 35%+ doom<br/>"
        : "Streak: reset. Enjoy it.<br/>";
      document.getElementById("stats").innerHTML = contrib + streak +
        "Headlines scored: " + d.headline_count + " across " + d.feed_count + " feeds";
      renderSources(d.sources, history);
      renderTopics(d.topics || []);
      renderHeadlines(d.headlines);
      renderWeek(history);
      renderBleakWeek(history);
      renderTopicTrends(history);
      renderForecast(history);
      renderHealth(d.feed_health || [], d.fetched_at);
      renderUpdated(d.generated_at);
      doomScore = d.score;
      doomVerdict = d.verdict;
      allHeads = d.all_headlines || [];
      renderPct(d.score, history);
      renderWhy(d.keyword_tally);
      renderCloud(d.keyword_tally);
      renderBias(history);
      renderIntraday();
      renderDigest(history);
    })
    .catch(function (err) {
      document.getElementById("verdict").textContent =
        "No data yet — the hourly fetch hasn't run.";
      document.getElementById("verdict").style.color = "#8b93a7";
      document.getElementById("stats").textContent = String(err && err.message || err);
    });
})();
