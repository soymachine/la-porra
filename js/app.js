/* La Porra Blaugrana — app principal (sin dependencias). */
(function () {
  'use strict';

  const C = window.PORRA_CONFIG;
  const PLAYERS = [
    { id: 'rodolfo', name: 'Rodolfo', img: 'img/rodolfo.svg' },
    { id: 'eric', name: 'Eric', img: 'img/eric.svg' },
    { id: 'dani', name: 'Dani', img: 'img/dani.svg' },
  ];
  const P = Object.fromEntries(PLAYERS.map((p) => [p.id, p]));
  const TZ = 'Europe/Madrid';
  const MATCH_MS = 2 * 3600e3;      // duración aproximada de un partido
  const AFTER_MS = 4 * 3600e3;      // se sigue mostrando 4 h después del final
  const ESPN_LEAGUE = {
    'LaLiga': 'esp.1',
    'Champions': 'uefa.champions',
    'Copa del Rey': 'esp.copa_del_rey',
    'Supercopa': 'esp.super_cup',
  };
  const BARCA = 'FC Barcelona';
  const ESPN_BARCA_ID = '83';

  // ---------- utilidades ----------
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  };
  const fmt = (opts) => new Intl.DateTimeFormat('es-ES', { timeZone: TZ, ...opts });
  const fDay = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
  const fTime = fmt({ hour: '2-digit', minute: '2-digit' });
  const fDayNum = fmt({ day: 'numeric' });
  const fWeekShort = fmt({ weekday: 'short' });
  const fMonth = fmt({ month: 'long', year: 'numeric' });
  const fShort = fmt({ day: 'numeric', month: 'short' });
  const fYMD = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
  const ymd = (ts) => { const p = Object.fromEntries(fYMD.formatToParts(new Date(ts)).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
  const hm = (ts) => fTime.format(new Date(ts));

  function tzOffsetMin(ts) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    return Math.round((Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - ts) / 60e3);
  }
  // fecha y hora de Madrid -> ISO UTC
  function madridToISO(date, time) {
    const [Y, M, D] = date.split('-').map(Number);
    const [h, m] = time.split(':').map(Number);
    const guess = Date.UTC(Y, M - 1, D, h, m);
    let ts = guess - tzOffsetMin(guess) * 60e3;
    ts = guess - tzOffsetMin(ts) * 60e3;
    return new Date(ts).toISOString();
  }

  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  const b64 = {
    enc: (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))),
    dec: (s) => Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)),
  };
  const utf8ToB64 = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const b64ToUtf8 = (s) => new TextDecoder().decode(b64.dec(s));

  // ---------- cifrado del token (contraseña familiar) ----------
  async function deriveKey(pass, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }
  async function decryptToken(enc, pass) {
    const key = await deriveKey(pass.trim().toLowerCase(), b64.dec(enc.salt));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(enc.iv) }, key, b64.dec(enc.ct));
    return new TextDecoder().decode(pt);
  }

  // ---------- "base de datos": ficheros JSON en el propio repositorio ----------
  const GH = {
    token: LS.get('porra.token'),
    url: (path) => `https://api.github.com/repos/${C.owner}/${C.repo}/contents/${path}`,
    headers() {
      return { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28' };
    },
    async read(path) {
      if (this.token) {
        const r = await fetch(`${this.url(path)}?ref=${encodeURIComponent(C.branch)}&_=${Date.now()}`, { headers: this.headers(), cache: 'no-store' });
        if (r.status === 404) return { data: null, sha: null };
        if (r.status === 401) { this.token = null; LS.set('porra.token', null); throw new Error('La clave ha caducado. Vuelve a entrar con la contraseña familiar.'); }
        if (!r.ok) throw new Error(`GitHub ${r.status}`);
        const j = await r.json();
        return { data: JSON.parse(b64ToUtf8(j.content)), sha: j.sha };
      }
      // Sin clave: solo lectura de la copia publicada en GitHub Pages
      const r = await fetch(`${path}?_=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return { data: null, sha: null };
      return { data: await r.json(), sha: null };
    },
    // mutate(datosActuales) -> nuevosDatos. Reintenta si alguien escribió a la vez.
    async write(path, mutate, message) {
      if (!this.token) throw new Error('Necesitas la contraseña familiar para guardar.');
      for (let attempt = 0; attempt < 5; attempt++) {
        const { data, sha } = await this.read(path);
        const next = mutate(data);
        const body = { message, content: utf8ToB64(JSON.stringify(next, null, 1) + '\n'), branch: C.branch };
        if (sha) body.sha = sha;
        const r = await fetch(this.url(path), { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) });
        if (r.ok) return next;
        if (r.status !== 409 && r.status !== 422) throw new Error(`No se pudo guardar (GitHub ${r.status})`);
        await new Promise((res) => setTimeout(res, 400 + Math.random() * 800));
      }
      throw new Error('No se pudo guardar, inténtalo otra vez.');
    },
  };

  // ---------- estado ----------
  const S = {
    me: LS.get('porra.me'),
    tab: 'partido',
    fixtures: [],
    results: {},
    porras: { rodolfo: {}, eric: {}, dani: {} },
    live: {},          // id -> datos en directo de ESPN
    liveOk: null,      // si ESPN responde desde este navegador
    draft: null,       // porra que se está editando
    calFilter: 'all',  // filtro del calendario
  };
  if (S.me && !P[S.me]) S.me = null;

  async function loadAll() {
    const [fx, res, ...ps] = await Promise.all([
      GH.read('data/fixtures.json'),
      GH.read('data/results.json'),
      ...PLAYERS.map((p) => GH.read(`data/porras/${p.id}.json`)),
    ]);
    S.fixtures = (fx.data || []).slice().sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
    S.results = res.data || {};
    PLAYERS.forEach((p, i) => { S.porras[p.id] = ps[i].data || {}; });
  }

  // ---------- lógica de partidos ----------
  const kick = (f) => Date.parse(f.kickoff);
  const isBarcaHome = (f) => f.home === BARCA;
  const rival = (f) => (isBarcaHome(f) ? f.away : f.home);
  const predsFor = (f) => Object.fromEntries(PLAYERS.map((p) => [p.id, S.porras[p.id][f.id]]).filter(([, v]) => v));

  function matchEnd(f) {
    const r = S.results[f.id];
    if (r && r.final && r.endedAt) return Date.parse(r.endedAt) + AFTER_MS;
    const live = S.live[f.id];
    const end = kick(f) + MATCH_MS + AFTER_MS;
    if (live && live.state === 'in') return Math.max(end, Date.now() + AFTER_MS);
    return end;
  }
  function currentMatch() {
    const now = Date.now();
    return S.fixtures.find((f) => !f.cancelled && now < matchEnd(f));
  }
  // marcador a mostrar: directo de ESPN o el guardado
  function scoreFor(f) {
    const r = S.results[f.id];
    if (r && r.final) return { h: r.h, a: r.a, final: true, src: r.by };
    const live = S.live[f.id];
    if (live && live.state !== 'pre') return { h: live.h, a: live.a, final: live.state === 'post', clock: live.clock, src: 'espn' };
    if (r) return { h: r.h, a: r.a, final: false, src: r.by };
    return null;
  }

  // ---------- resultados en directo (ESPN, gratuito, sin clave) ----------
  async function fetchLive(f) {
    const lg = ESPN_LEAGUE[f.competition];
    if (!lg) return null;
    const day = ymd(kick(f)).replace(/-/g, '');
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard?dates=${day}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('ESPN ' + r.status);
    const j = await r.json();
    const ev = (j.events || []).find((e) => (e.competitions?.[0]?.competitors || [])
      .some((c) => c.team?.id === ESPN_BARCA_ID || /barcelona/i.test(c.team?.displayName || '')));
    if (!ev) return null;
    const comp = ev.competitions[0];
    const home = comp.competitors.find((c) => c.homeAway === 'home');
    const away = comp.competitors.find((c) => c.homeAway === 'away');
    const num = (c) => { const s = c?.score; const v = typeof s === 'object' ? (s?.value ?? s?.displayValue) : s; return parseInt(v, 10) || 0; };
    const st = comp.status || ev.status || {};
    let h = num(home), a = num(away);
    const espnBarcaHome = home?.team?.id === ESPN_BARCA_ID || /barcelona/i.test(home?.team?.displayName || '');
    if (espnBarcaHome !== isBarcaHome(f)) [h, a] = [a, h];
    return {
      h, a,
      state: st.type?.state || 'pre',
      completed: !!st.type?.completed,
      clock: st.type?.state === 'in' ? (st.type?.shortDetail || st.displayClock) : st.type?.shortDetail,
      espnId: ev.id,
    };
  }

  async function refreshLive(f) {
    if (!f || Date.now() < kick(f) - 10 * 60e3) return;
    const r = S.results[f.id];
    if (r && r.final) return;
    try {
      const live = await fetchLive(f);
      S.liveOk = true;
      if (!live) return;
      S.live[f.id] = live;
      if (live.state === 'post' && live.completed && GH.token) {
        S.results = await GH.write('data/results.json', (d) => {
          d = d || {};
          if (!d[f.id] || !d[f.id].final) d[f.id] = { h: live.h, a: live.a, final: true, by: 'espn', at: new Date().toISOString(), endedAt: new Date().toISOString() };
          return d;
        }, `Resultado final: ${f.home} ${live.h}-${live.a} ${f.away}`);
      }
    } catch (e) {
      S.liveOk = false;
    }
  }

  // ---------- iconos (SVG, trazo estilo Lucide) ----------
  const ICONS = {
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    crown: '<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7zM5 20h14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13 13 0 0 1-1.67 2.68M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61M2 2l20 20"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    thumbUp: '<path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    swap: '<path d="m17 2 4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  };
  const icon = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;
  const av = (p) => `<span class="av ${p.id}"><img src="${p.img}" alt="${esc(p.name)}" width="200" height="240"></span>`;
  const BARCA_SHIELD = `<svg viewBox="0 0 32 36" aria-label="FC Barcelona"><defs><clipPath id="shc"><path d="M16 1 30 6v12c0 9-6.5 14.5-14 17C8.5 32.5 2 27 2 18V6Z"/></clipPath></defs><g clip-path="url(#shc)"><rect width="32" height="36" fill="#A50044"/><path d="M9 0v36M16 0v36M23 0v36" stroke="#004D98" stroke-width="4"/><rect width="32" height="11" fill="#f2c230"/><path d="M16 0v11" stroke="#c4124f" stroke-width="3"/></g><path d="M16 1 30 6v12c0 9-6.5 14.5-14 17C8.5 32.5 2 27 2 18V6Z" fill="none" stroke="#f2c230" stroke-width="1.4"/></svg>`;

  // ---------- render ----------
  const app = () => $('#app');
  let lastView = '';
  const lastScore = {};

  function render() {
    renderChrome();
    const f = S.me && S.tab === 'partido' ? currentMatch() : null;
    const view = `${S.me}|${S.tab}|${f?.id || ''}|${S.calFilter}`;
    app().classList.toggle('animate', view !== lastView);
    lastView = view;
    if (!S.me) return renderWho();
    if (S.tab === 'stats') return renderStats();
    if (S.tab === 'calendario') return renderCalendar();
    return renderMatch();
  }

  function renderChrome() {
    const chip = $('#me-chip');
    const tabs = $('#tabs');
    chip.hidden = tabs.hidden = !S.me;
    if (S.me) {
      const p = P[S.me];
      chip.innerHTML = `${av(p)}<span class="nm">${esc(p.name)}</span>${icon(GH.token ? 'swap' : 'eye')}`;
      chip.title = GH.token ? 'Cambiar de persona' : 'Modo solo mirar · cambiar de persona';
      chip.setAttribute('aria-label', chip.title);
      tabs.querySelectorAll('button').forEach((b) => {
        const on = b.dataset.tab === S.tab;
        b.classList.toggle('active', on);
        b.setAttribute('aria-current', on ? 'page' : 'false');
      });
    }
  }

  function renderWho() {
    app().innerHTML = `
      <section class="who">
        <p class="kicker reveal">Temporada 2026-27</p>
        <h2 class="reveal" style="--i:1">¿Quién <em>juega</em>?</h2>
        <p class="lead reveal" style="--i:2">Toca tu cara para entrar</p>
        <div class="who-grid">
          ${PLAYERS.map((p, i) => `
            <button class="who-card ${p.id} reveal" style="--i:${i + 3}" data-who="${p.id}">
              ${av(p)}
              <div class="name">${esc(p.name)}</div>
              <div class="go">Entrar</div>
            </button>`).join('')}
        </div>
      </section>`;
  }

  function crest(name) {
    if (name === BARCA) return `<div class="crest">${BARCA_SHIELD}</div>`;
    const ini = name === 'Por determinar' ? '?' : name.replace(/^(FC|CF|RC|CD|UD|SD|RCD|Real)\s+/i, '').slice(0, 3).toUpperCase();
    return `<div class="crest generic">${esc(ini)}</div>`;
  }

  function compClass(c) { return c === 'Copa del Rey' ? 'Copa' : c; }

  function whenText(f) {
    const d = fDay.format(new Date(kick(f)));
    return `${d.charAt(0).toUpperCase() + d.slice(1)} · ${f.timeTbc ? 'hora por confirmar' : hm(kick(f)) + ' h'}`;
  }

  function cdParts(ms) {
    ms = Math.max(0, ms);
    return { d: Math.floor(ms / 86400e3), h: Math.floor(ms / 3600e3) % 24, m: Math.floor(ms / 60e3) % 60, s: Math.floor(ms / 1e3) % 60 };
  }
  function countdownHtml(ms) {
    const c = cdParts(ms);
    const box = (k, v, l) => `<div class="cd"><span class="digit" id="cd-${k}">${String(v).padStart(2, '0')}</span><small>${l}</small></div>`;
    return `<div class="countdown" role="timer" aria-label="Cuenta atrás">${c.d > 0 ? box('d', c.d, c.d === 1 ? 'día' : 'días') : ''}${box('h', c.h, 'horas')}${box('m', c.m, 'min')}${c.d > 0 ? '' : box('s', c.s, 'seg')}</div>`;
  }

  function minuteOf(clock) {
    const m = /(\d+)(?:\+(\d+))?'/.exec(clock || '');
    if (m) return Math.min(90, +m[1]);
    if (/HT|desc|half/i.test(clock || '')) return 45;
    return null;
  }

  function renderMatch() {
    const f = currentMatch();
    if (!f) {
      app().innerHTML = `<div class="card center reveal"><h2>¡Temporada terminada!</h2><p class="muted">No quedan partidos. Mira la clasificación final.</p></div>`;
      return;
    }
    const now = Date.now();
    const started = now >= kick(f);
    const sc = started ? scoreFor(f) : null;
    const live = S.live[f.id];
    const preds = predsFor(f);
    const ranking = sc ? Scoring.rank(preds, sc) : [];
    const winnerId = ranking[0]?.id;
    const final = !!(sc && sc.final);

    let pill;
    if (!started) pill = `<span class="pill open">${icon('lock')} Porra abierta</span>`;
    else if (final) pill = '<span class="pill final">Final</span>';
    else pill = '<span class="pill live"><i></i>En directo</span>';

    // marcador con animación al cambiar
    const prev = lastScore[f.id];
    const bumpH = sc && prev && prev.h !== sc.h ? ' bump' : '';
    const bumpA = sc && prev && prev.a !== sc.a ? ' bump' : '';
    if (sc) lastScore[f.id] = { h: sc.h, a: sc.a };

    let centre;
    if (!started) centre = '<div class="score vs">VS</div>';
    else {
      const clock = final ? 'Final del partido' : (live?.clock || (sc ? 'En juego' : 'Esperando marcador'));
      centre = `<div class="score" aria-live="polite">${sc ? `<span class="g${bumpH}">${sc.h}</span><span class="sep">-</span><span class="g${bumpA}">${sc.a}</span>` : '<span class="g">–</span><span class="sep">:</span><span class="g">–</span>'}</div>
        <div class="sb-clock">${esc(clock)}</div>`;
    }
    const minute = started && !final ? minuteOf(live?.clock) : null;

    const notices = [];
    if (!C.encryptedToken) notices.push(`<div class="notice warn reveal">${icon('sliders')}<div>La web aún no está configurada para guardar porras. Ver <a href="setup.html">setup</a>.</div></div>`);
    else if (!GH.token) notices.push(`<div class="notice reveal">${icon('eye')}<div>Estás en modo solo mirar. <button class="linkbtn" data-act="unlock">Entrar con la contraseña familiar</button></div></div>`);
    if (rival(f) === 'Por determinar') notices.push(`<div class="notice reveal">${icon('help')}<div>El rival todavía no se conoce. Cuando se sepa, cualquiera puede ponerlo en «Editar partido».</div></div>`);
    if (f.timeTbc) notices.push(`<div class="notice reveal">${icon('clock')}<div>La hora aún no es oficial: se muestra a las 21:00 de forma provisional y se actualiza sola.</div></div>`);

    const porraCards = PLAYERS.map((p, i) => {
      const pr = preds[p.id];
      const mine = p.id === S.me;
      let val, st;
      const digits = (x) => `<span class="pred"><b>${x.h}</b><span class="sep">-</span><b>${x.a}</b></span>`;
      if (!started) {
        if (mine && pr) { val = digits(pr); st = `<div class="pstate ok">${icon('check')} Tu porra</div>`; }
        else if (pr) { val = `<span class="pred hidden" aria-label="Oculta">${icon('eyeOff')}</span>`; st = `<div class="pstate ok">${icon('check')} Hecha</div>`; }
        else { val = '<span class="pred none">—</span>'; st = `<div class="pstate">${icon('clock')} ${mine ? 'Te falta' : 'Pendiente'}</div>`; }
      } else if (pr) {
        val = digits(pr);
        if (sc) {
          const ev = Scoring.evaluate(pr, sc);
          const goles = `${ev.dist} gol${ev.dist === 1 ? '' : 'es'}`;
          st = ev.exact ? `<div class="pstate exact">${icon('target')} ¡Exacto!</div>`
            : ev.sign ? `<div class="pstate ok">${icon('thumbUp')} Signo · a ${goles}</div>`
            : `<div class="pstate bad">${icon('x')} A ${goles}</div>`;
        } else st = '<div class="pstate">&nbsp;</div>';
      } else { val = '<span class="pred none">—</span>'; st = '<div class="pstate">Sin porra</div>'; }
      const win = started && sc && winnerId === p.id;
      return `<div class="porra ${p.id} ${mine ? 'me' : ''} ${win ? 'winner' : ''} reveal" style="--i:${i + 2}">
        ${win ? `<div class="crown" title="${final ? 'Ganador' : 'Va ganando'}">${icon('crown')}</div>` : ''}
        ${av(p)}
        <div class="pname">${esc(p.name)}${mine ? ' <span class="muted small">(tú)</span>' : ''}</div>
        ${val}${st}
      </div>`;
    }).join('');

    let verdict = '';
    if (started && sc && ranking.length) {
      const w = P[winnerId];
      verdict = `<div class="verdict ${final ? '' : 'provisional'} reveal" style="--i:5">
        ${av(w)}
        <div><div class="vk">${final ? 'Ganador de la porra' : 'Ahora mismo ganaría'}</div>
        <div class="vt">${esc(w.name)}</div>
        <div class="vr">${esc(ranking[0].reason)}</div></div></div>`;
    } else if (started) {
      verdict = `<div class="verdict provisional empty reveal" style="--i:5"><div><div class="vk">Sin porras</div><div class="vt">Nadie apostó</div></div></div>`;
    }

    let form = '';
    if (!started && GH.token) {
      const mine = preds[S.me];
      if (!S.draft || S.draft.id !== f.id) S.draft = { id: f.id, h: mine?.h ?? (isBarcaHome(f) ? 2 : 0), a: mine?.a ?? (isBarcaHome(f) ? 0 : 2) };
      form = `<div class="my-porra reveal" style="--i:5">
        <h3>${mine ? 'Cambia tu porra' : 'Haz tu porra'}</h3>
        <div class="steppers">
          ${stepper('h', f.home, S.draft.h)}<div class="dash">-</div>${stepper('a', f.away, S.draft.a)}
        </div>
        <button class="btn block" data-act="save-porra">${icon('save')} ${mine ? 'Guardar cambios' : 'Guardar mi porra'}</button>
        <p class="hint">${icon('lock')}<span>Puedes cambiarla hasta el pitido inicial. Las de los demás se descubren cuando empieza el partido.</span></p>
      </div>`;
    }

    const acts = [];
    if (GH.token && started) acts.push(`<button class="btn ghost small" data-act="edit-result">${icon('pencil')} Poner resultado</button>`);
    if (GH.token) acts.push(`<button class="btn ghost small" data-act="edit-match" data-id="${f.id}">${icon('sliders')} Editar partido</button>`);

    app().innerHTML = `
      ${notices.join('')}
      <article class="scoreboard reveal" style="--i:1">
        <div class="sb-top">
          <span class="comp-chip cc-${compClass(f.competition)}"><span class="comp-dot"></span>${esc(f.competition)} · ${esc(f.round)}</span>
          ${pill}
        </div>
        <div class="sb-teams">
          <div class="team">${crest(f.home)}<div class="tname">${esc(f.home)}</div></div>
          <div>${centre}</div>
          <div class="team">${crest(f.away)}<div class="tname">${esc(f.away)}</div></div>
        </div>
        ${minute != null ? `<div class="minute-bar" aria-hidden="true"><span style="transform:scaleX(${(minute / 90).toFixed(3)})"></span></div>` : ''}
        <div class="sb-meta">${icon('calendar')}<span>${esc(whenText(f))}</span></div>
        ${!started ? countdownHtml(kick(f) - now) : ''}
      </article>

      <div class="eyebrow reveal" style="--i:2">${icon('target')} Las porras</div>
      <div class="porras">${porraCards}</div>
      ${verdict}
      ${form}
      ${started && S.liveOk === false && !final ? '<p class="footnote">No se pudo leer el marcador en directo. Podéis ponerlo a mano.</p>' : ''}
      ${started ? '<p class="footnote">Este partido se queda en pantalla hasta 4 horas después del final.</p>' : ''}
      ${acts.length ? `<div class="actions">${acts.join('')}</div>` : ''}
      ${nextUp(f)}`;

    if (final && winnerId) celebrate(f.id);
  }

  function stepper(side, team, val) {
    return `<div class="stepper"><div class="lbl">${esc(team)}</div>
      <div class="ctl"><button data-step="${side}" data-d="-1" aria-label="Un gol menos para ${esc(team)}">${icon('minus')}</button>
      <span class="num" id="num-${side}" aria-live="polite">${val}</span>
      <button data-step="${side}" data-d="1" aria-label="Un gol más para ${esc(team)}">${icon('plus')}</button></div></div>`;
  }

  function nextUp(cur) {
    const i = S.fixtures.indexOf(cur);
    const next = S.fixtures.slice(i + 1).filter((f) => !f.cancelled).slice(0, 3);
    if (!next.length) return '';
    return `<div class="eyebrow reveal" style="--i:6">${icon('calendar')} Próximos</div>${next.map((f, k) => fxRow(f, k + 7)).join('')}`;
  }

  // ---------- confeti para el ganador (una vez por partido y dispositivo) ----------
  function celebrate(id) {
    const key = `porra.party.${id}`;
    if (LS.get(key) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    LS.set(key, '1');
    const cv = $('#confetti');
    const ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    ctx.scale(dpr, dpr);
    const colors = ['#004D98', '#A50044', '#f2c230', '#ffffff', '#4d8dff', '#ff4f8b'];
    const parts = Array.from({ length: 140 }, () => ({
      x: innerWidth / 2 + (Math.random() - .5) * 120, y: innerHeight * .35,
      vx: (Math.random() - .5) * 14, vy: -Math.random() * 14 - 4,
      w: 6 + Math.random() * 6, h: 8 + Math.random() * 10, r: Math.random() * 6, vr: (Math.random() - .5) * .3,
      c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const t0 = performance.now();
    (function frame(t) {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.vy += .35; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2))); ctx.restore();
      }
      if (t - t0 < 3200) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
    })(t0);
  }

  // ---------- estadísticas ----------
  function computeStats() {
    const st = Object.fromEntries(PLAYERS.map((p) => [p.id, { wins: 0, exact: 0, sign: 0, played: 0, goals: 0 }]));
    const history = [];
    for (const f of S.fixtures) {
      const r = S.results[f.id];
      if (!r || !r.final) continue;
      const preds = predsFor(f);
      const ranking = Scoring.rank(preds, r);
      if (!ranking.length) continue;
      for (const row of ranking) {
        const s = st[row.id];
        s.played++; s.goals += row.ev.dist;
        if (row.ev.exact) s.exact++;
        if (row.ev.sign) s.sign++;
      }
      st[ranking[0].id].wins++;
      history.push({ f, r, preds, ranking });
    }
    return { st, history: history.reverse() };
  }

  function renderStats() {
    const { st, history } = computeStats();
    const order = PLAYERS.slice().sort((a, b) => (st[b.id].wins - st[a.id].wins) || (st[b.id].exact - st[a.id].exact) || (st[b.id].sign - st[a.id].sign) || (st[a.id].goals - st[b.id].goals));
    const podiumOrder = [order[1], order[0], order[2]];
    const place = { [order[0].id]: 1, [order[1].id]: 2, [order[2].id]: 3 };
    const maxWins = Math.max(1, ...PLAYERS.map((p) => st[p.id].wins));
    app().innerHTML = `
      <div class="card reveal">
        <h2>Clasificación</h2>
        ${history.length ? '' : '<p class="muted small">Todavía no hay partidos terminados con porras. ¡El primero que gane se pone líder!</p>'}
        <div class="podium">
          ${podiumOrder.map((p, i) => `<div class="pod p${place[p.id]}" style="--i:${i}">
            ${av(p)}<div class="pn">${esc(p.name)}</div>
            <div class="bar"><div class="place">${place[p.id]}º</div><div class="wins">${st[p.id].wins}</div><div class="wl">victoria${st[p.id].wins === 1 ? '' : 's'}</div></div></div>`).join('')}
        </div>
      </div>

      <div class="eyebrow reveal" style="--i:1">${icon('target')} Los números</div>
      <div class="card reveal" style="--i:2">
        <div class="statrows">
          ${order.map((p) => {
            const s = st[p.id];
            return `<div class="statrow" style="--pc:var(--c-${p.id})">${av(p)}<div>
              <div class="top-line">${esc(p.name)}<span>${s.wins} de ${history.length} partidos</span></div>
              <div class="meter" role="img" aria-label="${s.wins} victorias"><i style="width:${(s.wins / maxWins) * 100}%"></i></div>
              <div class="kpis"><div class="kpi"><b>${s.exact}</b><small>Exactos</small></div><div class="kpi"><b>${s.sign}</b><small>Signos</small></div><div class="kpi"><b>${s.played}</b><small>Porras</small></div></div>
            </div></div>`;
          }).join('')}
        </div>
      </div>

      <div class="eyebrow reveal" style="--i:3">${icon('trophy')} Partidos anteriores</div>
      ${history.length ? `<ul class="hist">${history.map((h, i) => histRow(h, i + 4)).join('')}</ul>` : '<div class="card reveal" style="--i:4"><p class="muted small" style="margin:0">Aquí irá apareciendo quién ganó cada partido.</p></div>'}
      ${rulesCard()}`;
  }

  function histRow({ f, r, preds, ranking }, i) {
    const w = ranking[0].id;
    return `<li class="reveal" style="--i:${Math.min(i, 7)}">
      <div class="hm"><span>${esc(f.home)} - ${esc(f.away)}</span><span class="res">${r.h}-${r.a}</span></div>
      <div class="hd">${esc(fShort.format(new Date(kick(f))))} · ${esc(f.competition)} · ${esc(f.round)}</div>
      <div class="hw">${icon('crown')} Ganó ${esc(P[w].name)}: ${esc(ranking[0].reason.charAt(0).toLowerCase() + ranking[0].reason.slice(1))}</div>
      <div class="hp">${PLAYERS.map((p) => preds[p.id]
        ? `<span class="chip ${p.id === w ? 'win' : ''}" style="--pc:var(--c-${p.id})">${av(p)}${esc(p.name)} ${preds[p.id].h}-${preds[p.id].a}${p.id === w ? ' ' + icon('crown') : ''}</span>`
        : `<span class="chip" style="--pc:var(--c-${p.id})">${av(p)}${esc(p.name)} —</span>`).join('')}</div>
    </li>`;
  }

  function rulesCard() {
    return `<details class="card rules reveal" style="--i:5"><summary>${icon('help')} ¿Cómo se decide el ganador? ${icon('chevron').replace('<svg', '<svg class="chev"')}</summary>
      <div class="body"><p class="muted" style="margin:0">Siempre gana alguien: el que más se aproxime. Por orden:</p>
      <ol>
        <li>Quien acierte el <b>resultado exacto</b>.</li>
        <li>Quien acierte el <b>signo</b> (gana el Barça, empate o pierde).</li>
        <li>Quien se quede a <b>menos goles</b> sumando los dos equipos.</li>
        <li>Quien acierte mejor la <b>diferencia de goles</b>.</li>
        <li>Si aún hay empate, quien guardó su porra <b>antes</b>.</li>
      </ol></div></details>`;
  }

  // ---------- calendario ----------
  const FILTERS = [['all', 'Todo'], ['LaLiga', 'LaLiga'], ['Champions', 'Champions'], ['Copa del Rey', 'Copa'], ['Supercopa', 'Supercopa']];

  function fxRow(f, i = 0) {
    const r = S.results[f.id];
    const cur = currentMatch();
    const isCur = cur && cur.id === f.id;
    let right = '';
    if (r && r.final) {
      const rk = Scoring.rank(predsFor(f), r);
      const w = rk.length ? P[rk[0].id] : null;
      right = `<span class="res">${r.h}-${r.a}</span>${w ? `<span title="Ganó ${esc(w.name)}" style="--pc:var(--c-${w.id})">${av(w)}</span>` : ''}`;
    } else if (f.cancelled) right = '<span class="time">No se juega</span>';
    else right = `<span class="time">${f.timeTbc ? '--:--' : hm(kick(f))}</span>`;
    const edit = GH.token ? `<button class="edit" data-act="edit-match" data-id="${f.id}" aria-label="Editar ${esc(f.home)} - ${esc(f.away)}">${icon('pencil')}</button>` : '';
    const team = (n) => (n === BARCA ? `<span class="us">${esc(n)}</span>` : esc(n));
    return `<div class="fx cc-${compClass(f.competition)} ${r && r.final ? 'past' : ''} ${isCur ? 'current' : ''} ${f.cancelled ? 'cancelled' : ''}${i < 8 ? ' reveal' : ''}" style="--i:${i}">
      <div class="fd"><div class="d">${fDayNum.format(new Date(kick(f)))}</div><div class="w">${esc(fWeekShort.format(new Date(kick(f))).replace('.', ''))}</div></div>
      <div class="fm"><div class="ft">${team(f.home)} - ${team(f.away)}</div>
        <div class="fs">${isCur ? '<span class="tag now">Ahora</span>' : ''}<span>${esc(f.competition)} · ${esc(f.round)}</span>${f.tentative ? '<span class="tag">Fecha aprox.</span>' : ''}</div></div>
      <div class="fr">${right}${edit}</div>
    </div>`;
  }

  function renderCalendar() {
    const filt = S.calFilter || 'all';
    let html = `<div class="filters" role="tablist" aria-label="Competición">${FILTERS.map(([k, l]) => `<button role="tab" aria-selected="${k === filt}" class="${k === filt ? 'on' : ''}" data-filter="${k}">${k === 'all' ? '' : `<span class="comp-dot cc-${compClass(k)}"></span>`}${l}</button>`).join('')}</div>`;
    let month = '', n = 0;
    for (const f of S.fixtures) {
      if (filt !== 'all' && f.competition !== filt) continue;
      const m = fMonth.format(new Date(kick(f)));
      if (m !== month) { if (month) html += '</div>'; html += `<div class="month"><h3>${esc(m.charAt(0).toUpperCase() + m.slice(1))}</h3>`; month = m; }
      html += fxRow(f, n++);
    }
    if (month) html += '</div>';
    else html += '<div class="card"><p class="muted" style="margin:0">No hay partidos de esta competición.</p></div>';
    html += `<p class="footnote">Las horas de LaLiga se fijan unas semanas antes y se actualizan solas.</p>`;
    app().innerHTML = html;
    const cur = $('.fx.current');
    if (cur && app().classList.contains('animate')) cur.scrollIntoView({ block: 'center' });
  }

  // ---------- diálogos ----------
  const dlg = () => $('#dlg');
  function openDialog(html, onSubmit) {
    const d = dlg();
    d.innerHTML = `<form class="dlg" method="dialog">${html}<p class="err" id="dlg-err"></p></form>`;
    const form = $('form', d);
    form.addEventListener('submit', async (e) => {
      const btn = e.submitter;
      if (btn && btn.value === 'cancel') return;
      e.preventDefault();
      const err = $('#dlg-err', d);
      err.textContent = '';
      form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        await onSubmit(new FormData(form), btn?.value);
        d.close();
      } catch (ex) {
        err.textContent = ex.message || String(ex);
      } finally {
        form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      }
    });
    d.showModal();
  }

  function unlockDialog() {
    if (!C.encryptedToken) { toast('La web aún no tiene contraseña configurada'); return; }
    openDialog(`
      <h2>Contraseña familiar</h2>
      <p class="small">Solo hace falta ponerla una vez en cada móvil u ordenador.</p>
      <label class="field">Contraseña<input type="password" name="pass" autocomplete="current-password" required autofocus></label>
      <div class="btns"><button class="btn blue small" value="ok">Entrar</button><button class="btn ghost small" value="cancel" formnovalidate>Solo mirar</button></div>`,
    async (fd) => {
      if (!window.crypto?.subtle) throw new Error('Este navegador no permite descifrar la clave (hace falta abrir la web con https://).');
      let tok;
      try { tok = await decryptToken(C.encryptedToken, fd.get('pass')); } catch { throw new Error('Contraseña incorrecta'); }
      GH.token = tok;
      LS.set('porra.token', tok);
      await loadAll();
      const f = currentMatch();
      if (f && Date.now() >= kick(f)) await refreshLive(f);
      toast('¡Dentro! Ya puedes hacer tu porra');
      render();
    });
  }

  function resultDialog(f) {
    const sc = scoreFor(f) || { h: 0, a: 0 };
    openDialog(`
      <h2>Resultado</h2>
      <div class="row">
        <label class="field">${esc(f.home)}<input type="number" name="h" min="0" max="30" value="${sc.h}" required inputmode="numeric"></label>
        <label class="field">${esc(f.away)}<input type="number" name="a" min="0" max="30" value="${sc.a}" required inputmode="numeric"></label>
      </div>
      <label class="check"><input type="checkbox" name="final" ${sc.final || Date.now() > kick(f) + MATCH_MS ? 'checked' : ''}> El partido ha terminado</label>
      <div class="btns">
        <button class="btn small" value="ok">Guardar</button>
        <button class="btn ghost small" value="cancel" formnovalidate>Cancelar</button>
        ${S.results[f.id] ? '<button class="btn ghost small" value="clear">Borrar</button>' : ''}</div>`,
    async (fd, action) => {
      const h = parseInt(fd.get('h'), 10), a = parseInt(fd.get('a'), 10), fin = !!fd.get('final');
      if (action !== 'clear' && (!(h >= 0) || !(a >= 0))) throw new Error('Pon un número válido');
      S.results = await GH.write('data/results.json', (d) => {
        d = d || {};
        if (action === 'clear') delete d[f.id];
        else d[f.id] = { h, a, final: fin, by: S.me, at: new Date().toISOString(), ...(fin ? { endedAt: d[f.id]?.endedAt || new Date().toISOString() } : {}) };
        return d;
      }, action === 'clear' ? `Borrar resultado ${f.id}` : `Resultado (${P[S.me].name}): ${f.home} ${h}-${a} ${f.away}`);
      toast('Resultado guardado');
      render();
    });
  }

  function matchDialog(f) {
    const date = ymd(kick(f));
    const time = hm(kick(f));
    openDialog(`
      <h2>Editar partido</h2>
      <p class="small muted">${esc(f.competition)} · ${esc(f.round)}</p>
      <label class="field">Local<input type="text" name="home" value="${esc(f.home)}" required></label>
      <label class="field">Visitante<input type="text" name="away" value="${esc(f.away)}" required></label>
      <div class="row">
        <label class="field">Día<input type="date" name="date" value="${date}" required></label>
        <label class="field">Hora (España)<input type="time" name="time" value="${time}" required></label>
      </div>
      <label class="check"><input type="checkbox" name="tbc" ${f.timeTbc ? 'checked' : ''}> La hora aún no es oficial</label>
      <label class="check"><input type="checkbox" name="cancelled" ${f.cancelled ? 'checked' : ''}> Este partido no se juega (eliminados, aplazado…)</label>
      <div class="btns"><button class="btn small" value="ok">Guardar</button><button class="btn ghost small" value="cancel" formnovalidate>Cancelar</button></div>`,
    async (fd) => {
      const upd = {
        home: fd.get('home').trim(), away: fd.get('away').trim(),
        kickoff: madridToISO(fd.get('date'), fd.get('time')),
        timeTbc: !!fd.get('tbc'), cancelled: !!fd.get('cancelled'), manual: true,
      };
      const list = await GH.write('data/fixtures.json', (d) => (d || []).map((x) => {
        if (x.id !== f.id) return x;
        const n = { ...x, ...upd };
        if (!n.timeTbc) delete n.timeTbc;
        if (!n.cancelled) delete n.cancelled;
        if (upd.home !== 'Por determinar' && upd.away !== 'Por determinar') delete n.tentative;
        return n;
      }), `Editar partido ${f.id} (${P[S.me].name})`);
      S.fixtures = list.slice().sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
      toast('Partido actualizado');
      render();
    });
  }

  async function savePorra() {
    const f = currentMatch();
    if (!f || !S.draft || S.draft.id !== f.id) return;
    if (Date.now() >= kick(f)) { toast('¡Demasiado tarde! El partido ya ha empezado'); render(); return; }
    const { h, a } = S.draft;
    const btn = $('[data-act="save-porra"]');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Guardando…';
    try {
      S.porras[S.me] = await GH.write(`data/porras/${S.me}.json`, (d) => {
        d = d || {};
        d[f.id] = { h, a, at: new Date().toISOString() };
        return d;
      }, `Porra de ${P[S.me].name}: ${f.home} ${h}-${a} ${f.away}`);
      toast(`¡Porra guardada! ${f.home} ${h} - ${a} ${f.away}`);
    } catch (e) {
      toast(e.message, 4000);
    }
    render();
  }

  // ---------- eventos ----------
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.who) {
      S.me = t.dataset.who;
      LS.set('porra.me', S.me);
      render();
      if (!GH.token && C.encryptedToken) unlockDialog();
      return;
    }
    if (t.id === 'me-chip') { S.me = null; LS.set('porra.me', null); render(); return; }
    if (t.dataset.tab) { S.tab = t.dataset.tab; window.scrollTo(0, 0); render(); return; }
    if (t.dataset.step) {
      const side = t.dataset.step;
      S.draft[side] = Math.max(0, Math.min(20, S.draft[side] + Number(t.dataset.d)));
      const el = $(`#num-${side}`);
      el.textContent = S.draft[side];
      el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
      return;
    }
    if (t.dataset.filter) { S.calFilter = t.dataset.filter; window.scrollTo(0, 0); render(); return; }
    const act = t.dataset.act;
    if (act === 'unlock') unlockDialog();
    else if (act === 'save-porra') savePorra();
    else if (act === 'edit-result') { const f = currentMatch(); if (f) resultDialog(f); }
    else if (act === 'edit-match') { const f = S.fixtures.find((x) => x.id === t.dataset.id); if (f) matchDialog(f); }
  });

  // ---------- bucles ----------
  let lastCurId = null, lastStarted = null;
  function tick() {
    const f = currentMatch();
    const started = f ? Date.now() >= kick(f) : null;
    if (S.me && S.tab === 'partido' && !dlg().open && (f?.id !== lastCurId || started !== lastStarted)) {
      lastCurId = f?.id; lastStarted = started;
      render();
      if (started) refreshLive(f).then(() => { if (S.tab === 'partido' && !dlg().open) render(); });
      return;
    }
    if (f && $('#cd-m')) {
      const c = cdParts(kick(f) - Date.now());
      for (const k of ['d', 'h', 'm', 's']) { const el = $(`#cd-${k}`); if (el) el.textContent = String(c[k]).padStart(2, '0'); }
    }
  }

  async function poll() {
    try {
      const f = currentMatch();
      // Recarga datos de los demás (porras/resultados); no pisa la porra que estás editando
      await loadAll();
      if (f && Date.now() >= kick(f) - 10 * 60e3) await refreshLive(f);
      if (S.me && !dlg().open && !(S.tab === 'partido' && document.activeElement?.closest?.('.my-porra'))) render();
    } catch (e) { console.warn(e); }
  }

  async function init() {
    try {
      await loadAll();
    } catch (e) {
      app().innerHTML = `<div class="card"><h2>Ups</h2><p class="muted">No se pudieron cargar los datos: ${esc(e.message)}</p></div>`;
      if (!GH.token) return;
      GH.token = null; LS.set('porra.token', null);
      await loadAll().catch(() => {});
    }
    const f = currentMatch();
    if (f && Date.now() >= kick(f) - 10 * 60e3) await refreshLive(f);
    lastCurId = f?.id; lastStarted = f ? Date.now() >= kick(f) : null;
    render();
    if (S.me && !GH.token && C.encryptedToken) unlockDialog();
    setInterval(tick, 1000);
    setInterval(poll, 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  }

  init();
})();
