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

  function renderSources(sources, history) {
    var el = document.getElementById("sources");
    var rows = sources.slice().sort(function (a, b) { return b.score - a.score; });
    el.innerHTML = rows.map(function (s) {
      var c = bandColor(s.score);
      var trail = [];
      (history || []).slice(-7).forEach(function (day) {
        if (day.sources && typeof day.sources[s.name] === "number") {
          trail.push(day.sources[s.name]);
        }
      });
      return '<div class="src-row"><span class="src-name">' + esc(s.name) + "</span>" +
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
    }).sort(function (a, b) { return b.avg - a.avg; });
    var max = rows.length ? rows[0].avg : 0;
    el.innerHTML = rows.map(function (r, i) {
      var pct = max ? (100 * r.avg / max) : 0;
      return '<div class="src-row"><span class="src-rank">' + (i + 1) +
        '</span><span class="src-name">' + esc(r.name) +
        '</span><span class="src-bar"><span class="src-fill" style="width:' +
        pct.toFixed(1) + "%;background:" + bandColor(r.avg) +
        '"></span></span><span class="src-val">' + r.avg.toFixed(1) + "%</span></div>";
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

  function renderHealth(health, fetchedAt) {
    var el = document.getElementById("health");
    el.innerHTML = health.map(function (h) {
      var sub = h.ok ? h.headlines + " headlines" : esc(h.error || "failed");
      return '<div class="pill' + (h.ok ? "" : " bad") + '">' +
        '<span class="dot"></span><span class="pill-name">' + esc(h.name) +
        '</span><span class="pill-sub">' + sub + "</span></div>";
    }).join("");
    document.getElementById("healthNote").textContent =
      "Last checked " + (fetchedAt || "—") + ".";
  }

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
            '</div><div class="feed-url">' + esc(f.url) + "</div></div>";
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
    })
    .catch(function (err) {
      document.getElementById("verdict").textContent =
        "No data yet — the hourly fetch hasn't run.";
      document.getElementById("verdict").style.color = "#8b93a7";
      document.getElementById("stats").textContent = String(err && err.message || err);
    });
})();
