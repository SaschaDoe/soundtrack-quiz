/* Soundtrack-Quiz – kein Build-Schritt, reines JS. */
'use strict';

const app = document.getElementById('app');
const quizToggle = document.getElementById('quizMode');

/* ---------- kleine Helfer ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('stq:' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('stq:' + key, JSON.stringify(value)); } catch { /* privates Fenster o. ä. */ }
  },
};

const settings = {
  quiz: store.get('quiz', false),
  autoNext: store.get('autoNext', true),
};

async function fetchJSON(path) {
  const res = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} konnte nicht geladen werden (HTTP ${res.status}).`);
  return res.json();
}

function videoIdFrom(url) {
  if (!url) return null;
  const s = String(url).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function watchUrl(track) {
  const id = videoIdFrom(track.url);
  if (!id) return track.url || '#';
  const t = Math.floor(Number(track.start) || 0);
  return `https://www.youtube.com/watch?v=${id}${t ? `&t=${t}s` : ''}`;
}

const dateFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
const dayFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric' });
const monFmt = new Intl.DateTimeFormat('de-DE', { month: 'short' });
const parseDate = (d) => (d ? new Date(`${d}T12:00:00`) : null);
const fmtDate = (d) => { const x = parseDate(d); return x && !isNaN(x) ? dateFmt.format(x) : ''; };

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/* ---------- YouTube IFrame API ---------- */
let ytPromise = null;
function loadYT() {
  if (ytPromise) return ytPromise;
  ytPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytPromise = null; reject(new Error('YouTube-Player konnte nicht geladen werden.')); };
    document.head.appendChild(s);
  });
  return ytPromise;
}

const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

/**
 * Ein Player pro Track.
 * Ablauf: prepare() spielt das Video STUMM an. Werbung läuft also lautlos durch.
 * Sobald der eigentliche Inhalt läuft (Zeit bewegt sich, richtige Video-ID/Länge),
 * wird pausiert, an den Startpunkt gespult und auf "Start" gewartet.
 */
class TrackPlayer {
  constructor(track, mount, onChange) {
    this.track = track;
    this.mount = mount;
    this.onChange = onChange;
    this.videoId = videoIdFrom(track.url);
    this.start = Math.max(0, Number(track.start) || 0);
    this.end = Number(track.end) || 0;
    this.status = 'idle';
    this.note = '';
    this.player = null;
    this.timer = null;
    this.lastT = -1;
    this.stallMs = 0;
    this.adMuted = false;
    this.prepSince = 0;
    this.ourPause = false;
  }

  set(status, note = '') {
    this.status = status;
    this.note = note;
    this.onChange(this);
  }

  async prepare() {
    if (this.player) {
      // erneutes Tippen = Nutzergeste -> nochmal stumm anstoßen (hilft, wenn Autoplay blockiert war)
      try { this.player.mute(); this.player.playVideo(); } catch { /* noch nicht bereit */ }
      this.prepSince = Date.now();
      if (this.status === 'error') return;
      this.set('ad');
      return;
    }
    if (!this.videoId) return this.set('error', 'Kein gültiger YouTube-Link.');
    this.set('loading');
    let YT;
    try { YT = await loadYT(); } catch (e) { return this.set('error', e.message); }

    const el = document.createElement('div');
    this.mount.replaceChildren(el);
    const vars = {
      autoplay: 1, mute: 1, playsinline: 1, rel: 0, iv_load_policy: 3, fs: 0, disablekb: 1,
      start: Math.floor(this.start),
    };
    if (location.protocol.startsWith('http')) vars.origin = location.origin;

    this.player = new YT.Player(el, {
      videoId: this.videoId,
      width: '100%',
      height: '100%',
      playerVars: vars,
      events: {
        onReady: () => this.onReady(),
        onStateChange: (e) => this.onState(e.data),
        onError: (e) => this.onError(e.data),
      },
    });
  }

