'use strict';
/* Page ChatGPT : détection des cartes dans les réponses, boutons « Ajouter N
   cartes à Anki » et insertion du prompt demandée par le popup. La fenêtre de
   vérification elle-même vit dans review.js (chargé avant ce fichier). */
(() => {
  /* Localise les messages de l'assistant qui contiennent un bloc de code.
     ChatGPT.com a changé sa structure (2026) : [data-message-author-role] n'existe
     plus. Les conteneurs observés en production sont [data-dil-source-message-id]
     (texte de l'assistant) et [data-user-message-bubble] (texte de l'utilisateur).
     On exclut explicitement le message de l'utilisateur et on exige un bloc de code,
     pour ne jamais proposer d'import sur le texte saisi par la personne. L'ancien
     sélecteur reste en secours si le site revient à l'ancienne structure. */
  function assistantMessageContainers() {
    const legacy = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    const modern = Array.from(document.querySelectorAll('[data-dil-source-message-id]')).filter(el =>
      !el.closest('[data-user-message-bubble]') &&
      !el.querySelector('[data-user-message-bubble]') &&
      el.querySelector('pre code, pre')
    );
    return [...new Set([...legacy, ...modern])];
  }
  /* Un bouton inséré juste après <pre> devient une 2e colonne étirée quand ChatGPT
     place le bloc de code dans une grille ou un flex. On remonte donc TOUT l'arbre
     jusqu'au message en mémorisant le conteneur de mise en page le plus HAUT : c'est
     après lui qu'on insère, pour ne jamais devenir un item de grille. Le CSS
     neutralise le cas résiduel (grid-column / align-self). Aucun contenu n'est déplacé. */
  const isLayoutContainer = d => d === 'grid' || d === 'inline-grid' || d === 'flex' || d === 'inline-flex';
  function layoutSafeAnchor(pre, message) {
    if (!pre) return message;
    let anchor = pre;
    let node = pre;
    while (node.parentElement && node.parentElement !== message) {
      const parent = node.parentElement;
      let display = '';
      try { display = getComputedStyle(parent).display; } catch (_) { display = ''; }
      if (isLayoutContainer(display)) anchor = parent;   // on retient le plus haut
      node = parent;                                     // et on continue de remonter
    }
    return anchor;
  }
  /* Texte des blocs de code d'un message. On lit <code> en priorité : le <pre>
     de ChatGPT contient aussi l'en-tête « json · Copier le code ». Les blocs sont
     mis bout à bout : une réponse coupée puis reprise (« Continuer ») se recolle. */
  function codeText(message) {
    const codes = Array.from(message.querySelectorAll('pre code'));
    const blocks = codes.length ? codes : Array.from(message.querySelectorAll('pre'));
    return blocks.map(b => b.textContent || '').join('');
  }
  // Mémo par message : pendant l'écriture de la réponse, on ne réanalyse que si le texte a changé.
  const parsedCache = new WeakMap();
  function parsedFor(message) {
    const text = codeText(message);
    const hit = parsedCache.get(message);
    if (hit && hit.text === text) return hit.parsed;
    const parsed = AnkiCards.parse(text);
    parsedCache.set(message, {text, parsed});
    return parsed;
  }
  // Petite ligne d'explication sous le bouton : ce qui a été écarté, et pourquoi.
  function parseNote(parsed) {
    const parts = [];
    if (parsed.rejected.length) parts.push(`${parsed.rejected.length} carte${parsed.rejected.length>1?'s':''} mal formée${parsed.rejected.length>1?'s':''} ignorée${parsed.rejected.length>1?'s':''}`);
    if (parsed.truncated) parts.push('réponse incomplète : la dernière carte non terminée est ignorée');
    if (parsed.cards.length > AnkiCards.MAX_CARDS) parts.push(`import par lots de ${AnkiCards.MAX_CARDS}`);
    return parts.join(' · ');
  }
  function scan() {
    const messages = assistantMessageContainers();
    for (const message of messages) {
      const parsed = parsedFor(message);
      if (!parsed.cards.length) { message.querySelector('.ankibridge-actions')?.remove(); continue; }
      let wrap = message.querySelector('.ankibridge-actions');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'ankibridge-actions';
        const anchor = layoutSafeAnchor(message.querySelector('pre'), message);
        if (anchor === message) message.append(wrap);
        else anchor.insertAdjacentElement('afterend', wrap);
      }
      // Plus de 100 cartes : un bouton par lot de 100, chacun avec sa propre vérification.
      const lots = AnkiCards.chunks(parsed.cards);
      const labels = lots.map(lot => lots.length === 1
        ? `Ajouter ${lot.cards.length} carte${lot.cards.length>1?'s':''} à Anki`
        : `Lot ${lots.indexOf(lot)+1} : ajouter les cartes ${lot.from} à ${lot.to}`);
      let buttons = Array.from(wrap.querySelectorAll('.ankibridge-btn'));
      while (buttons.length > lots.length) buttons.pop().remove();
      while (buttons.length < lots.length) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ankibridge-btn';
        const info = wrap.querySelector('.ankibridge-parsenote');
        if (info) wrap.insertBefore(b, info); else wrap.append(b);
        buttons.push(b);
      }
      lots.forEach((lot, i) => {
        const btn = buttons[i];
        if (btn.textContent !== labels[i]) btn.textContent = labels[i];
        btn.onclick = () => AnkiReview.showModal(lot.cards, {parsed, lot, lots: lots.length});
      });
      const noteText = parseNote(parsed);
      let note = wrap.querySelector('.ankibridge-parsenote');
      if (noteText) {
        if (!note) { note = document.createElement('span'); note.className = 'ankibridge-parsenote'; wrap.append(note); }
        if (note.textContent !== noteText) note.textContent = noteText;
      } else note?.remove();
    }
  }
  // Appelé uniquement après un clic dans le popup de l'extension.
  // Ne soumet jamais le message : l'utilisatrice le relit avant l'envoi.
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== 'ANKI_INSERT_PROMPT') return;
    const editor = document.querySelector('#prompt-textarea[contenteditable="true"], #prompt-textarea [contenteditable="true"], [data-testid="prompt-textarea"][contenteditable="true"], [data-testid="prompt-textarea"] [contenteditable="true"], [role="textbox"][contenteditable="true"], textarea#prompt-textarea, textarea[data-testid="prompt-textarea"]');
    if (!editor) {
      reply({ok:false, error:'Champ de saisie ChatGPT introuvable. Recharge la page.'});
      return;
    }
    editor.focus();
    if (editor instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      const separator = editor.value.trim() ? '\n\n' : '';
      setter.call(editor, editor.value + separator + String(msg.prompt || ''));
      editor.dispatchEvent(new Event('input', {bubbles:true}));
      reply({ok:true});
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    const prompt = String(msg.prompt || '');
    const separator = editor.textContent.trim() ? '\n\n' : '';
    // execCommand déclenche les événements d'édition natifs attendus par les éditeurs riches.
    const success = document.execCommand('insertText', false, separator + prompt);
    reply(success ? {ok:true} : {ok:false,error:'Insertion non prise en charge par cette version de ChatGPT.'});
  });

  let scheduled = false;
  const scheduleScan=()=>{
    if(scheduled)return;scheduled=true;
    setTimeout(()=>{scheduled=false;scan();},500);
  };
  new MutationObserver(scheduleScan).observe(document.documentElement,{subtree:true,childList:true,characterData:true});
  scheduleScan();
})();
