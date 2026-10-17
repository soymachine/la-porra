/* La Porra Blaugrana — app principal (sin dependencias). */
(function () {
  'use strict';

  const C = window.PORRA_CONFIG;
  const PLAYERS = [
    { id: 'rodolfo', name: 'Rodolfo', age: 86, img: 'img/rodolfo.svg' },
    { id: 'eric', name: 'Eric', age: 48, img: 'img/eric.svg' },
    { id: 'dani', name: 'Dani', age: 47, img: 'img/dani.svg' },
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

  // ---------- render ----------
  const app = () => $('#app');

  function render() {
    renderChrome();
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
      chip.innerHTML = `<img src="${p.img}" alt=""><span>${esc(p.name)}${GH.token ? '' : ' 👀'}</span>`;
      chip.title = 'Cambiar de persona';
      tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
    }
  }

  function renderWho() {
    app().innerHTML = `
      <section class="who">
        <h2>¿Quién eres?</h2>
        <p class="muted">Toca tu cara para entrar</p>
        <div class="who-grid">
          ${PLAYERS.map((p) => `
            <button class="who-card" data-who="${p.id}">
              <img src="${p.img}" alt="${esc(p.name)}">
              <div class="name">${esc(p.name)}</div>
              <div class="age">${p.age} años</div>
            </button>`).join('')}
        </div>
      </section>`;
  }

  function crest(name) {
    if (name === BARCA) return '<div class="crest fcb">FCB</div>';
    const ini = name === 'Por determinar' ? '?' : name.replace(/^(FC|CF|RC|CD|UD|SD|RCD|Real)\s+/i, '').slice(0, 3).toUpperCase();
    return `<div class="crest">${esc(ini)}</div>`;
  }

  function compClass(c) { return c === 'Copa del Rey' ? 'Copa' : c; }

  function whenText(f) {
    const d = fDay.format(new Date(kick(f)));
    return `${d.charAt(0).toUpperCase() + d.slice(1)} · ${f.timeTbc ? 'hora por confirmar' : hm(kick(f)) + ' h'}`;
  }

  function renderMatch() {
    const f = currentMatch();
    if (!f) {
      app().innerHTML = `<div class="card"><h2>¡Temporada terminada!</h2><p>No quedan partidos. Mira la clasificación final 🏆</p></div>`;
      return;
    }
    const now = Date.now();
    const started = now >= kick(f);
    const sc = started ? scoreFor(f) : null;
    const live = S.live[f.id];
    const preds = predsFor(f);
    const ranking = sc ? Scoring.rank(preds, sc) : [];
    const winnerId = ranking[0]?.id;

    let status = '';
    if (!started) status = '<span class="badge gold">Porra abierta</span>';
    else if (sc && sc.final) status = '<span class="badge">Final</span>';
    else status = '<span class="badge live">● En juego</span>';

    const scoreHtml = started
      ? `<div class="score">${sc ? `${sc.h} - ${sc.a}` : '¿? - ¿?'}</div>
         <div class="clock">${sc && sc.final ? 'Resultado final' : esc(live?.clock || (sc ? 'En directo' : 'Esperando marcador'))}</div>`
      : '<div class="score vs">VS</div>';

    const notices = [];
    if (!C.encryptedToken) notices.push('<div class="notice">⚙️ La web aún no está configurada para guardar porras (falta la contraseña familiar, ver <a href="setup.html">setup</a>).</div>');
    else if (!GH.token) notices.push('<div class="notice info">👀 Estás en modo solo mirar. <button class="linkbtn" data-act="unlock">Entrar con la contraseña familiar</button></div>');
    if (f.rivalTbc || rival(f) === 'Por determinar') notices.push('<div class="notice info">🤷 El rival todavía no se conoce. Cuando se sepa, cualquiera puede ponerlo con «Editar partido».</div>');
    if (f.timeTbc) notices.push('<div class="notice info">🕘 La hora aún no es oficial (se muestra a las 21:00 de forma provisional). Se actualiza sola cuando se anuncia.</div>');

    const porraCards = PLAYERS.map((p) => {
      const pr = preds[p.id];
      const mine = p.id === S.me;
      let val = '', st = '';
      if (!started) {
        if (mine && pr) { val = `${pr.h} - ${pr.a}`; st = '<div class="pstate done">✅ Tu porra</div>'; }
        else if (pr) { val = '🤫'; st = '<div class="pstate done">✅ Ya la ha hecho</div>'; }
        else { val = '—'; st = `<div class="pstate">⏳ ${mine ? 'Te falta' : 'Pendiente'}</div>`; }
      } else if (pr) {
        val = `${pr.h} - ${pr.a}`;
        if (sc) {
          const ev = Scoring.evaluate(pr, sc);
          st = `<div class="pstate">${ev.exact ? '🎯 ¡Exacto!' : ev.sign ? '👍 Signo' : '👎 Fallo'} · a ${ev.dist} gol${ev.dist === 1 ? '' : 'es'}</div>`;
        }
      } else { val = '—'; st = '<div class="pstate">Sin porra</div>'; }
      const win = started && sc && winnerId === p.id;
      return `<div class="porra ${mine ? 'me' : ''} ${win ? 'winner' : ''}">
        ${win ? '<div class="crown">👑</div>' : ''}
        <img src="${p.img}" alt="">
        <div class="pname">${esc(p.name)}</div>
        <div class="pval">${val}</div>${st}
      </div>`;
    }).join('');

    let verdict = '';
    if (started && sc && ranking.length) {
      const w = P[winnerId];
      verdict = `<div class="verdict ${sc.final ? '' : 'provisional'}">
        <img src="${w.img}" alt="">
        <div><div class="vt">${sc.final ? `¡Gana ${esc(w.name)}! 🏆` : `Ahora mismo ganaría ${esc(w.name)}`}</div>
        <div class="vr">${esc(ranking[0].reason)}</div></div></div>`;
    } else if (started && !ranking.length) {
      verdict = '<div class="verdict provisional"><div><div class="vt">Nadie hizo porra 😢</div></div></div>';
    }

    let form = '';
    if (!started && GH.token) {
      const mine = preds[S.me];
      if (!S.draft || S.draft.id !== f.id) S.draft = { id: f.id, h: mine?.h ?? (isBarcaHome(f) ? 2 : 0), a: mine?.a ?? (isBarcaHome(f) ? 0 : 2) };
      form = `<div class="my-porra">
        <h3>${mine ? 'Cambia tu porra' : 'Haz tu porra'}, ${esc(P[S.me].name)}</h3>
        <div class="steppers">
          ${stepper('h', f.home, S.draft.h)}<div class="dash">-</div>${stepper('a', f.away, S.draft.a)}
        </div>
        <button class="btn block" data-act="save-porra">${mine ? 'Guardar cambios' : 'Guardar mi porra'}</button>
        <p class="small muted" style="text-align:center;margin:10px 0 0">Puedes cambiarla hasta el pitido inicial. Las porras de los demás se descubren cuando empieza el partido.</p>
      </div>`;
    }

    const acts = [];
    if (GH.token && started) acts.push('<button class="btn ghost small" data-act="edit-result">✏️ Poner resultado a mano</button>');
    if (GH.token) acts.push(`<button class="btn ghost small" data-act="edit-match" data-id="${f.id}">🛠️ Editar partido</button>`);

    app().innerHTML = `
      ${notices.join('')}
      <article class="card match-card">
        <div class="match-head">
          <span class="badge">${esc(f.competition)} · ${esc(f.round)}</span> ${status}
          <div class="match-meta">${esc(whenText(f))}</div>
          <div class="teams">
            <div class="team">${crest(f.home)}<div class="tname">${esc(f.home)}</div></div>
            <div>${scoreHtml}</div>
            <div class="team">${crest(f.away)}<div class="tname">${esc(f.away)}</div></div>
          </div>
          ${!started ? `<div class="countdown">Empieza en <b id="countdown">${countdown(kick(f) - now)}</b></div>` : ''}
        </div>
        <div class="match-body">
          <div class="porras">${porraCards}</div>
          ${verdict}
          ${form}
          ${started && S.liveOk === false && !(sc && sc.final) ? '<p class="small muted" style="text-align:center">No se pudo leer el marcador en directo. Podéis ponerlo a mano.</p>' : ''}
          ${started ? `<p class="small muted" style="text-align:center">Este partido se queda en pantalla hasta 4 horas después del final; luego aparece el siguiente.</p>` : ''}
          <div class="actions">${acts.join('')}</div>
        </div>
      </article>
      ${nextUp(f)}`;
  }

  function stepper(side, team, val) {
    return `<div class="stepper"><div class="lbl">${esc(team)}</div>
      <div class="ctl"><button data-step="${side}" data-d="-1" aria-label="menos">−</button>
      <span class="num" id="num-${side}">${val}</span>
      <button data-step="${side}" data-d="1" aria-label="más">+</button></div></div>`;
  }

  function countdown(ms) {
    if (ms <= 0) return '¡ya!';
    const d = Math.floor(ms / 86400e3), h = Math.floor(ms / 3600e3) % 24, m = Math.floor(ms / 60e3) % 60, s = Math.floor(ms / 1e3) % 60;
    if (d > 0) return `${d} d ${h} h ${m} min`;
    if (h > 0) return `${h} h ${m} min ${String(s).padStart(2, '0')} s`;
    return `${m} min ${String(s).padStart(2, '0')} s`;
  }

  function nextUp(cur) {
    const i = S.fixtures.indexOf(cur);
    const next = S.fixtures.slice(i + 1).filter((f) => !f.cancelled).slice(0, 3);
    if (!next.length) return '';
    return `<div class="card"><h2>Próximos partidos</h2>${next.map(fxRow).join('')}</div>`;
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
    const cls = { [order[0].id]: 'p1', [order[1].id]: 'p2', [order[2].id]: 'p3' };
    app().innerHTML = `
      <div class="card">
        <h2>Clasificación</h2>
        ${history.length ? '' : '<p class="muted">Todavía no hay partidos terminados con porras. ¡El primero que gane se pone líder!</p>'}
        <div class="podium">
          ${podiumOrder.map((p) => `<div class="pod ${cls[p.id]}"><img src="${p.img}" alt="">
            <div class="bar"><div class="wins">${st[p.id].wins}</div><div class="pn">${esc(p.name)}</div><div class="small">victoria${st[p.id].wins === 1 ? '' : 's'}</div></div></div>`).join('')}
        </div>
      </div>
      <div class="card">
        <h2>Números</h2>
        <table class="stats">
          <thead><tr><th></th><th title="Partidos ganados">🏆</th><th title="Resultados exactos">🎯 Exactos</th><th title="Signo acertado">👍 Signo</th><th title="Porras hechas">Porras</th></tr></thead>
          <tbody>${order.map((p) => `<tr>
            <td><div class="pcell"><img src="${p.img}" alt="">${esc(p.name)}</div></td>
            <td><b>${st[p.id].wins}</b></td><td>${st[p.id].exact}</td><td>${st[p.id].sign}</td><td>${st[p.id].played}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="card">
        <h2>Partidos anteriores</h2>
        ${history.length ? `<ul class="hist">${history.map(histRow).join('')}</ul>` : '<p class="muted">Aquí irá apareciendo quién ganó cada partido.</p>'}
      </div>
      ${rulesCard()}`;
  }

  function histRow({ f, r, preds, ranking }) {
    const w = ranking[0].id;
    return `<li>
      <div class="hm"><span>${esc(f.home)} - ${esc(f.away)}</span><span class="res">${r.h} - ${r.a}</span></div>
      <div class="hd">${esc(fShort.format(new Date(kick(f))))} · ${esc(f.competition)} · ${esc(f.round)} · 🏆 ${esc(P[w].name)}: ${esc(ranking[0].reason.toLowerCase())}</div>
      <div class="hp">${PLAYERS.map((p) => preds[p.id]
        ? `<span class="chip ${p.id === w ? 'win' : ''}"><img src="${p.img}" alt="">${esc(p.name)} ${preds[p.id].h}-${preds[p.id].a}${p.id === w ? ' 👑' : ''}</span>`
        : `<span class="chip"><img src="${p.img}" alt="">${esc(p.name)} —</span>`).join('')}</div>
    </li>`;
  }

  function rulesCard() {
    return `<div class="card"><h2>¿Cómo se decide el ganador?</h2>
      <p class="small">Siempre gana alguien: el que más se aproxime. Por orden:</p>
      <ol class="small">
        <li>Quien acierte el <b>resultado exacto</b>.</li>
        <li>Quien acierte el <b>signo</b> (gana el Barça, empate o pierde).</li>
        <li>Quien se quede a <b>menos goles</b> sumando los dos equipos.</li>
        <li>Quien acierte mejor la <b>diferencia de goles</b>.</li>
        <li>Si aún hay empate, quien guardó su porra <b>antes</b>.</li>
      </ol></div>`;
  }

  // ---------- calendario ----------
  function fxRow(f) {
    const r = S.results[f.id];
    const cur = currentMatch();
    let right = '';
    if (r && r.final) {
      const rk = Scoring.rank(predsFor(f), r);
      right = `${r.h}-${r.a}${rk.length ? ` <img src="${P[rk[0].id].img}" alt="Ganó ${esc(P[rk[0].id].name)}" title="Ganó ${esc(P[rk[0].id].name)}">` : ''}`;
    } else if (f.cancelled) right = '<span class="small">No se juega</span>';
    else right = `<span class="small muted">${f.timeTbc ? 'hora ¿?' : hm(kick(f))}</span>`;
    const edit = GH.token ? ` <button class="linkbtn" data-act="edit-match" data-id="${f.id}" aria-label="Editar">✏️</button>` : '';
    return `<div class="fx ${r && r.final ? 'past' : ''} ${cur && cur.id === f.id ? 'current' : ''} ${f.cancelled ? 'cancelled' : ''}">
      <div class="fd"><div class="d">${fDayNum.format(new Date(kick(f)))}</div><div class="w">${esc(fWeekShort.format(new Date(kick(f))))}</div></div>
      <div class="fm"><div class="ft">${esc(f.home)} - ${esc(f.away)}</div>
        <div class="fs"><span class="comp ${compClass(f.competition)}">${esc(f.competition)}</span>${esc(f.round)}${f.tentative ? ' · fecha aprox.' : ''}${edit}</div></div>
      <div class="fr">${right}</div>
    </div>`;
  }

  function renderCalendar() {
    let html = '<div class="notice info small">Fechas de LaLiga sin hora: se fijan unas semanas antes y la web las actualiza sola. Las eliminatorias tienen el rival «Por determinar» hasta el sorteo.</div>';
    let month = '';
    for (const f of S.fixtures) {
      const m = fMonth.format(new Date(kick(f)));
      if (m !== month) { if (month) html += '</div>'; html += `<div class="month"><h3>${esc(m.charAt(0).toUpperCase() + m.slice(1))}</h3>`; month = m; }
      html += fxRow(f);
    }
    if (month) html += '</div>';
    app().innerHTML = html;
    const cur = $('.fx.current');
    if (cur) cur.scrollIntoView({ block: 'center' });
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
    btn.disabled = true; btn.textContent = 'Guardando…';
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
      $(`#num-${side}`).textContent = S.draft[side];
      return;
    }
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
    const cd = $('#countdown');
    if (cd && f) cd.textContent = countdown(kick(f) - Date.now());
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
      app().innerHTML = `<div class="card"><h2>Ups</h2><p>No se pudieron cargar los datos: ${esc(e.message)}</p></div>`;
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
