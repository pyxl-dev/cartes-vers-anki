/* Format public : { "cards": [{"type":"basic", "front":"...", "back":"..."},
    {"type":"cloze", "text":"La {{c1::métoprolol}} est un ...", "extra":"..."}] } */
(function (root) {
  'use strict';
  const MAX_CARDS = 100;
  function stripFence(text) {
    const s = String(text || '').trim();
    const m = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    return m ? m[1].trim() : s;
  }
  function toCards(input) {
    let value = input;
    if (typeof value === 'string') value = JSON.parse(stripFence(value));
    let items = Array.isArray(value) ? value : (value && (value.cards || value.notes));
    if (!Array.isArray(items)) throw new Error('Format attendu : {"cards":[{"front":"...","back":"..."}]}');
    if (items.length === 0) throw new Error('Aucune carte dans le JSON.');
    if (items.length > MAX_CARDS) throw new Error(`Maximum ${MAX_CARDS} cartes par import. Découpe ta demande en lots.`);
    return items.map((c, i) => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`Carte ${i + 1} invalide.`);
      const rawType = String(c.type || (c.text && /\{\{c\d+::/.test(c.text) ? 'cloze' : 'basic')).toLowerCase();
      const type = rawType === 'cloze' ? 'cloze' : 'basic';
      const out = {type, front: '', back: '', text: '', extra: '', tags: []};
      if (type === 'cloze') {
        out.text = String(c.text || c.front || '').trim();
        out.extra = String(c.extra || c.back || '').trim();
        if (!/\{\{c\d+::[\s\S]+?\}\}/.test(out.text)) {
          throw new Error(`Carte ${i + 1} : cloze sans {{c1::réponse}}.`);
        }
      } else {
        out.front = String(c.front || c.question || '').trim();
        out.back = String(c.back || c.answer || '').trim();
        if (!out.front || !out.back) throw new Error(`Carte ${i + 1} : question ou réponse manquante.`);
      }
      const tags = Array.isArray(c.tags) ? c.tags : [];
      out.tags = tags.filter(x => typeof x === 'string').slice(0, 8);
      for (const k of ['front','back','text','extra']) if (out[k].length > 8000) throw new Error(`Carte ${i + 1} : contenu trop long.`);
      return out;
    });
  }
  root.AnkiCards = Object.freeze({toCards, stripFence, MAX_CARDS});
})(typeof globalThis !== 'undefined' ? globalThis : this);
