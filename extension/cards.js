/* Format public : { "cards": [{"type":"basic", "front":"...", "back":"..."},
    {"type":"cloze", "text":"La {{c1::métoprolol}} est un ...", "extra":"..."}] }

   Deux lectures :
   - toCards(input)  : STRICTE. Tout le lot doit être valide (1 à 100 cartes).
                       Sert à la vérification et à l'import d'un lot déjà relu.
   - parse(text)     : TOLÉRANTE. Lit ce que ChatGPT affiche réellement :
                       cartes invalides écartées une par une (avec la raison),
                       réponse coupée en cours de JSON, plusieurs blocs de code,
                       plus de 100 cartes. Ne lève jamais d'exception. */
(function (root) {
  'use strict';
  const MAX_CARDS = 100;
  function stripFence(text) {
    const s = String(text || '').trim();
    const m = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
    return m ? m[1].trim() : s;
  }
  // Valide et normalise UNE carte. Lève une erreur lisible si elle est inutilisable.
  function normalizeCard(c, i) {
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
  }
  function toCards(input) {
    let value = input;
    if (typeof value === 'string') value = JSON.parse(stripFence(value));
    let items = Array.isArray(value) ? value : (value && (value.cards || value.notes));
    if (!Array.isArray(items)) throw new Error('Format attendu : {"cards":[{"front":"...","back":"..."}]}');
    if (items.length === 0) throw new Error('Aucune carte dans le JSON.');
    if (items.length > MAX_CARDS) throw new Error(`Maximum ${MAX_CARDS} cartes par import. Découpe ta demande en lots.`);
    return items.map(normalizeCard);
  }

  /* Repère tous les objets JSON {…} COMPLETS d'un texte, même si le document
     englobant est coupé (réponse interrompue) ou s'il y en a plusieurs à la suite
     (plusieurs blocs de code). Les chaînes et échappements sont respectés : une
     accolade dans un texte de carte ne trompe pas le découpage. */
  function balancedObjects(text) {
    const found = [];
    const stack = [];
    let inString = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') stack.push(i);
      else if (ch === '}' && stack.length) {
        const start = stack.pop();
        found.push({start, end: i + 1, depth: stack.length});
      }
    }
    return {found, unclosed: stack.length > 0 || inString};
  }
  const CARD_KEYS = ['front', 'back', 'question', 'answer', 'text', 'extra'];
  const looksLikeCard = v => v && typeof v === 'object' && !Array.isArray(v) &&
    CARD_KEYS.some(k => typeof v[k] === 'string');

  function parse(text) {
    const source = String(text || '');
    const result = {cards: [], rejected: [], truncated: false, total: 0};
    // 1) Cas nominal : un document JSON entier et valide.
    let whole = null;
    try { whole = JSON.parse(stripFence(source)); } catch (_) { whole = null; }
    let items = null;
    if (whole !== null) {
      items = Array.isArray(whole) ? whole : (whole && (whole.cards || whole.notes));
      if (!Array.isArray(items)) items = null;
    }
    // 2) Sinon : réponse coupée, ou plusieurs blocs. On récupère chaque carte complète.
    if (!items) {
      const {found, unclosed} = balancedObjects(source);
      // On ne garde que les objets « carte » les plus externes : un objet carte ne
      // contient jamais d'autre carte, et le conteneur {"cards":[…]} n'en est pas une.
      const picked = [];
      for (const span of found.sort((a, b) => a.start - b.start)) {
        if (picked.length && span.start < picked[picked.length - 1].end) continue;
        let value;
        try { value = JSON.parse(source.slice(span.start, span.end)); } catch (_) { continue; }
        if (looksLikeCard(value)) picked.push({...span, value});
      }
      items = picked.map(p => p.value);
      result.truncated = unclosed && items.length > 0;
    }
    result.total = items.length;
    items.forEach((item, i) => {
      try { result.cards.push(normalizeCard(item, i)); }
      catch (e) { result.rejected.push({index: i + 1, reason: e.message}); }
    });
    return result;
  }
  // Découpe en lots de 100 maximum (limite d'une vérification / d'un import).
  function chunks(cards, size = MAX_CARDS) {
    const out = [];
    for (let i = 0; i < cards.length; i += size) out.push({from: i + 1, to: Math.min(i + size, cards.length), cards: cards.slice(i, i + size)});
    return out;
  }
  root.AnkiCards = Object.freeze({toCards, parse, chunks, stripFence, MAX_CARDS});
})(typeof globalThis !== 'undefined' ? globalThis : this);
