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

  function fmtUpdated(iso) {
    try {
      return new Date(iso).toLocaleString("en-US", {
        timeZone: "America/Denver", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short"
      });
    } catch (e) { return iso; }
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

  function renderSources(sources) {
    var el = document.getElementById("sources");
    var rows = sources.slice().sort(function (a, b) { return b.score - a.score; });
    el.innerHTML = rows.map(function (s) {
      var c = bandColor(s.score);
      return '<div class="src-row"><span class="src-name">' + esc(s.name) + "</span>" +
        '<div class="src-bar"><div class="src-fill" style="width:' +
        Math.min(100, s.score).toFixed(1) + "%;background:" + c + ';"></div></div>' +
        '<span class="src-val">' + s.score.toFixed(0) + "</span></div>";
    }).join("");
  }

  function renderHeadlines(headlines) {
    var el = document.getElementById("headlines");
    if (!headlines.length) {
      el.innerHTML = '<div class="empty">No headlines scored yet.</div>';
      return;
    }
    el.innerHTML = headlines.map(function (h) {
      var c = bandColor(h.score);
      var title = esc(h.title);
      var body = h.link
        ? '<a href="' + esc(h.link) + '" target="_blank" rel="noopener">' + title + "</a>"
        : title;
      return '<div class="hl"><div>' + body +
        ' <span class="src">' + esc(h.source) + "</span></div>" +
        '<span class="hl-score" style="color:' + c + '">' + h.score + "</span></div>";
    }).join("");
  }

  function renderWeek(history) {
    var el = document.getElementById("week");
    var days = history.slice(-7);
    if (!days.length) {
      el.innerHTML = '<div class="empty">History builds up day by day.</div>';
      return;
    }
    var today = days[days.length - 1].date;
    el.innerHTML = days.map(function (h) {
      var c = bandColor(h.score);
      var d = new Date(h.date + "T12:00:00");
      var lbl = "SMTWTFS"[d.getDay()];
      var cls = h.date === today ? "day today" : "day";
      return '<div class="' + cls + '"><div class="bar" style="height:' +
        Math.max(4, h.score) + "px;background:" + c + ';"></div>' +
        '<div class="lbl">' + lbl + "</div></div>";
    }).join("");
  }

  function getJSON(path) {
    return fetch(path, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(path + " " + r.status);
      return r.json();
    });
  }

  Promise.all([getJSON("doom.json"), getJSON("history.json").catch(function () { return []; })])
    .then(function (res) {
      var d = res[0], history = res[1];
      document.getElementById("date").textContent = fmtDate(d.date);
      var color = renderGauge(d.score);
      var v = document.getElementById("verdict");
      v.textContent = d.verdict;
      v.style.color = color;
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
      renderSources(d.sources);
      renderHeadlines(d.headlines);
      renderWeek(history);
      document.getElementById("updated").textContent =
        "Updated " + fmtUpdated(d.generated_at) + " · fetches hourly";
    })
    .catch(function (err) {
      document.getElementById("verdict").textContent =
        "No data yet — the hourly fetch hasn't run.";
      document.getElementById("verdict").style.color = "#8b93a7";
      document.getElementById("stats").textContent = String(err && err.message || err);
    });
})();
