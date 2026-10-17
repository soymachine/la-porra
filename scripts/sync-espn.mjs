// Sincroniza horarios, rivales y resultados del Barça desde la API pública de ESPN.
// Lo ejecuta la GitHub Action .github/workflows/sync.yml. Nunca pisa datos editados a mano.
import { readFile, writeFile } from 'node:fs/promises';

const LEAGUES = {
  'esp.1': 'LaLiga',
  'uefa.champions': 'Champions',
  'esp.copa_del_rey': 'Copa del Rey',
  'esp.super_cup': 'Supercopa',
};
const BARCA_ID = '83';
const BARCA = 'FC Barcelona';
const DAY = 86400e3;

const read = async (p) => JSON.parse(await readFile(p, 'utf8'));
const write = (p, d) => writeFile(p, JSON.stringify(d, null, 1) + '\n');

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'la-porra-sync' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function parseEvent(ev, competition) {
  const comp = ev.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors?.find((c) => c.homeAway === 'home');
  const away = comp.competitors?.find((c) => c.homeAway === 'away');
  if (!home || !away) return null;
  const isBarca = (c) => c.team?.id === BARCA_ID;
  if (!isBarca(home) && !isBarca(away)) return null;
  const score = (c) => {
    const s = c.score;
    const v = s && typeof s === 'object' ? (s.value ?? s.displayValue) : s;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  const st = comp.status?.type || ev.status?.type || {};
  return {
    espnId: ev.id,
    competition,
    kickoff: new Date(ev.date || comp.date).toISOString(),
    timeValid: comp.timeValid !== false && ev.timeValid !== false,
    home: isBarca(home) ? BARCA : home.team?.displayName,
    away: isBarca(away) ? BARCA : away.team?.displayName,
    h: score(home), a: score(away),
    completed: !!st.completed && st.state === 'post',
    cancelled: /postponed|canceled|cancelled/i.test(st.name || ''),
  };
}

async function espnEvents() {
  const out = new Map();
  for (const [lg, competition] of Object.entries(LEAGUES)) {
    for (const q of ['', '?fixture=true']) {
      try {
        const j = await getJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/teams/${BARCA_ID}/schedule${q}`);
        for (const ev of j.events || []) {
          const e = parseEvent(ev, competition);
          if (e) out.set(e.espnId, e);
        }
      } catch (err) {
        console.warn('Aviso:', err.message);
      }
    }
  }
  return [...out.values()];
}

const placeholder = (name) => !name || name === 'Por determinar';

async function main() {
  const fixtures = await read('data/fixtures.json');
  const results = await read('data/results.json');
  const events = await espnEvents();
  console.log(`ESPN: ${events.length} partidos del Barça`);
  if (!events.length) return;

  let changed = false;
  const used = new Set(fixtures.map((f) => f.espnId).filter(Boolean));

  for (const e of events) {
    let f = fixtures.find((x) => x.espnId === e.espnId);
    if (!f) {
      // Emparejar por competición y fecha cercana (el Barça no repite competición en ±3 días)
      const cands = fixtures
        .filter((x) => !x.espnId && x.competition === e.competition)
        .map((x) => ({ x, d: Math.abs(Date.parse(x.kickoff) - Date.parse(e.kickoff)) }))
        .filter(({ d }) => d <= 3.5 * DAY)
        .sort((p, q) => p.d - q.d);
      f = cands[0]?.x;
      if (f) { f.espnId = e.espnId; used.add(e.espnId); changed = true; }
    }
    if (!f) {
      if (e.completed && Date.parse(e.kickoff) < Date.now() - 30 * DAY) continue;
      f = { id: `espn-${e.espnId}`, competition: e.competition, round: e.competition === 'LaLiga' ? 'Liga' : 'Eliminatoria', home: e.home, away: e.away, kickoff: e.kickoff, espnId: e.espnId };
      if (!e.timeValid) f.timeTbc = true;
      fixtures.push(f);
      changed = true;
      console.log('Nuevo partido:', f.id, f.home, '-', f.away);
      continue;
    }
    if (f.manual) {
      // Editado a mano: solo rellenamos rivales desconocidos
      for (const side of ['home', 'away']) {
        if (placeholder(f[side]) && !placeholder(e[side])) { f[side] = e[side]; changed = true; }
      }
    } else {
      if (e.timeValid && (f.kickoff !== e.kickoff || f.timeTbc)) {
        if (Date.parse(f.kickoff) !== Date.parse(e.kickoff)) console.log('Horario:', f.id, f.kickoff, '->', e.kickoff);
        if (Date.parse(f.kickoff) !== Date.parse(e.kickoff)) { f.kickoff = e.kickoff; changed = true; }
        if (f.timeTbc) { delete f.timeTbc; changed = true; }
        if (f.tentative) { delete f.tentative; changed = true; }
      } else if (!e.timeValid && Math.abs(Date.parse(f.kickoff) - Date.parse(e.kickoff)) > DAY) {
        // Fecha movida pero sin hora: dejamos las 21:00 provisionales en el nuevo día
        const d = new Date(e.kickoff);
        d.setUTCHours(19, 0, 0, 0);
        f.kickoff = d.toISOString(); f.timeTbc = true; changed = true;
      }
      for (const side of ['home', 'away']) {
        if (placeholder(f[side]) && !placeholder(e[side])) { f[side] = e[side]; changed = true; }
      }
    }
    const r = results[f.id];
    if (e.completed && e.h != null && e.a != null && !(r && r.final)) {
      const now = new Date().toISOString();
      results[f.id] = { h: e.h, a: e.a, final: true, by: 'espn', at: now, endedAt: new Date(Math.min(Date.now(), Date.parse(e.kickoff) + 2 * 3600e3)).toISOString() };
      console.log('Resultado:', f.id, e.h, '-', e.a);
      changed = true;
    }
  }

  if (changed) {
    fixtures.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
    await write('data/fixtures.json', fixtures);
    await write('data/results.json', results);
  }
  console.log(changed ? 'Datos actualizados' : 'Sin cambios');
}

main().catch((e) => { console.error(e); process.exit(1); });