  onReady() {
    try { this.player.mute(); this.player.playVideo(); } catch { /* ignore */ }
    this.prepSince = Date.now();
    this.set('ad');
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 250);
  }

  onError(code) {
    const msg = {
      2: 'Ungültige Video-ID.',
      5: 'Video kann im Browser nicht abgespielt werden.',
      100: 'Video nicht gefunden (gelöscht oder privat).',
      101: 'Einbetten vom Kanal verboten – bitte auf YouTube öffnen.',
      150: 'Einbetten vom Kanal verboten – bitte auf YouTube öffnen.',
    }[code] || `YouTube-Fehler ${code}.`;
    clearInterval(this.timer);
    this.set('error', msg);
  }

  /** Ist das, was gerade läuft, wirklich unser Video (und keine Werbung)? */
  isContent() {
    const p = this.player;
    try {
      const d = p.getVideoData && p.getVideoData();
      if (d && d.video_id && d.video_id !== this.videoId) return false;
    } catch { /* ignore */ }
    const dur = p.getDuration ? p.getDuration() : 0;
    const expected = Number(this.track.duration) || 0;
    if (expected && dur && Math.abs(dur - expected) > 6) return false;
    return true;
  }

  tick() {
    const p = this.player;
    if (!p || typeof p.getPlayerState !== 'function') return;
    let st, t;
    try { st = p.getPlayerState(); t = p.getCurrentTime() || 0; } catch { return; }
    const moved = this.lastT >= 0 && Math.abs(t - this.lastT) > 0.05;

    if (this.status === 'ad') {
      const waited = Date.now() - this.prepSince;
      const contentRunning = st === YT_STATE.PLAYING && t >= this.start + 0.5 && moved;
      if (contentRunning && (this.isContent() || waited > 90000)) {
        this.ourPause = true;
        p.pauseVideo();
        p.seekTo(this.start, true);
        this.set('ready');
      } else if (waited > 7000 && (st === YT_STATE.UNSTARTED || st === YT_STATE.CUED) && !this.note) {
        this.set('ad', 'Startet nicht? Tippe auf „Erneut anstoßen“.');
      }
    } else if (this.status === 'playing' || this.status === 'midad') {
      if (this.end && t >= this.end) {
        this.ourPause = true;
        p.pauseVideo();
        this.set('ended');
      } else if (st === YT_STATE.PLAYING) {
        // Zeit steht, obwohl "PLAYING" -> sehr wahrscheinlich Mid-Roll-Werbung: stumm schalten
        if (!moved) {
          this.stallMs += 250;
          if (this.stallMs >= 1500 && !this.adMuted) {
            p.mute();
            this.adMuted = true;
            this.set('midad');
          }
        } else {
          this.stallMs = 0;
          if (this.adMuted) {
            p.unMute();
            this.adMuted = false;
            this.set('playing');
          }
        }
      } else {
        this.stallMs = 0;
      }
    }
    this.lastT = t;
  }

  onState(s) {
    // Nur synchronisieren, wenn der Nutzer direkt im YouTube-Player klickt
    if (this.ourPause && s === YT_STATE.PAUSED) { this.ourPause = false; return; }
    if (this.status === 'playing' && s === YT_STATE.PAUSED) this.set('paused');
    else if (this.status === 'playing' && s === YT_STATE.ENDED) this.set('ended');
    else if ((this.status === 'paused' || this.status === 'ended' || this.status === 'ready') && s === YT_STATE.PLAYING) {
      try { this.player.unMute(); } catch { /* ignore */ }
      this.set('playing');
    }
  }

  /** Muss direkt aus einem Klick aufgerufen werden (Ton freischalten auf Mobilgeräten). */
  play() {
    const p = this.player;
    if (!p || typeof p.playVideo !== 'function') return;
    this.adMuted = false;
    this.stallMs = 0;
    p.unMute();
    p.setVolume(100);
    if (this.status === 'ended') p.seekTo(this.start, true);
    p.playVideo();
    try { this.lastT = p.getCurrentTime(); } catch { this.lastT = -1; }
    this.set('playing');
  }

  pause() {
    if (!this.player) return;
    this.ourPause = true;
    this.player.pauseVideo();
    this.set('paused');
  }

  restart() {
    if (!this.player) return;
    this.player.seekTo(this.start, true);
    if (this.status !== 'playing') this.play();
  }

  destroy() {
    clearInterval(this.timer);
    try { this.player && this.player.destroy(); } catch { /* ignore */ }
    this.player = null;
    this.mount.replaceChildren();
    this.status = 'idle';
  }
}

