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
  const {parseFormatting, clozesOf, splitAnswer, setClozeAnswer, removeCloze, addCloze, domToMarkdown} = AnkiShared;
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
    const num = el('span','ankibridge-holenum', String(cz.n));
    num.setAttribute('title', `Ce trou est caché dans la carte n° ${cz.n}`);
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
    const sync = () => commit(domToMarkdown(editor));
    const hooks = {say, sync, remove: k => {
      const r = removeCloze(domToMarkdown(editor), k);
      if (!r.ok) { say(r.error, true); return; }
      commit(r.text); paint();
      say('Trou retiré : le texte reste dans la carte.');
    }};
    const paint = () => {
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
        sync(); refresh();
      };
      buttons.push(b); bar.append(b);
    }
    if (clozes) {
      const add = el('button','ankibridge-holeadd','Transformer la sélection en trou');
      add.type = 'button';
      add.setAttribute('title','Sélectionne un mot ou une expression dans le texte, puis clique ici');
      add.addEventListener('mousedown', e => e.preventDefault());
      add.onclick = () => {
        const where = selectionInSource(editor);
        if (!where) { say('Sélectionne d’abord un mot ou une expression dans le texte.', true); return; }
        if (where.error) { say(where.error, true); return; }
        const r = addCloze(where.text, where.start, where.end);
        if (!r.ok) { say(r.error, true); return; }
        commit(r.text); paint();
        window.getSelection?.()?.removeAllRanges?.();
        say(`Trou ajouté : il deviendra la carte n° ${r.n}.`);
      };
      bar.append(add);
    }
    editor.addEventListener('input', sync);
    editor.addEventListener('keyup', refresh);
    editor.addEventListener('mouseup', refresh);
    // Collage : toujours en texte simple (ni styles, ni liens, ni images).
    editor.addEventListener('paste', e => {
      e.preventDefault();
      exec('insertText', e.clipboardData?.getData('text/plain') || '');
    });
    area.addEventListener('input', () => { if (!fromEditor) paint(); });
    box.append(bar, editor, msg);
    paint();
    return {box, editor, paint};
  }
  globalThis.AnkiRich = Object.freeze({richEditor, renderEditable, selectionInSource});
})();
