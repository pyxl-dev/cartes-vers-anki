'use strict';
(() => {
  const api = (type, extra={}) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({type,...extra}, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || 'Connexion indisponible'));
      resolve(res.value);
    });
  });
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
  function scan() {
    const messages = assistantMessageContainers();
    for (const message of messages) {
      const blocks = message.querySelectorAll('pre code, pre');
      let cards = null;
      for (const block of blocks) {
        try { cards = AnkiCards.toCards(block.textContent); } catch (_) { /* contenu ordinaire */ }
        if (cards) break;
      }
      if (!cards) { message.querySelector('.ankibridge-btn')?.remove(); continue; }
      let btn = message.querySelector('.ankibridge-btn');
      if (!btn) {
        btn = document.createElement('button'); btn.type = 'button'; btn.className = 'ankibridge-btn';
        const anchor = message.querySelector('pre') || message;
        anchor.insertAdjacentElement('afterend', btn);
      }
      const label = `Ajouter ${cards.length} carte${cards.length>1?'s':''} à Anki`;
      if (btn.textContent !== label) btn.textContent = label;
      btn.onclick = () => showModal(cards);
    }
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  async function showModal(cards) {
    document.querySelector('.ankibridge-overlay')?.remove();
    const overlay = el('div','ankibridge-overlay');
    const dialog = el('section','ankibridge-dialog'); dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true');
    const head = el('div','ankibridge-head');
    head.append(el('h2','',`Vérifier ${cards.length} cartes avant import`));
    const close = el('button','ankibridge-close','×'); close.type='button'; close.setAttribute('aria-label','Fermer'); close.onclick=()=>overlay.remove();
    head.append(close); dialog.append(head);
    const main = el('div','ankibridge-main');
    const control = el('div','ankibridge-control');
    control.append(el('span','', 'Paquet Anki :'));
    const select=el('select'); select.setAttribute('aria-label','Paquet Anki');
    const placeholder=el('option','', 'Chargement des paquets...'); placeholder.value=''; select.append(placeholder);
    const analyze=el('button','ankibridge-review','Comparer aux cartes existantes');
    analyze.type='button'; analyze.disabled=true;
    control.append(select,analyze); main.append(control);
    const entries=[];
    cards.forEach((card,i)=>{
      const details=el('details','ankibridge-card');
      const summary=el('summary');
      const check=el('input'); check.type='checkbox'; check.checked=true;
      check.addEventListener('click', e=>e.stopPropagation());
      summary.append(check, document.createTextNode(` ${i+1}. ${card.type==='cloze'?'[Texte à trous] ':''}${(card.front||card.text).slice(0,115)}`));
      details.append(summary);
      const notice=el('div','ankibridge-notice','En attente de comparaison avec Anki.');
      details.append(notice);
      const firstLabel=el('label','',card.type==='cloze'?'Texte à trous ({{c1::...}})':'Question');
      const first=el('textarea'); first.value=card.type==='cloze'?card.text:card.front; firstLabel.append(first);
      const secondLabel=el('label','',card.type==='cloze'?'Précisions facultatives':'Réponse');
      const second=el('textarea'); second.value=card.type==='cloze'?card.extra:card.back; secondLabel.append(second);
      details.append(firstLabel,secondLabel); main.append(details);
      entries.push({card,check,first,second,notice,details});
    });
    dialog.append(main);
    const foot=el('div','ankibridge-foot'); const msg=el('span','ankibridge-msg','Anki doit être ouvert. Aucune donnée ne part vers un service tiers.');
    const save=el('button','ankibridge-action','Importer dans Anki'); save.type='button'; save.disabled=true;
    const currentCards=()=>entries.map(e=>({
      ...e.card,
      ...(e.card.type==='cloze'?{text:e.first.value.trim(),extra:e.second.value.trim()}:
        {front:e.first.value.trim(),back:e.second.value.trim()})
    }));
    let verified=false;
    let revision=0;
    let lastReport=null;
    const invalidate=()=>{revision++;verified=false;lastReport=null;save.disabled=true;
      msg.textContent='Cartes modifiées : relancer la comparaison avant import.';
      for(const e of entries)e.notice.textContent='Non vérifié depuis la dernière modification.';
    };
    for(const e of entries){e.first.addEventListener('input',invalidate);e.second.addEventListener('input',invalidate);}
    select.addEventListener('change',invalidate);
    analyze.onclick=async()=>{
      const atStart=revision;
      analyze.disabled=true; save.disabled=true;
      msg.textContent='Comparaison avec les notes du paquet (et de ses sous-paquets)...';
      try {
        const current=AnkiCards.toCards({cards:currentCards()});
        const report=await api('ANALYZE',{deck:select.value,cards:current});
        if(atStart!==revision){msg.textContent='Cartes modifiées pendant le scan ; relance la comparaison.';return;}
        verified=true;
        lastReport=report;
        let exact=0, similar=0;
        report.items.forEach((item,i)=>{
          const e=entries[i];
          e.notice.replaceChildren();
          if(item.kind==='exact'){
            e.check.checked=false; exact++;
            e.notice.textContent='Doublon exact déjà présent dans la collection (ou répété dans ce lot) : ignoré.';
            e.notice.className='ankibridge-notice duplicate';e.details.open=true;
          } else if(item.kind==='similar'){
            similar++;
            e.check.checked=false; // Reste modifiable : éviter les faux positifs médicaux.
            e.notice.className='ankibridge-notice similar';e.details.open=true;
            e.notice.textContent='Formulation proche détectée. Non cochée par précaution. À vérifier :';
            for(const m of item.matches){
              const p=el('p','',`Note #${m.id} (${Math.round(m.score*100)} % lexical) : ${m.front}`);
              e.notice.append(p);
            }
          } else {
            e.notice.className='ankibridge-notice new';
            e.notice.textContent='Aucun doublon détecté dans la zone analysée.';
          }
        });
        msg.textContent=`${report.totalExisting} notes existantes (${report.scanned} analysées) • ${exact} doublon(s) certain(s), ${similar} ressemblance(s) à relire.`+
          (report.partial?' Attention : analyse de similarité PARTIELLE, collection trop volumineuse. Les doublons exacts restent vérifiés globalement.':'')+
          ' Les ressemblances ne prouvent pas que le fait médical est identique.';
        save.disabled=false;
      } catch(e){verified=false;msg.textContent='Comparaison impossible : '+e.message;}
      finally{analyze.disabled=false;}
    };
    foot.append(msg,save);dialog.append(foot); overlay.append(dialog); document.body.append(overlay);
    overlay.addEventListener('click',e=>{if(e.target===overlay) overlay.remove();});
    const esc=(e)=>{if(e.key==='Escape'){overlay.remove();document.removeEventListener('keydown',esc);}};
    document.addEventListener('keydown',esc);
    try {
      const names=await api('DECKS');
      select.replaceChildren();
      names.forEach(name=>{const opt=el('option','',name);opt.value=name;select.append(opt);});
      const saved=await chrome.storage.local.get('deck');
      if(names.includes(saved.deck))select.value=saved.deck;
      if(!names.length)throw new Error('Aucun paquet Anki disponible. Crée un paquet dans Anki.');
      analyze.disabled=false;
    } catch(e){msg.textContent=`Erreur : ${e.message}`;placeholder.textContent='Anki indisponible';}
    save.onclick=async()=>{
      try {
        if(!verified)throw new Error('Comparer les cartes à Anki avant de les importer.');
        const all=currentCards();
        const selected=all.filter((_,i)=>entries[i].check.checked);
        if(!selected.length){
          // Cas courant et non bloquant : la comparaison a décoché toutes les cartes
          // parce qu'elles existent déjà. Message neutre, pas une erreur de saisie.
          const allKnown = Array.isArray(lastReport?.items) && lastReport.items.length===entries.length
            && lastReport.items.every(it=>it.kind==='exact');
          if(allKnown){
            msg.textContent='Toutes les cartes existent déjà : aucune nouvelle carte ajoutée.';
            verified=false; save.disabled=true; analyze.disabled=false;
            return;
          }
          throw new Error('Aucune carte sélectionnée. Coche les cartes souhaitées.');
        }
        AnkiCards.toCards({cards:selected});
        save.disabled=true; analyze.disabled=true;
        msg.textContent=`Import en cours : ${selected.length} carte(s)...`;
        await chrome.storage.local.set({deck:select.value});
        const r=await api('IMPORT',{deck:select.value,cards:selected});
        msg.textContent=`${r.added} ajoutée(s), ${r.skipped} doublon(s) ignoré(s).`+
          (r.errors.length ? `\n${r.errors.join('\n')}` : ' Révise ensuite dans Anki.');
        save.textContent='Import terminé';
        // Ne jamais réimporter accidentellement la même sélection après un premier lot.
        verified=false;
        analyze.disabled=false;
      }catch(e){msg.textContent=`Erreur : ${e.message}`;save.disabled=false;analyze.disabled=false;}
    };
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
