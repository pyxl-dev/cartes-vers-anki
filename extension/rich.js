'use strict';
/* Éditeur visuel (WYSIWYG) des champs de la fenêtre de vérification.
   - Le texte s'affiche et se modifie mis en forme ; une barre d'outils applique
     gras, italique, exposant, indice, listes (Ctrl/Cmd+B et Ctrl/Cmd+I marchent aussi).
   - Les trous {{c1::…}} sont des cases protégées : on corrige la réponse dans la
     case, « × » retire le trou (le texte reste), une sélection devient un trou.
   - La zone de texte cachée reste la SOURCE envoyée à Anki : l'éditeur la met à
     jour à chaque modification (shared.js : domToMarkdown), et se redessine si
     elle change ailleurs (mode « Texte brut »).
   - Un collage est toujours inséré en texte simple. Aucun HTML venant de ChatGPT
     ou du presse-papiers n'est interprété : DOM construit avec createElement. */
(() => {
  const {parseFormatting, clozesOf, splitAnswer, setClozeAnswer, setClozeNumber, removeCloze, addCloze, domToMarkdown} = AnkiShared;
  const {el} = AnkiPicker;
  const TOOLS = [
    ['bold', 'G', 'Gras (Ctrl+B)', 'bold'],
    ['italic', 'I', 'Italique (Ctrl+I)', 'italic'],
    ['superscript', 'x²', 'Exposant (ex. Na⁺)', 'sup'],
    ['subscript', 'x₂', 'Indice (ex. H₂O)', 'sub'],
    ['insertUnorderedList', '• Liste', 'Liste à puces', ''],
    ['insertOrderedList', '1. Liste', 'Liste numérotée', ''],
    ['removeFormat', 'Effacer', 'Retirer la mise en forme de la sélection', '']
  ];
  const exec = (cmd, value = null) => (typeof document.execCommand === 'function' ? document.execCommand(cmd, false, value) : false);

  // Case d'un trou : numéro de carte, réponse modifiable, indice, bouton « × ».
  function holeChip(src, k, hooks) {
    const cz = clozesOf(src)[0];
    const hole = el('span','ankibridge-hole');
    hole.setAttribute('contenteditable','false');
    hole.setAttribute('data-src', src);
    // Pastille = numéro de carte. Un clic ouvre le choix : même carte qu'un autre
    // trou (cachés ensemble) ou nouvelle carte.
    const num = el('button','ankibridge-holenum', String(cz.n));
    num.type = 'button';
    num.setAttribute('aria-haspopup','menu');
    num.setAttribute('aria-expanded','false');
    num.setAttribute('aria-label', `Trou ${k + 1} : carte n° ${cz.n}. Changer de carte`);
    num.setAttribute('title', `Carte n° ${cz.n} — cliquer pour changer`);
    num.addEventListener('mousedown', e => e.preventDefault());
    num.onclick = () => hooks.menu(k, hole, num);
    const {value, wrap} = splitAnswer(cz.content);
    const input = el('input','ankibridge-holeinput');
    input.type = 'text';
    input.value = value;
    if (wrap === '**') input.classList.add('bold');
    if (wrap === '*') input.classList.add('italic');
    const size = () => input.setAttribute('size', String(Math.min(60, Math.max(4, input.value.length + 1))));
    size();
    input.setAttribute('aria-label', `Réponse attendue du trou ${k + 1} (carte ${cz.n})`);
    input.setAttribute('autocomplete','off');
    if (/\{\{/.test(value)) { input.disabled = true; input.setAttribute('title','Trou imbriqué : utilise « Texte brut ».'); }
    input.addEventListener('input', () => {
      size();
      const r = setClozeAnswer(hole.getAttribute('data-src'), 0, input.value, wrap);
      if (!r.ok) { input.classList.add('invalid'); input.setAttribute('aria-invalid','true'); hooks.say(r.error, true); return; }
      input.classList.remove('invalid'); input.removeAttribute('aria-invalid'); hooks.say('');
      hole.setAttribute('data-src', r.text);
      hooks.sync();
    });
    // Les touches tapées dans la case ne doivent pas déclencher l'édition autour.
    input.addEventListener('keydown', e => e.stopPropagation());
    hole.append(num, input);
    if (cz.hint !== null) hole.append(el('span','ankibridge-clozehint', ` indice : ${cz.hint}`));
    const remove = el('button','ankibridge-holeremove','×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Retirer le trou ${k + 1} (le texte reste)`);
    remove.setAttribute('title','Retirer ce trou (le texte reste visible)');
    remove.addEventListener('mousedown', e => e.preventDefault());
    remove.onclick = () => hooks.remove(k);
    hole.append(remove);
    return hole;
  }
  function build(parent, nodes, source, hooks, counter) {
    for (const n of nodes) {
      if (n.t === 'text') {
        n.v.split('\n').forEach((part, k) => {
          if (k) parent.append(document.createElement('br'));
          if (part) parent.append(document.createTextNode(part));
        });
      } else if (n.t === 'code') {
        parent.append(el('code', '', n.v));
      } else if (n.t === 'cloze') {
        parent.append(holeChip(source.slice(n.start, n.end), counter.k++, hooks));
      } else {
        const node = document.createElement(n.t);   // b, i, sup ou sub
        build(node, n.c, source, hooks, counter);
        parent.append(node);
      }
    }
  }
  function renderEditable(target, text, hooks) {
    const source = String(text ?? '');
    const counter = {k: 0};
    target.replaceChildren();
    parseFormatting(source).forEach(b => {
      if (b.t === 'lines') {
        b.lines.forEach((line, k) => {
          if (k) target.append(document.createElement('br'));
          build(target, line, source, hooks, counter);
        });
        return;
      }
      const list = document.createElement(b.t);
      if (b.t === 'ol' && b.start !== 1) list.setAttribute('start', String(b.start));
      for (const item of b.items) {
        const li = document.createElement('li');
        build(li, item, source, hooks, counter);
        list.append(li);
      }
      target.append(list);
    });
    return counter.k;
  }
  /* Position de la sélection dans le texte de la carte : deux repères invisibles
     sont insérés aux bords de la sélection, le contenu est converti, puis les
     repères sont retirés. Marche après n'importe quelle modification à la main. */
  const START = '', END = '';
  function selectionInSource(editor) {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
    const a = document.createTextNode(START), b = document.createTextNode(END);
    const tail = range.cloneRange(); tail.collapse(false); tail.insertNode(b);
    const head = range.cloneRange(); head.collapse(true); head.insertNode(a);
    const md = domToMarkdown(editor);
    a.remove(); b.remove();
    editor.normalize?.();
    const i = md.indexOf(START), j = md.indexOf(END);
    if (i < 0 || j < 0 || j < i) return {error: 'La sélection touche un trou existant.'};
    return {text: md.replace(START, '').replace(END, ''), start: i, end: j - 1};
  }

  function richEditor(area, {clozes = false, label = ''} = {}) {
    const box = el('div','ankibridge-rich');
    const bar = el('div','ankibridge-toolbar');
    bar.setAttribute('role','toolbar');
    bar.setAttribute('aria-label', `Mise en forme : ${label}`);
    const editor = el('div','ankibridge-richedit');
    editor.setAttribute('contenteditable','true');
    editor.setAttribute('role','textbox');
    editor.setAttribute('aria-multiline','true');
    editor.setAttribute('aria-label', label);
    const msg = el('span','ankibridge-holemsg');
    msg.setAttribute('role','status');
    const say = (text, bad) => { msg.textContent = text; msg.className = 'ankibridge-holemsg' + (bad ? ' bad' : ''); };
    let fromEditor = false;
    const commit = text => {
      if (text === area.value) return;
      fromEditor = true;
      area.value = text;
      area.dispatchEvent(new Event('input', {bubbles: true}));
      fromEditor = false;
    };
    /* Annuler / rétablir (Ctrl+Z, Ctrl+Maj+Z ou Ctrl+Y). L'éditeur se redessine
       après une action sur un trou : l'historique natif du navigateur ne suit
       plus, il est donc remplacé par le nôtre (états successifs du texte). La
       frappe est regroupée par pauses ; les actions sur les trous et la barre
       d'outils forment chacune une étape. */
    const HISTORY_MAX = 100;
    let history = [area.value], at = 0, typingTimer = null;
    const record = () => {
      clearTimeout(typingTimer); typingTimer = null;
      if (area.value === history[at]) return;
      history = history.slice(0, at + 1);
      history.push(area.value);
      if (history.length > HISTORY_MAX) history.shift();
      at = history.length - 1;
    };
    const sync = () => {
      commit(domToMarkdown(editor));
      clearTimeout(typingTimer);
      typingTimer = setTimeout(record, 500);
    };
    // Action sur un trou : une étape d'historique, puis éditeur redessiné.
    const apply = text => { record(); commit(text); paint(); record(); };
    const placeCaretAtEnd = () => {
      const sel = window.getSelection?.();
      if (!sel || typeof document.createRange !== 'function') return;
      const r = document.createRange(); r.selectNodeContents(editor); r.collapse(false);
      sel.removeAllRanges(); sel.addRange(r);
    };
    const travel = step => {
      record();
      const next = at + step;
      if (next < 0 || next >= history.length) return false;
      at = next;
      commit(history[at]); paint();
      say(step < 0 ? 'Modification annulée.' : 'Modification rétablie.');
      editor.focus(); placeCaretAtEnd();
      return true;
    };
    // Menu du numéro de carte d'un trou.
    let openMenu = null;
    const closeMenu = () => {
      if (!openMenu) return;
      openMenu.menu.remove();
      openMenu.button.setAttribute('aria-expanded','false');
      document.removeEventListener('mousedown', openMenu.outside, true);
      document.removeEventListener('scroll', openMenu.follow, true);
      openMenu = null;
    };
    const menu = (k, hole, button) => {
      const wasOpen = openMenu && openMenu.button === button;
      closeMenu();
      if (wasOpen) return;
      const md = domToMarkdown(editor);
      const all = clozesOf(md);
      const mine = all[k];
      if (!mine) return;
      const used = [...new Set(all.map(c => c.n))].sort((a, b) => a - b);
      const alone = all.filter(c => c.n === mine.n).length === 1;
      const next = used[used.length - 1] + 1;
      const box = el('div','ankibridge-holemenu');
      box.setAttribute('role','menu');
      box.setAttribute('contenteditable','false');
      const pick = n => {
        closeMenu();
        if (n === mine.n) return;
        const r = setClozeNumber(md, k, n);
        if (!r.ok) { say(r.error, true); return; }
        apply(r.text);
        const others = clozesOf(r.text).filter(c => c.n === n).length - 1;
        say(others ? `Trou placé sur la carte n° ${n} : caché en même temps que ${others} autre${others > 1 ? 's' : ''} trou${others > 1 ? 's' : ''}.`
          : `Trou placé seul sur la carte n° ${n}.`);
      };
      const item = (n, text) => {
        const b = el('button','ankibridge-holemenuitem' + (n === mine.n ? ' current' : ''), text);
        b.type = 'button';
        b.setAttribute('role','menuitemradio');
        b.setAttribute('aria-checked', n === mine.n ? 'true' : 'false');
        b.addEventListener('mousedown', e => e.preventDefault());
        b.onclick = () => pick(n);
        b.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); button.focus(); } });
        return b;
      };
      for (const n of used) {
        const count = all.filter(c => c.n === n).length;
        box.append(item(n, `Carte ${n}` + (n === mine.n ? ' (actuelle)' : count > 1 ? ` — ${count} trous` : '')));
      }
      if (!(alone && mine.n === used[used.length - 1])) box.append(item(next, `Nouvelle carte (n° ${next})`));
      box.append(el('p','ankibridge-holemenuhint','Même numéro = trous cachés ensemble sur la même carte.'));
      // Accroché à la fenêtre, hors de la zone qui défile et hors du texte modifiable.
      (editor.closest('.ankibridge-dialog') || hole).append(box);
      // Position fixe calculée sous la pastille (ou au-dessus s'il manque de la
      // place) : le menu n'est jamais coupé par la zone d'édition qui défile.
      const place = () => {
        const r = button.getBoundingClientRect?.();
        if (!r) return true;
        // Pastille sortie de la zone visible de la liste : le menu n'a plus de sens.
        const area = (editor.closest('.ankibridge-main') || editor).getBoundingClientRect?.();
        if (!button.isConnected || (area && (r.bottom < area.top || r.top > area.bottom))) return false;
        const h = box.getBoundingClientRect?.().height || 0;
        const below = r.bottom + 4 + h <= (window.innerHeight || Infinity);
        box.style.left = Math.max(8, Math.min(r.left, (window.innerWidth || 1e9) - 270)) + 'px';
        box.style.top = (below ? r.bottom + 4 : Math.max(8, r.top - 4 - h)) + 'px';
        return true;
      };
      place();
      // Au défilement, le menu suit sa pastille (le défilement doux qui amène la
      // pastille à l'écran arrive juste après le clic) ; il se ferme si elle disparaît.
      const follow = () => { if (!place()) closeMenu(); };
      document.addEventListener('scroll', follow, true);
      button.setAttribute('aria-expanded','true');
      const outside = e => { if (!box.contains(e.target) && e.target !== button) closeMenu(); };
      document.addEventListener('mousedown', outside, true);
      openMenu = {menu: box, button, outside, follow};
      box.querySelector('.ankibridge-holemenuitem')?.focus?.();
    };
    const hooks = {say, sync, menu, remove: k => {
      const r = removeCloze(domToMarkdown(editor), k);
      if (!r.ok) { say(r.error, true); return; }
      apply(r.text);
      say('Trou retiré : le texte reste dans la carte.');
    }};
    const paint = () => {
      closeMenu();
      const n = renderEditable(editor, area.value, hooks);
      if (clozes && !n) say('Aucun trou : sélectionne un mot, puis « Transformer la sélection en trou ».', true);
      return n;
    };
    const buttons = [];
    const refresh = () => {
      if (typeof document.queryCommandState !== 'function') return;
      for (const b of buttons) if (b.dataset.state) b.setAttribute('aria-pressed', document.queryCommandState(b.dataset.cmd) ? 'true' : 'false');
    };
    for (const [cmd, text, title, state] of TOOLS) {
      const b = el('button','ankibridge-tool ' + (state || cmd), text);
      b.type = 'button';
      b.dataset.cmd = cmd;
      if (state) { b.dataset.state = state; b.setAttribute('aria-pressed','false'); }
      b.setAttribute('title', title);
      b.setAttribute('aria-label', title);
      b.addEventListener('mousedown', e => e.preventDefault());   // garde la sélection
      b.onclick = () => {
        editor.focus();
        exec('styleWithCSS', false);
        exec(cmd);
        sync(); record(); refresh();
      };
      buttons.push(b); bar.append(b);
    }
    // Sélection → trou : nouvelle carte, ou même carte que le dernier trou.
    const addHole = same => {
      const where = selectionInSource(editor);
      if (!where) { say('Sélectionne d’abord un mot ou une expression dans le texte.', true); return; }
      if (where.error) { say(where.error, true); return; }
      const r = addCloze(where.text, where.start, where.end, {same});
      if (!r.ok) { say(r.error, true); return; }
      apply(r.text);
      window.getSelection?.()?.removeAllRanges?.();
      const together = clozesOf(r.text).filter(c => c.n === r.n).length - 1;
      say(together ? `Trou ajouté sur la carte n° ${r.n}, caché avec ${together} autre${together > 1 ? 's' : ''} trou${together > 1 ? 's' : ''}.`
        : `Trou ajouté : il deviendra la carte n° ${r.n}.`);
    };
    if (clozes) {
      const add = el('button','ankibridge-holeadd','Transformer la sélection en trou');
      add.type = 'button';
      add.setAttribute('title','Sélectionne un mot ou une expression dans le texte, puis clique ici (Ctrl+Maj+C ; même carte que le dernier trou : Ctrl+Maj+Alt+C)');
      add.setAttribute('aria-keyshortcuts','Control+Shift+C Meta+Shift+C');
      add.addEventListener('mousedown', e => e.preventDefault());
      add.onclick = () => addHole(false);
      bar.append(add);
    }
    // Raccourcis : ceux de l'éditeur d'Anki pour les trous, et annuler / rétablir.
    editor.addEventListener('keydown', e => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = String(e.key || '').toLowerCase();
      if (clozes && e.shiftKey && (e.code === 'KeyC' || key === 'c')) { e.preventDefault(); addHole(!!e.altKey); return; }
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); travel(-1); return; }
      if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); travel(1); }
    });
    // Menu « Édition › Annuler » du navigateur : même historique.
    editor.addEventListener('beforeinput', e => {
      if (e.inputType === 'historyUndo') { e.preventDefault(); travel(-1); }
      else if (e.inputType === 'historyRedo') { e.preventDefault(); travel(1); }
    });
    editor.addEventListener('input', sync);
    editor.addEventListener('keyup', refresh);
    editor.addEventListener('mouseup', refresh);
    // Collage : toujours en texte simple (ni styles, ni liens, ni images).
    editor.addEventListener('paste', e => {
      e.preventDefault();
      exec('insertText', e.clipboardData?.getData('text/plain') || '');
    });
    // Changement fait ailleurs (mode « Texte brut ») : éditeur redessiné, étape d'historique.
    area.addEventListener('input', () => { if (!fromEditor) { paint(); record(); } });
    box.append(bar, editor, msg);
    paint();
    return {box, editor, paint};
  }
  globalThis.AnkiRich = Object.freeze({richEditor, renderEditable, selectionInSource});
})();