/* ---------- Ansicht: Übersicht ---------- */
async function renderHome() {
  app.innerHTML = '<div class="loading">Lade Listen …</div>';
  let index;
  try {
    index = await fetchJSON('lists/index.json');
  } catch (e) {
    app.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
    return;
  }
  const lists = (index.lists || []).slice().sort((a, b) =>
    String(b.created || '').localeCompare(String(a.created || '')) || String(b.id).localeCompare(String(a.id)));

  if (!lists.length) {
    app.innerHTML = `
      <div class="empty">
        <div class="big">🎧</div>
        <p><b>Noch keine Listen.</b></p>
        <p>Sag in Claude Code z.&nbsp;B. <i>„Such mir Soundtracks zum Thema Drachen raus“</i> –
        die fertige Liste erscheint dann hier.</p>
      </div>`;
    return;
  }

  const [newest, ...older] = lists;
  const count = (l) => `${l.count ?? '?'} Tracks`;
  app.innerHTML = `
    <a class="hero" href="#/liste/${encodeURIComponent(newest.id)}">
      <span class="badge">Neueste Liste</span>
      <h1>${esc(newest.title)}</h1>
      ${newest.description ? `<p>${esc(newest.description)}</p>` : ''}
      <div class="meta"><span>📅 ${esc(fmtDate(newest.created))}</span><span>🎵 ${count(newest)}</span></div>
      <span class="btn btn-primary hero-cta">Quiz öffnen →</span>
    </a>
    ${older.length ? `<h2>Frühere Listen</h2>
    <div class="list-rows">
      ${older.map((l) => {
        const d = parseDate(l.created);
        return `
        <a class="list-row" href="#/liste/${encodeURIComponent(l.id)}">
          <span class="date-chip"><b>${d ? dayFmt.format(d) : '–'}</b><small>${d ? esc(monFmt.format(d)) : ''}</small></span>
          <span class="row-main">
            <span class="row-title">${esc(l.title)}</span>
            <span class="row-desc">${esc(count(l))}${l.description ? ' · ' + esc(l.description) : ''}</span>
          </span>
          <span class="chev">›</span>
        </a>`;
      }).join('')}
    </div>` : ''}`;
}

/* ---------- Ansicht: eine Liste ---------- */
let view = null; // { list, players[], revealed:Set, showVideo:Set, nowIndex }

function destroyView() {
  if (view) view.players.forEach((p) => p && p.destroy());
  view = null;
  updateNowPlaying();
}

