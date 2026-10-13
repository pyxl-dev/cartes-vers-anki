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
     - Cliquer le champ sélectionne son texte : taper REMPLACE le nom affiché
       (au lieu de s'y ajouter) et filtre la liste.
     - Seule une sélection réelle (clic ou Entrée) appelle onChoose : l'analyse
       ne se relance jamais à chaque caractère. Échap ou un clic ailleurs
       réaffichent le paquet choisi.
     - Création : bouton « + Nouveau paquet » toujours visible, ou dernière option
       de la liste quand la recherche ne désigne exactement aucun paquet. Un petit
       formulaire s'ouvre sous le champ : il montre ce qui sera créé (et si le
       parent le sera aussi) ; rien n'est écrit avant le clic sur « Créer le
       paquet ». onCreate(nom) est appelé à ce moment et peut échouer : l'erreur
       s'affiche dans le formulaire. */
  function createDeckPicker(names, onChoose, {onCreate = null} = {}) {
    let pool = Array.isArray(names) ? names : [];
    const root = el('div','ankibridge-combo');
    const line = el('div','ankibridge-comborow');
    const input = el('input','ankibridge-deckinput');
    input.type = 'text';
    input.setAttribute('role','combobox');
    input.setAttribute('aria-expanded','false');
    input.setAttribute('aria-autocomplete','list');
    input.setAttribute('aria-label','Rechercher un paquet Anki');
    input.setAttribute('autocomplete','off');
    input.setAttribute('placeholder','Tape un mot du paquet…');
    const toggle = el('button','ankibridge-decktoggle','▾');
    toggle.type = 'button';
    toggle.setAttribute('aria-label','Afficher tous les paquets');
    toggle.setAttribute('tabindex','-1');
    line.append(input, toggle);
    let newBtn = null;
    if (onCreate) {
      newBtn = el('button','ankibridge-newdeckbtn','+ Nouveau paquet');
      newBtn.type = 'button';
      line.append(newBtn);
    }
    const list = el('ul','ankibridge-decklist');
    list.setAttribute('role','listbox');
    list.hidden = true;
    // Formulaire de création, sous le champ.
    const panel = el('div','ankibridge-newdeck');
    panel.hidden = true;
    const nameLabel = el('label','ankibridge-newdecklabel','Nom du nouveau paquet');
    const nameInput = el('input','ankibridge-newdeckname');
    nameInput.type = 'text';
    nameInput.setAttribute('autocomplete','off');
    nameInput.setAttribute('placeholder','ex. Cardio::Cours 3  (« :: » pour un sous-paquet)');
    nameLabel.append(nameInput);
    const info = el('p','ankibridge-newdeckinfo');
    info.setAttribute('role','status');
    const okBtn = el('button','ankibridge-newdeckok','Créer le paquet');
    const cancelBtn = el('button','ankibridge-newdeckcancel','Annuler');
    okBtn.type = 'button'; cancelBtn.type = 'button';
    const panelActions = el('div','ankibridge-newdeckactions');
    panelActions.append(okBtn, cancelBtn);
    panel.append(nameLabel, info, panelActions);
    root.append(line, list, panel);
    let current = '';
    let shown = [];      // options navigables : {kind:'deck'|'create', name}
    let active = -1;
    let seq = 0;
    let busy = false;
    function filtered(query) {
      // « Parent::Enfant » ou « Parent › Enfant » tapé en entier doit aussi trouver le paquet.
      const words = normText(query).replace(/::|›/g, ' ').split(/\s+/).filter(Boolean);
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
    function option(entry, className) {
      const li = el('li', className);
      if (entry.kind === 'deck') {
        // Libellé « Parent › » discret + nom du paquet ; le texte lu reste le chemin complet.
        const parts = deckLabel(entry.name).split(' › ');
        if (parts.length > 1) li.append(el('span','ankibridge-deckparent', parts.slice(0, -1).join(' › ') + ' › '));
        li.append(el('span','ankibridge-deckleaf', parts[parts.length - 1]));
      } else {
        li.append(el('span','ankibridge-deckleaf', `+ Créer le paquet « ${deckLabel(entry.name)} »`));
      }
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
        const empty = el('li','ankibridge-deckempty', String(query).trim() ? `Aucun paquet ne contient « ${String(query).trim()} »` : 'Aucun résultat');
        empty.setAttribute('role','presentation');
        list.append(empty);
      }
      for (const entry of shown) list.append(option(entry, 'ankibridge-deckoption'));
      if (found.length > decks.length) {
        const more = el('li','ankibridge-deckmore', `${found.length - decks.length} autre(s) paquet(s) — précise la recherche`);
        more.setAttribute('role','presentation');
        list.append(more);
      }
      if (create && create.ok) {
        const entry = {kind: 'create', name: create.name};
        shown.push(entry);
        list.append(option(entry, 'ankibridge-deckcreate'));
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
    function open(query) {
      list.hidden = false;
      input.setAttribute('aria-expanded','true');
      paint(query === undefined ? (input.value === deckLabel(current) ? '' : input.value) : query);
    }
    function close({restore = false} = {}) {
      list.hidden = true;
      input.setAttribute('aria-expanded','false');
      active = -1;
      input.removeAttribute('aria-activedescendant');
      if (restore) input.value = deckLabel(current);
    }
    function choose(name) {
      current = name;
      input.value = deckLabel(name);
      close();
      onChoose(name);
    }
    // --- Formulaire de création ---
    function describe() {
      const check = validateDeckName(nameInput.value);
      info.className = 'ankibridge-newdeckinfo';
      if (!nameInput.value.trim()) { info.textContent = 'Tape le nom du paquet à créer. Un sous-paquet s’écrit « Parent::Enfant ».'; okBtn.disabled = true; okBtn.textContent = 'Créer le paquet'; return null; }
      if (!check.ok) { info.textContent = check.error; info.classList.add('bad'); okBtn.disabled = true; return null; }
      const existing = pool.find(name => sameDeck(name, check.name));
      if (existing) {
        info.textContent = `Le paquet « ${deckLabel(existing)} » existe déjà : il sera simplement choisi.`;
        okBtn.disabled = false; okBtn.textContent = 'Choisir ce paquet';
        return {existing};
      }
      const parts = check.name.split('::');
      const parent = parts.slice(0, -1).join('::');
      let text = `« ${deckLabel(check.name)} » sera créé dans Anki`;
      if (parent) text += pool.some(name => sameDeck(name, parent))
        ? `, rangé dans le paquet existant « ${deckLabel(parent)} ».`
        : ` ; le paquet parent « ${deckLabel(parent)} » n’existe pas encore et sera créé aussi.`;
      else text += '.';
      info.textContent = text + ' Aucun paquet ni aucune carte existants ne sont modifiés.';
      okBtn.disabled = false; okBtn.textContent = 'Créer le paquet';
      return {name: check.name};
    }
    function openPanel(name = '') {
      if (!onCreate) return;
      close({restore: true});
      panel.hidden = false;
      nameInput.value = name;
      describe();
      nameInput.focus();
    }
    function closePanel() { panel.hidden = true; busy = false; }
    async function confirmPanel() {
      if (busy) return;
      const what = describe();
      if (!what) return;
      if (what.existing) { closePanel(); choose(what.existing); return; }
      busy = true; okBtn.disabled = true; cancelBtn.disabled = true;
      info.textContent = `Création de « ${deckLabel(what.name)} »…`;
      try {
        await onCreate(what.name);
        closePanel();
      } catch (e) {
        info.textContent = `Création impossible : ${e?.message || e}`;
        info.className = 'ankibridge-newdeckinfo bad';
        busy = false;
      } finally { okBtn.disabled = false; cancelBtn.disabled = false; }
    }
    nameInput.addEventListener('input', describe);
    nameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); confirmPanel(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePanel(); input.focus(); }
    });
    okBtn.onclick = confirmPanel;
    cancelBtn.onclick = () => { closePanel(); };
    if (newBtn) newBtn.onclick = () => {
      const typed = input.value === deckLabel(current) ? '' : input.value;
      if (panel.hidden) openPanel(typed); else closePanel();
    };
    function pick(entry) {
      if (entry.kind === 'create') { openPanel(entry.name); return; }
      choose(entry.name);
    }
    input.addEventListener('input', () => open(input.value));
    // Au clic / à l'entrée dans le champ : tout le texte est sélectionné, la
    // frappe remplace donc le nom affiché ; la liste complète s'ouvre.
    input.addEventListener('focus', () => { input.select?.(); if (list.hidden) open(''); });
    input.addEventListener('blur', () => setTimeout(() => {
      if (!root.contains?.(document.activeElement)) close({restore: true});
    }, 150));
    toggle.addEventListener('mousedown', e => e.preventDefault());
    toggle.onclick = () => { if (list.hidden) { input.focus(); open(''); } else close({restore: true}); };
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
        if (!list.hidden) { e.preventDefault(); e.stopPropagation(); close({restore: true}); }
      } else if (e.key === 'Tab') { close({restore: true}); }
    });
    return {
      root, input, close, openPanel,
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
  /* Thème de la fenêtre : « automatique » suit le système (et ses changements en
     direct), « clair » ou « sombre » l'imposent. Réglage partagé avec le popup
     (chrome.storage.local, clé « theme »). Le bouton fait tourner les trois choix. */
  const THEME_KEY = 'theme';
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_NAMES = {auto: 'automatique', light: 'clair', dark: 'sombre'};
  function themeControl(target) {
    const button = el('button','ankibridge-themebtn','Thème : automatique');
    button.type = 'button';
    button.setAttribute('title','Changer le thème (automatique = celui du système)');
    let theme = 'auto';
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'auto' && !!mq?.matches);
      if (dark) target.classList.add('ankibridge-dark'); else target.classList.remove('ankibridge-dark');
      button.textContent = `Thème : ${THEME_NAMES[theme]}`;
      button.setAttribute('aria-label', `Thème ${THEME_NAMES[theme]} : cliquer pour changer`);
    };
    mq?.addEventListener?.('change', apply);
    button.onclick = () => {
      theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
      apply();
      chrome.storage.local.set({[THEME_KEY]: theme}).catch?.(() => {});
    };
    chrome.storage.local.get(THEME_KEY).then(saved => {
      if (THEMES.includes(saved?.[THEME_KEY])) theme = saved[THEME_KEY];
      apply();
    }).catch(() => apply());
    apply();
    return {button, stop: () => mq?.removeEventListener?.('change', apply)};
  }
  globalThis.AnkiPicker = Object.freeze({createDeckPicker, askConfirm, themeControl, el});
})();
