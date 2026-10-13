'use strict';
/* Composants de la fenêtre de vérification, sans état global :
   - createDeckPicker : choix de paquet recherchable, avec création proposée ;
   - askConfirm       : confirmation dans la page (aucune fenêtre native).
   Tout le DOM est construit avec createElement / textContent. */
(() => {
  const {normText, deckLabel, validateDeckName, sameDeck} = AnkiShared;
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const MAX_OPTIONS = 50;
  /* Choix de paquet RECHERCHABLE : combobox accessible (rôle combobox + listbox).
     Taper filtre la liste ; seule une sélection réelle (clic ou Entrée) appelle
     onChoose, donc l'analyse ne se relance jamais à chaque caractère.
     Si la recherche ne désigne exactement aucun paquet, une dernière option
     « Créer le paquet « X » » appelle onCreate(nom) : rien n'est écrit ici, c'est
     l'appelant qui demande confirmation puis crée le paquet. */
  function createDeckPicker(names, onChoose, {onCreate = null} = {}) {
    let pool = Array.isArray(names) ? names : [];
    const root = el('div','ankibridge-combo');
    const input = el('input','ankibridge-deckinput');
    input.type = 'text';
    input.setAttribute('role','combobox');
    input.setAttribute('aria-expanded','false');
    input.setAttribute('aria-autocomplete','list');
    input.setAttribute('aria-label','Rechercher un paquet Anki');
    input.setAttribute('autocomplete','off');
    input.setAttribute('placeholder','Tape un mot du paquet…');
    const list = el('ul','ankibridge-decklist');
    list.setAttribute('role','listbox');
    list.hidden = true;
    root.append(input, list);
    let current = '';
    let shown = [];      // options navigables : {kind:'deck'|'create', name}
    let active = -1;
    let seq = 0;
    function filtered(query) {
      const words = normText(query).split(/\s+/).filter(Boolean);
      if (!words.length) return pool.slice();
      return pool.filter(name => {
        const hay = normText(name).replace(/::/g, ' ');
        return words.every(w => hay.includes(w));
      });
    }
    // Option de création : seulement si le nom tapé n'est pas déjà un paquet.
    function creation(query) {
      if (!onCreate || !String(query).trim()) return null;
      const check = validateDeckName(query);
      if (check.ok && pool.some(name => sameDeck(name, check.name))) return null;
      return check;
    }
    function option(entry, text, className) {
      const li = el('li', className, text);
      li.setAttribute('role','option');
      li.setAttribute('aria-selected', entry.kind === 'deck' && entry.name === current ? 'true' : 'false');
      li.setAttribute('id', 'ankibridge-opt-' + (++seq));
      li.dataset.value = entry.name;
      li.addEventListener('mousedown', e => e.preventDefault());
      li.onclick = () => pick(entry);
      return li;
    }
    function paint(query) {
      const found = filtered(query);
      const decks = found.slice(0, MAX_OPTIONS);
      const create = creation(query);
      shown = decks.map(name => ({kind: 'deck', name}));
      list.replaceChildren();
      if (!decks.length) {
        const empty = el('li','ankibridge-deckempty','Aucun résultat');
        empty.setAttribute('role','presentation');
        list.append(empty);
      }
      for (const entry of shown) list.append(option(entry, deckLabel(entry.name), 'ankibridge-deckoption'));
      if (found.length > decks.length) {
        const more = el('li','ankibridge-deckmore', `${found.length - decks.length} autre(s) paquet(s) — précise la recherche`);
        more.setAttribute('role','presentation');
        list.append(more);
      }
      if (create && create.ok) {
        const entry = {kind: 'create', name: create.name};
        shown.push(entry);
        list.append(option(entry, `Créer le paquet « ${deckLabel(create.name)} »`, 'ankibridge-deckcreate'));
      } else if (create) {
        const invalid = el('li','ankibridge-deckinvalid', `Création impossible : ${create.error}`);
        invalid.setAttribute('role','presentation');
        list.append(invalid);
      }
      active = -1;
      input.removeAttribute('aria-activedescendant');
    }
    function highlight() {
      const opts = list.querySelectorAll('.ankibridge-deckoption, .ankibridge-deckcreate');
      opts.forEach((n, i) => { n.classList.remove('active'); if (i === active) n.classList.add('active'); });
      if (opts[active]) input.setAttribute('aria-activedescendant', opts[active].getAttribute('id') || '');
      else input.removeAttribute('aria-activedescendant');
    }
    function open() {
      if (!list.hidden) return;
      list.hidden = false;
      input.setAttribute('aria-expanded','true');
      paint(input.value === deckLabel(current) ? '' : input.value);
    }
    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded','false');
      active = -1;
      input.removeAttribute('aria-activedescendant');
    }
    function choose(name) {
      current = name;
      input.value = deckLabel(name);
      close();
      onChoose(name);
    }
    function pick(entry) {
      if (entry.kind === 'create') { close(); onCreate(entry.name); return; }
      choose(entry.name);
    }
    input.addEventListener('input', () => { open(); paint(input.value); });
    input.addEventListener('focus', open);
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) { open(); return; }
        if (!shown.length) return;
        active = e.key === 'ArrowDown' ? (active + 1) % shown.length : (active <= 0 ? shown.length - 1 : active - 1);
        highlight();
      } else if (e.key === 'Enter') {
        if (!list.hidden && shown.length) { e.preventDefault(); pick(shown[active >= 0 ? active : 0]); }
      } else if (e.key === 'Escape') {
        if (!list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
      } else if (e.key === 'Tab') { close(); }
    });
    return {
      root, input, close,
      get value() { return current; },
      setValue(name) { current = name; input.value = deckLabel(name); close(); },
      setNames(next) { pool = Array.isArray(next) ? next : []; }
    };
  }
  // Confirmation dans la page (pas de fenêtre native) : annuler ne déclenche rien.
  function askConfirm(dialog, title, lines, okLabel = 'Confirmer le remplacement') {
    return new Promise(resolve => {
      const box = el('div','ankibridge-confirm');
      box.setAttribute('role','alertdialog');
      box.append(el('h3','',title));
      for (const line of lines) box.append(el('p','',line));
      const actions = el('div','ankibridge-confirmactions');
      const ok = el('button','ankibridge-confirmok',okLabel);
      const cancel = el('button','ankibridge-cancel','Annuler');
      ok.type = 'button'; cancel.type = 'button';
      ok.onclick = () => { box.remove(); resolve(true); };
      cancel.onclick = () => { box.remove(); resolve(false); };
      actions.append(ok, cancel); box.append(actions); dialog.append(box);
    });
  }
  globalThis.AnkiPicker = Object.freeze({createDeckPicker, askConfirm, el});
})();