async function renderList(id) {
  app.innerHTML = '<div class="loading">Lade Liste …</div>';
  let list;
  try {
    list = await fetchJSON(`lists/${encodeURIComponent(id)}.json`);
  } catch (e) {
    app.innerHTML = `<a class="back" href="#/">‹ Alle Listen</a><div class="error-box">${esc(e.message)}</div>`;
    return;
  }
  const tracks = list.tracks || [];
  view = { list, players: [], revealed: new Set(), showVideo: new Set(), nowIndex: -1 };
  document.title = `${list.title} – Soundtrack-Quiz`;

  app.innerHTML = `
    <a class="back" href="#/">‹ Alle Listen</a>
    <div class="list-head">
      <h1>${esc(list.title)}</h1>
      ${list.description ? `<p class="lead">${esc(list.description)}</p>` : ''}
      <div class="meta"><span>📅 ${esc(fmtDate(list.created))}</span><span>🎵 ${tracks.length} Tracks</span></div>
    </div>
    <div class="toolbar">
      <label><input type="checkbox" id="autoNext" ${settings.autoNext ? 'checked' : ''}> Nächsten Track automatisch stumm vorladen</label>
      <button class="btn btn-ghost" type="button" data-act="prep-first" style="min-height:38px">Track 1 vorbereiten</button>
    </div>
    <div class="tracks">
      ${tracks.map((t, i) => `
        <article class="track" id="track-${i}" data-i="${i}">
          <div class="track-head">
            <div class="track-num">${i + 1}</div>
            <div class="track-info"></div>
          </div>
          <div class="player-wrap" hidden>
            <div class="player-box">
              <div class="mount"></div>
              <div class="player-cover"></div>
            </div>
          </div>
          <div class="status" data-s="idle"><span class="dot"></span><span class="status-text"></span></div>
          <div class="actions"></div>
          <details class="trivia"><summary></summary><div class="trivia-body"></div></details>
        </article>`).join('')}
    </div>`;

  tracks.forEach((t, i) => {
    const card = document.getElementById(`track-${i}`);
    view.players[i] = new TrackPlayer(t, card.querySelector('.mount'), () => onPlayerChange(i));
    updateCard(i);
  });

  document.getElementById('autoNext').addEventListener('change', (e) => {
    settings.autoNext = e.target.checked;
    store.set('autoNext', settings.autoNext);
  });
}

const STATUS_TEXT = {
  idle: 'Noch nicht geladen',
  loading: 'Lade Player …',
  ad: 'Lädt stumm vor – eventuelle Werbung läuft ohne Ton …',
  ready: 'Bereit! Werbung ist durch – drück auf Start.',
  playing: 'Läuft',
  midad: 'Werbung zwischendurch – stumm geschaltet',
  paused: 'Pausiert',
  ended: 'Ende erreicht',
  error: 'Fehler',
};

function trackInfoHTML(t, i, hidden) {
  const range = (t.start || t.end)
    ? `<span>⏱ ${fmtTime(t.start)}${t.end ? '–' + fmtTime(t.end) : ''}</span>` : '';
  if (hidden) {
    return `
      <div class="track-work">Track ${i + 1}</div>
      <div class="track-title hidden-answer">Lösung verborgen</div>
      <div class="track-meta">${t.type ? `<span class="pill">${esc(t.type)}</span>` : ''}${range}</div>`;
  }
  const work = t.work || t.title || 'Unbekannt';
  const orig = t.workOriginal && t.workOriginal !== work ? ` <span class="pill">${esc(t.workOriginal)}</span>` : '';
  return `
    <div class="track-work">${esc(work)}${orig}</div>
    ${t.title && t.title !== work ? `<div class="track-title">„${esc(t.title)}“</div>` : ''}
    <div class="track-meta">
      ${t.type ? `<span class="pill">${esc(t.type)}</span>` : ''}
      ${t.composer ? `<span>🎼 ${esc(t.composer)}</span>` : ''}
      ${t.year ? `<span>${esc(t.year)}</span>` : ''}
      ${range}
    </div>`;
}

