// Cálculo del ganador de cada porra. Siempre hay un ganador si hay al menos una porra.
// Criterios, por orden:
//   1. Acertar el resultado exacto.
//   2. Acertar el signo (gana local / empate / gana visitante).
//   3. Menor diferencia total de goles (|local| + |visitante|).
//   4. Diferencia de goles más parecida.
//   5. Quien hizo la porra antes.
(function (root) {
  const sign = (h, a) => Math.sign(h - a);

  function evaluate(pred, res) {
    return {
      exact: pred.h === res.h && pred.a === res.a,
      sign: sign(pred.h, pred.a) === sign(res.h, res.a),
      dist: Math.abs(pred.h - res.h) + Math.abs(pred.a - res.a),
      gd: Math.abs((pred.h - pred.a) - (res.h - res.a)),
      at: pred.at ? Date.parse(pred.at) : Infinity,
    };
  }

  function compare(x, y) {
    return (y.exact - x.exact) || (y.sign - x.sign) || (x.dist - y.dist) || (x.gd - y.gd) || (x.at - y.at);
  }

  // preds: { playerId: {h, a, at} }, res: {h, a}
  // Devuelve la clasificación ordenada [{id, pred, ev, reason}] (la primera es la ganadora).
  function rank(preds, res) {
    const rows = Object.entries(preds || {})
      .filter(([, p]) => p && Number.isInteger(p.h) && Number.isInteger(p.a))
      .map(([id, p]) => ({ id, pred: p, ev: evaluate(p, res) }));
    rows.sort((r1, r2) => compare(r1.ev, r2.ev));
    if (rows.length) rows[0].reason = reason(rows);
    return rows;
  }

  function reason(rows) {
    const [w, second] = rows;
    if (w.ev.exact) return 'Clavó el resultado exacto';
    if (!second) return 'Fue el único que hizo porra';
    const d = w.ev.dist === 1 ? '1 gol' : `${w.ev.dist} goles`;
    const why = w.ev.sign ? `Acertó el signo y se quedó a ${d}` : `Fue el que más se acercó (a ${d})`;
    if (compare(w.ev, second.ev) === 0) return why;
    const tie = second.ev.exact === w.ev.exact && second.ev.sign === w.ev.sign && second.ev.dist === w.ev.dist;
    if (tie && second.ev.gd === w.ev.gd) return `${why}. Desempate: hizo la porra antes`;
    if (tie) return `${why}. Desempate: diferencia de goles más parecida`;
    return why;
  }

  const api = { rank, evaluate };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Scoring = api;
})(this);
