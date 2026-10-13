'use strict';
/* Éditeur visuel des textes à trous de la fenêtre de vérification : plus de
   {{c1::…}} à écrire ni à lire. Le texte est affiché mis en forme, chaque trou
   est une case contenant la réponse attendue, une sélection devient un trou.
   Les modifications passent par les fonctions pures de shared.js, qui refusent
   tout résultat cassant un trou ou une mise en forme. DOM sûr uniquement. */
(() => {
  const {renderClozeEditor, setClozeAnswer, removeCloze, addCloze} = AnkiShared;
  const {el} = AnkiPicker;
  /* Position dans le texte source d'une frontière de sélection : chaque morceau de
     texte de l'éditeur porte data-o (son début dans la source). */
  function sourceOffset(node, offset) {
    const srcOf = n => n && n.nodeType === 1 ? (n.matches('.ankibridge-src') ? n : n.querySelector('.ankibridge-src')) : null;
    if (node && node.nodeType === 3) {
      const span = node.parentElement;
      return span && span.classList.contains('ankibridge-src') ? Number(span.getAttribute('data-o')) + offset : null;
    }
    if (node && node.nodeType === 1) {
      if (node.classList.contains('ankibridge-src')) return Number(node.getAttribute('data-o')) + (offset ? node.textContent.length : 0);
      const kids = Array.from(node.childNodes || []);
      const after = kids.slice(offset).map(srcOf).find(Boolean);
      if (after) return Number(after.getAttribute('data-o'));
      const before = kids.slice(0, offset).reverse().map(k => {
        if (!k || k.nodeType !== 1) return null;
        const all = k.matches('.ankibridge-src') ? [k] : Array.from(k.querySelectorAll('.ankibridge-src'));
        return all[all.length - 1] || null;
      }).find(Boolean);
      if (before) return Number(before.getAttribute('data-o')) + before.textContent.length;
    }
    return null;
  }
  function selectionRange(editor) {
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!editor.contains(r.startContainer) || !editor.contains(r.endContainer)) return null;
    const a = sourceOffset(r.startContainer, r.startOffset), b = sourceOffset(r.endContainer, r.endOffset);
    return a === null || b === null ? null : [a, b];
  }
  /* Texte à trous SANS syntaxe à écrire : le texte s'affiche mis en forme et chaque
     trou est une case contenant la réponse attendue. On crée un trou en
     sélectionnant un mot, on le retire avec « × ». La zone de texte brut reste la
     source (et reste accessible par « Modifier le texte »). */
  function holeEditor(area, rawField) {
    const box = el('div','ankibridge-holes');
    const head = el('div','ankibridge-holeshead');
    head.append(el('span','ankibridge-holescap','Texte à trous — chaque case contient la réponse à retrouver'));
    const toggle = el('button','ankibridge-holestoggle','Modifier le texte');
    toggle.type = 'button';
    head.append(toggle);
    const editor = el('div','ankibridge-holeeditor');
    editor.setAttribute('role','group');
    editor.setAttribute('aria-label','Texte à trous, réponses modifiables');
    const actions = el('div','ankibridge-holeactions');
    const add = el('button','ankibridge-holeadd','Transformer la sélection en trou');
    add.type = 'button';
    const msg = el('span','ankibridge-holemsg');
    msg.setAttribute('role','status');
    actions.append(add, msg);
    box.append(head, editor, actions);
    let fromEditor = false;
    const commit = text => {
      fromEditor = true;
      area.value = text;
      area.dispatchEvent(new Event('input', {bubbles: true}));
      fromEditor = false;
    };
    const say = (text, bad) => { msg.textContent = text; msg.className = 'ankibridge-holemsg' + (bad ? ' bad' : ''); };
    const paint = () => {
      const n = renderClozeEditor(editor, area.value, document, {
        onAnswer: (k, value, wrap, input) => {
          const r = setClozeAnswer(area.value, k, value, wrap);
          if (!r.ok) { input.classList.add('invalid'); input.setAttribute('aria-invalid','true'); say(r.error, true); return; }
          input.classList.remove('invalid'); input.removeAttribute('aria-invalid'); say('');
          commit(r.text);
        },
        onRemove: k => {
          const r = removeCloze(area.value, k);
          if (!r.ok) { say(r.error, true); return; }
          commit(r.text); paint();
          say('Trou retiré : le texte reste dans la carte.');
        }
      });
      if (!n) say('Aucun trou : sélectionne un mot dans le texte, puis « Transformer la sélection en trou ».', true);
      return n;
    };
    add.addEventListener('mousedown', e => e.preventDefault());   // garde la sélection
    add.onclick = () => {
      const range = selectionRange(editor);
      if (!range) { say('Sélectionne d’abord un mot ou une expression dans le texte ci-dessus.', true); return; }
      const r = addCloze(area.value, range[0], range[1]);
      if (!r.ok) { say(r.error, true); return; }
      commit(r.text); paint();
      window.getSelection?.()?.removeAllRanges?.();
      say(`Trou ajouté : il deviendra la carte n° ${r.n}.`);
    };
    const setMode = raw => {
      editor.hidden = raw; actions.hidden = raw; rawField.hidden = !raw;
      toggle.textContent = raw ? 'Revenir aux trous' : 'Modifier le texte';
      toggle.setAttribute('aria-pressed', raw ? 'true' : 'false');
      if (!raw) paint();
    };
    toggle.onclick = () => setMode(!editor.hidden);
    area.addEventListener('input', () => { if (!fromEditor && !editor.hidden) paint(); });
    setMode(false);
    return box;
  }
  globalThis.AnkiHoles = Object.freeze({holeEditor, selectionRange, sourceOffset});
})();