function actionsHTML(p, i, hidden, quiz) {
  const yt = `<a class="btn btn-ghost" href="${esc(watchUrl(p.track))}" target="_blank" rel="noopener">YouTube ↗</a>`;
  const reveal = quiz ? `<button class="btn btn-ghost" type="button" data-act="reveal">${hidden ? '👁 Aufdecken' : '🙈 Verbergen'}</button>` : '';
  const vid = quiz && p.status !== 'idle' && p.status !== 'error'
    ? `<button class="btn btn-ghost btn-icon" type="button" data-act="video" title="Video ein-/ausblenden">${view.showVideo.has(i) ? '🎬' : '🎵'}</button>` : '';
  switch (p.status) {
    case 'idle':
      return `<button class="btn btn-primary btn-grow" type="button" data-act="prepare">Vorbereiten (stumm)</button>${reveal}${yt}`;
    case 'loading':
    case 'ad':
      return `<button class="btn btn-grow" type="button" data-act="prepare">↻ Erneut anstoßen</button>
              <button class="btn btn-ghost" type="button" data-act="play" title="Startet sofort mit Ton – auch wenn noch Werbung läuft">Trotzdem starten</button>${vid}${reveal}`;
    case 'ready':
      return `<button class="btn btn-ready btn-grow" type="button" data-act="play">▶ Start</button>${vid}${reveal}${yt}`;
    case 'playing':
    case 'midad':
      return `<button class="btn btn-primary btn-grow" type="button" data-act="pause">❚❚ Pause</button>
              <button class="btn" type="button" data-act="restart">↺ Von vorn</button>${vid}${reveal}`;
    case 'paused':
    case 'ended':
      return `<button class="btn btn-primary btn-grow" type="button" data-act="play">▶ ${p.status === 'ended' ? 'Nochmal' : 'Weiter'}</button>
              <button class="btn" type="button" data-act="restart">↺ Von vorn</button>${vid}${reveal}${yt}`;
    case 'error':
    default:
      return `<a class="btn btn-primary btn-grow" href="${esc(watchUrl(p.track))}" target="_blank" rel="noopener">Auf YouTube öffnen ↗</a>${reveal}`;
  }
}

function coverHTML(status) {
  if (status === 'playing') return '<div><div class="eq"><i></i><i></i><i></i><i></i></div><div style="margin-top:10px">Läuft …</div></div>';
  if (status === 'ready') return '<div><div class="cover-icon">✓</div><div>Bereit</div></div>';
  if (status === 'ad' || status === 'loading' || status === 'midad') return '<div><div class="cover-icon">🔇</div><div>Werbung läuft stumm …</div></div>';
  return '<div><div class="cover-icon">♫</div><div>Video verborgen</div></div>';
}

