/* ShapesOS — Phase 18.3 (WS=flow): fills /offline.html from the service
 * worker's per-person read cache (Home, Mail, Calendar, Notes, Reminders,
 * Files) and queues new notes / reminders in the app's offline queue
 * (lib/offline/queue.ts: storage key "shapes_offline_queue_app", items
 * { clientId, kind, method, url, body, queuedAt, attempts }), which the app
 * replays — once, keyed on the client id — when it is back online.
 * Strings and colour tokens come from the app (posted to the worker in the
 * person's language and theme); the English below is only the fallback. */
(function () {
  "use strict";
  var QUEUE_KEY = "shapes_offline_queue_app";
  var FALLBACK = {
    title: "You're offline",
    subtitle: "Showing the copies saved on this device. New notes and reminders are saved here and sent once you're back online.",
    retry: "Try again",
    composeTitle: "Add while offline",
    noteLabel: "New note",
    saveNote: "Save note when online",
    saveReminder: "Save as a reminder",
    queued: "{count} waiting to send",
    savedNote: "Saved on this device. It will be sent when you're back online.",
    empty: "Nothing saved on this device yet. Open your apps while online to keep a copy here.",
    backOnline: "You're back online.",
    openApp: "Open ShapesOS",
    noSession: "Sign in while online to keep copies of your notes, mail and calendar on this device.",
    sections: { home: "Home", mail: "Mail", calendar: "Calendar", notes: "Notes", reminders: "Reminders", files: "Files" },
    write: "Write something first."
  };
  var SECTIONS = [
    { id: "notes", re: /^\/api\/notes$/ },
    { id: "reminders", re: /^\/api\/comms\/reminders$/ },
    { id: "mail", re: /^\/api\/comms\/mail\/threads$/ },
    { id: "calendar", re: /^\/api\/comms\/calendar\/events$/ },
    { id: "files", re: /^\/api\/files$/ },
    { id: "home", re: /^\/api\/desk\/(layout|briefing)$/ }
  ];
  var S = FALLBACK;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function fmt(s, vars) { return String(s).replace(/\{(\w+)\}/g, function (_, k) { return vars[k] != null ? vars[k] : ""; }); }
  function readJson(cache, url) { return cache.match(url, { ignoreVary: true }).then(function (r) { return r ? r.json() : null; }).catch(function () { return null; }); }

  function readQueue() {
    try { var v = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function enqueue(item) {
    var q = readQueue();
    if (q.some(function (w) { return w.clientId === item.clientId; })) return q;
    q.push(item);
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) { /* storage full or blocked */ }
    return q;
  }
  function clientId(prefix) {
    var r = (self.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, "") : (Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
    return (prefix + "_" + r).slice(0, 64);
  }
  function showQueued() { var n = readQueue().length; $("queued").textContent = n ? fmt(S.queued, { count: n }) : ""; }
  function status(text) { var s = $("status"); s.textContent = text; s.hidden = !text; }

  function textOf(doc) {
    var out = [];
    (function walk(n) {
      if (!n || typeof n !== "object") return;
      if (typeof n.text === "string") out.push(n.text);
      if (Array.isArray(n.content)) { n.content.forEach(walk); if (n.type === "paragraph" || n.type === "heading" || n.type === "listItem") out.push("\n"); }
    })(doc);
    return out.join("").replace(/\n{3,}/g, "\n\n").trim();
  }
  function firstArray(obj) {
    if (!obj || typeof obj !== "object") return [];
    for (var k in obj) if (Array.isArray(obj[k])) return obj[k];
    return [];
  }
  function pick(o, keys) { for (var i = 0; i < keys.length; i++) { var v = o && o[keys[i]]; if (typeof v === "string" && v.trim()) return v; } return ""; }

  function applyTokens(tokens) {
    if (!tokens) return;
    for (var k in tokens) if (/^--aos-[a-z0-9-]+$/.test(k) && typeof tokens[k] === "string" && /^[#a-zA-Z0-9(),.\s%-]{1,64}$/.test(tokens[k])) document.documentElement.style.setProperty(k, tokens[k]);
  }
  function applyStrings() {
    document.documentElement.lang = S.lang || "en";
    document.title = "ShapesOS — " + S.title;
    $("title").textContent = S.title; $("subtitle").textContent = S.subtitle; $("retry").textContent = S.retry;
    $("compose-title").textContent = S.composeTitle; $("note-label").textContent = S.noteLabel;
    $("save-note").textContent = S.saveNote; $("save-reminder").textContent = S.saveReminder;
  }

  function render(cache) {
    var root = $("sections");
    return cache.keys().then(function (reqs) {
      var byId = {}; var notesById = {};
      reqs.forEach(function (r) {
        var u = new URL(r.url);
        var m = /^\/api\/notes\/([A-Za-z0-9_-]+)$/.exec(u.pathname);
        if (m) { notesById[m[1]] = r.url; return; }
        SECTIONS.forEach(function (s) { if (s.re.test(u.pathname)) (byId[s.id] = byId[s.id] || []).push(r.url); });
      });
      var any = false;
      var chain = Promise.resolve();
      SECTIONS.forEach(function (s) {
        var urls = byId[s.id];
        if (!urls || !urls.length) return;
        chain = chain.then(function () {
          return readJson(cache, urls[0]).then(function (data) {
            var items = firstArray(data).slice(0, 50);
            if (!items.length) return;
            any = true;
            var sec = el("section", "card"); sec.setAttribute("aria-labelledby", "sec-" + s.id);
            var h = el("h2", null, S.sections[s.id] || s.id); h.id = "sec-" + s.id; sec.appendChild(h);
            var ul = el("ul");
            items.forEach(function (it) {
              var li = el("li");
              var title = pick(it, ["title", "subject", "name", "filename", "summary"]) || "—";
              var sub = pick(it, ["preview", "snippet", "dueAt", "start", "startsAt", "from", "logicalPath", "updatedAt"]);
              if (s.id === "notes" && it.id && notesById[it.id]) {
                var d = el("details"); d.appendChild(el("summary", "t", title));
                var body = el("div", "note-body");
                readJson(cache, notesById[it.id]).then(function (n) { body.textContent = n && n.note ? textOf(n.note.content) : ""; });
                d.appendChild(body); li.appendChild(d);
              } else {
                li.appendChild(el("div", "t", title));
              }
              if (sub) li.appendChild(el("div", "s", sub));
              ul.appendChild(li);
            });
            sec.appendChild(ul); root.appendChild(sec);
          });
        });
      });
      return chain.then(function () { if (!any) root.appendChild(el("p", "card muted", S.empty)); });
    });
  }

  function queueWrite(kind) {
    var text = $("note-text").value.trim();
    if (!text) { status(S.write); return; }
    var id = clientId(kind === "note_create" ? "n" : "r");
    var url = kind === "note_create" ? "/api/notes" : "/api/comms/reminders";
    var body = kind === "note_create" ? { body: text, clientId: id } : { title: text.split("\n")[0].slice(0, 300), notes: text.split("\n").slice(1).join("\n").trim() || null, clientId: id };
    enqueue({ clientId: id, kind: kind, method: "POST", url: url, body: body, queuedAt: new Date().toISOString(), attempts: 0 });
    $("note-text").value = "";
    status(S.savedNote);
    showQueued();
  }

  $("compose").addEventListener("submit", function (e) { e.preventDefault(); queueWrite("note_create"); });
  $("save-reminder").addEventListener("click", function () { queueWrite("reminder_create"); });
  $("retry").addEventListener("click", function () { location.reload(); });
  window.addEventListener("online", function () {
    status(S.backOnline);
    var a = el("a", null, " " + S.openApp); a.href = "/dashboard"; $("status").appendChild(a);
  });

  if (!("caches" in self)) { status(S.noSession); return; }
  caches.open("shapes-meta").then(function (meta) {
    return Promise.all([readJson(meta, "/__shapes/session"), readJson(meta, "/__shapes/strings"), readJson(meta, "/__shapes/tokens")]);
  }).then(function (r) {
    if (r[1] && typeof r[1] === "object") { S = Object.assign({}, FALLBACK, r[1]); S.sections = Object.assign({}, FALLBACK.sections, r[1].sections || {}); }
    applyTokens(r[2]); applyStrings(); showQueued();
    var key = r[0] && r[0].key;
    if (!key) { status(S.noSession); return; }
    return caches.open("shapes-data-" + key).then(render);
  }).catch(function () { status(S.noSession); });
})();