function updateCard(i) {
  if (!view) return;
  const card = document.getElementById(`track-${i}`);
  const p = view.players[i];
  const t = p.track;
  const quiz = settings.quiz;
  const hidden = quiz && !view.revealed.has(i);

  card.classList.toggle('is-playing', p.status === 'playing' || p.status === 'midad');
  card.classList.toggle('is-ready', p.status === 'ready');
  card.querySelector('.track-info').innerHTML = trackInfoHTML(t, i, hidden);

  const wrap = card.querySelector('.player-wrap');
  wrap.hidden = p.status === 'idle';
  const cover = card.querySelector('.player-cover');
  const showCover = quiz && !view.showVideo.has(i) && p.status !== 'error';
  cover.classList.toggle('hidden', !showCover);
  if (showCover) cover.innerHTML = coverHTML(p.status);

  const status = card.querySelector('.status');
  status.dataset.s = p.status;
  status.querySelector('.status-text').textContent = p.note ? `${STATUS_TEXT[p.status]} ${p.note}` : STATUS_TEXT[p.status];
  if (p.status === 'error') status.querySelector('.status-text').textContent = p.note || STATUS_TEXT.error;

  card.querySelector('.actions').innerHTML = actionsHTML(p, i, hidden, quiz);

  const trivia = card.querySelector('details.trivia');
  const facts = Array.isArray(t.trivia) ? t.trivia : (t.trivia ? [t.trivia] : []);
  const hasContent = facts.length || t.hint;
  trivia.hidden = !hasContent || hidden;
  if (hasContent && !hidden) {
    trivia.querySelector('summary').textContent = `Trivia${facts.length ? ` (${facts.length})` : ''}`;
    trivia.querySelector('.trivia-body').innerHTML =
      (t.hint ? `<div class="hint"><b>Tipp für die Runde:</b> ${esc(t.hint)}</div>` : '') +
      (facts.length ? `<ul>${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '');
  }
}

function onPlayerChange(i) {
  if (!view) return;
  updateCard(i);
  if (i === view.nowIndex) updateNowPlaying();
}

function startTrack(i) {
  const p = view.players[i];
  // alle anderen laufenden Tracks pausieren
  view.players.forEach((o, j) => { if (j !== i && (o.status === 'playing' || o.status === 'midad')) o.pause(); });
  p.play();
  view.nowIndex = i;
  updateNowPlaying();

  // Speicher sparen: weit entfernte Player abbauen
  view.players.forEach((o, j) => {
    if (Math.abs(j - i) > 2 && o.status !== 'idle' && o.status !== 'playing') { o.destroy(); updateCard(j); }
  });
  // nächsten Track schon mal stumm vorladen
  const next = view.players[i + 1];
  if (settings.autoNext && next && next.status === 'idle') next.prepare();
}

app.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !view) return;
  const act = btn.dataset.act;
  if (act === 'prep-first') {
    const first = view.players[0];
    if (first && first.status === 'idle') first.prepare();
    document.getElementById('track-0')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const card = btn.closest('.track');
  if (!card) return;
  const i = Number(card.dataset.i);
  const p = view.players[i];
  switch (act) {
    case 'prepare': p.prepare(); break;
    case 'play': startTrack(i); break;
    case 'pause': p.pause(); break;
    case 'restart':
      if (view.nowIndex !== i) startTrack(i); else p.restart();
      break;
    case 'reveal':
      view.revealed.has(i) ? view.revealed.delete(i) : view.revealed.add(i);
      updateCard(i);
      if (i === view.nowIndex) updateNowPlaying();
      break;
    case 'video':
      view.showVideo.has(i) ? view.showVideo.delete(i) : view.showVideo.add(i);
      updateCard(i);
      break;
  }
});

/* ---------- "Jetzt läuft"-Leiste ---------- */
const np = {
  bar: document.getElementById('nowPlaying'),
  num: document.getElementById('npNum'),
  title: document.getElementById('npTitle'),
  status: document.getElementById('npStatus'),
  toggle: document.getElementById('npToggle'),
  jump: document.getElementById('npJump'),
};

function updateNowPlaying() {
  if (!view || view.nowIndex < 0) { np.bar.hidden = true; return; }
  const i = view.nowIndex;
  const p = view.players[i];
  if (!p || p.status === 'idle') { np.bar.hidden = true; return; }
  const hidden = settings.quiz && !view.revealed.has(i);
  np.bar.hidden = false;
  np.num.textContent = i + 1;
  np.title.textContent = hidden ? `Track ${i + 1}` : (p.track.work || p.track.title || `Track ${i + 1}`);
  np.status.textContent = STATUS_TEXT[p.status];
  const playing = p.status === 'playing' || p.status === 'midad';
  np.toggle.textContent = playing ? '❚❚' : '▶';
  np.toggle.setAttribute('aria-label', playing ? 'Pause' : 'Abspielen');
}

np.toggle.addEventListener('click', () => {
  if (!view || view.nowIndex < 0) return;
  const p = view.players[view.nowIndex];
  if (p.status === 'playing' || p.status === 'midad') p.pause(); else startTrack(view.nowIndex);
});
np.jump.addEventListener('click', () => {
  if (view && view.nowIndex >= 0) document.getElementById(`track-${view.nowIndex}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

/* ---------- Quizmodus ---------- */
quizToggle.checked = settings.quiz;
quizToggle.addEventListener('change', () => {
  settings.quiz = quizToggle.checked;
  store.set('quiz', settings.quiz);
  if (view) { view.players.forEach((_, i) => updateCard(i)); updateNowPlaying(); }
});

/* ---------- Routing ---------- */
function route() {
  destroyView();
  document.title = 'Soundtrack-Quiz';
  const m = location.hash.match(/^#\/liste\/(.+)$/);
  if (m) renderList(decodeURIComponent(m[1]));
  else renderHome();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();
