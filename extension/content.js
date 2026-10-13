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
        btn.onclick = () => showModal(lot.cards, {parsed, lot, lots: lots.length});
      });
      const noteText = parseNote(parsed);
      let note = wrap.querySelector('.ankibridge-parsenote');
      if (noteText) {
        if (!note) { note = document.createElement('span'); note.className = 'ankibridge-parsenote'; wrap.append(note); }
        if (note.textContent !== noteText) note.textContent = noteText;
      } else note?.remove();
    }
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  // Comparaison insensible à la casse ET aux accents, sur le chemin complet.
  // Les ligatures (œ, æ) sont dépliées : « coeur » doit trouver « cœur ».
  const normText = s => String(s ?? '').replace(/œ/gi, 'oe').replace(/æ/gi, 'ae')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  // AnkiConnect renvoie « Parent::Enfant ». On n'affiche qu'un libellé lisible ;
  // la valeur transmise reste EXACTEMENT le nom complet du paquet.
  const deckLabel = name => String(name).split('::').map(s => s.trim()).filter(Boolean).join(' › ');
  const MAX_OPTIONS = 50;
  /* Choix de paquet RECHERCHABLE : combobox accessible (rôle combobox + listbox).
     Taper filtre la liste ; seule une sélection réelle (clic ou Entrée) appelle
     onChoose, donc l'analyse ne se relance jamais à chaque caractère. */
  function createDeckPicker(names, onChoose) {
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
    let shown = [];
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
    function paint(query) {
      const found = filtered(query);
      shown = found.slice(0, MAX_OPTIONS);
      list.replaceChildren();
      if (!shown.length) {
        const empty = el('li','ankibridge-deckempty','Aucun résultat');
        empty.setAttribute('role','presentation');
        list.append(empty);
      } else {
        shown.forEach(name => {
          const li = el('li','ankibridge-deckoption', deckLabel(name));
          li.setAttribute('role','option');
          li.setAttribute('aria-selected', name === current ? 'true' : 'false');
          li.setAttribute('id', 'ankibridge-opt-' + (++seq));
          li.dataset.value = name;
          li.addEventListener('mousedown', e => e.preventDefault());
          li.onclick = () => choose(name);
          list.append(li);
        });
        if (found.length > shown.length) {
          const more = el('li','ankibridge-deckmore', `${found.length - shown.length} autre(s) paquet(s) — précise la recherche`);
          more.setAttribute('role','presentation');
          list.append(more);
        }
      }
      active = -1;
      input.removeAttribute('aria-activedescendant');
    }
    function highlight() {
      const opts = list.querySelectorAll('.ankibridge-deckoption');
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
        if (!list.hidden && shown.length) { e.preventDefault(); choose(shown[active >= 0 ? active : 0]); }
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
  function askConfirm(dialog, title, lines) {
    return new Promise(resolve => {
      const box = el('div','ankibridge-confirm');
      box.setAttribute('role','alertdialog');
      box.append(el('h3','',title));
      for (const line of lines) box.append(el('p','',line));
      const actions = el('div','ankibridge-confirmactions');
      const ok = el('button','ankibridge-confirmok','Confirmer le remplacement');
      const cancel = el('button','ankibridge-cancel','Annuler');
      ok.type = 'button'; cancel.type = 'button';
      ok.onclick = () => { box.remove(); resolve(true); };
      cancel.onclick = () => { box.remove(); resolve(false); };
      actions.append(ok, cancel); box.append(actions); dialog.append(box);
    });
  }
  async function showModal(cards, info = {}) {
    document.querySelector('.ankibridge-overlay')?.remove();
    const overlay = el('div','ankibridge-overlay');
    const dialog = el('section','ankibridge-dialog'); dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true');
    const head = el('div','ankibridge-head');
    const lotLabel = info.lots > 1 ? ` (lot ${info.lot.from}–${info.lot.to})` : '';
    head.append(el('h2','',`Vérifier ${cards.length} cartes avant import${lotLabel}`));
    const close = el('button','ankibridge-close','×'); close.type='button'; close.setAttribute('aria-label','Fermer'); close.onclick=()=>closeModal();
    head.append(close); dialog.append(head);
    const main = el('div','ankibridge-main');
    const control = el('div','ankibridge-control');
    control.append(el('span','ankibridge-decklabel','Paquet Anki :'));
    const picker = createDeckPicker([], name => onDeckSelected(name));
    const analyze = el('button','ankibridge-review','Relancer la comparaison');
    analyze.type='button'; analyze.disabled=true;
    control.append(picker.root, analyze); main.append(control);
    // Sélection en masse : les cartes déjà présentes ne sont jamais cochées par défaut.
    const bulk = el('div','ankibridge-bulk');
    const selectNew = el('button','ankibridge-selectnew','Tout sélectionner (cartes nouvelles)');
    const selectNone = el('button','ankibridge-selectnone','Tout désélectionner');
    const count = el('span','ankibridge-count','0 sélectionnée(s)');
    selectNew.type='button'; selectNone.type='button';
    bulk.append(selectNew, selectNone, count); main.append(bulk);
    // Légende discrète : le statut ne repose jamais sur la seule couleur.
    const legend=el('div','ankibridge-legend');
    for(const [cls,word] of [['new','Nouvelle'],['similar','Formulation similaire'],['exact','Déjà présente (non réimportable)']]){
      const cell=el('span','ankibridge-legenditem');
      const d=el('span','ankibridge-dot '+cls);
      d.setAttribute('role','img'); d.setAttribute('aria-label',word);
      cell.append(d, document.createTextNode(' '+word));
      legend.append(cell);
    }
    main.append(legend);
    // Cartes écartées à la lecture : listées pour pouvoir les redemander à ChatGPT.
    const rejected = info.parsed?.rejected || [];
    if (rejected.length || info.parsed?.truncated) {
      const warn = el('details','ankibridge-rejected');
      const n = rejected.length;
      warn.append(el('summary','', [
        n ? `${n} carte${n>1?'s':''} ignorée${n>1?'s':''} car mal formée${n>1?'s':''}` : '',
        info.parsed?.truncated ? 'réponse de ChatGPT incomplète (dernière carte non terminée)' : ''
      ].filter(Boolean).join(' · ')));
      for (const r of rejected.slice(0, 20)) warn.append(el('p','',r.reason));
      if (n > 20) warn.append(el('p','',`… et ${n-20} autre(s).`));
      warn.append(el('p','ankibridge-rejectedhint','Astuce : demande à ChatGPT « Corrige ces cartes » ou « Continue à partir de la dernière carte », puis importe le nouveau bloc.'));
      main.append(warn);
    }
    const entries=[];
    cards.forEach((card,i)=>{
      /* Structure de ligne volontairement NON imbriquée : la case d'import et le
         point de statut sont FRÈRES de <details>, pas enfants de <summary>. Un
         input interactif placé dans un <summary> déclencherait l'ouverture du
         détail au clic et serait du HTML interactif imbriqué. Ici :
         - cliquer la case sélectionne (elle est hors de <summary>) ;
         - cliquer le titre ou le chevron déplie/replie le détail (natif). */
      const row=el('div','ankibridge-row');
      const check=el('input','ankibridge-pick');
      // Rien n'est sélectionnable avant que la comparaison ait abouti : tant que la
      // liste des paquets n'est pas connue, une case cochée serait un mensonge.
      check.type='checkbox'; check.checked=false; check.disabled=true;
      check.setAttribute('aria-label',`Sélectionner la carte ${i+1} pour l'import`);
      const dot=el('span','ankibridge-dot pending');
      dot.setAttribute('role','img');
      dot.setAttribute('aria-label','Comparaison en cours');
      dot.setAttribute('title','Comparaison en cours');
      const status=el('span','ankibridge-sr','Comparaison en cours');
      status.setAttribute('id',`ankibridge-status-${i}`);
      check.setAttribute('aria-describedby',`ankibridge-status-${i}`);
      const details=el('details','ankibridge-card');
      const summary=el('summary');
      const typeLabel=card.type==='cloze'?'[Texte à trous] ':'[Basique] ';
      const title=el('span','ankibridge-title',`${i+1}. ${typeLabel}${(card.front||card.text).slice(0,140)}`);
      summary.append(title); details.append(summary);
      const notice=el('div','ankibridge-notice','Comparaison avec Anki en cours…');
      details.append(notice);
      const firstLabel=el('label','',card.type==='cloze'?'Texte à trous ({{c1::...}})':'Question');
      const first=el('textarea'); first.value=card.type==='cloze'?card.text:card.front; firstLabel.append(first);
      const secondLabel=el('label','',card.type==='cloze'?'Précisions facultatives':'Réponse');
      const second=el('textarea'); second.value=card.type==='cloze'?card.extra:card.back; secondLabel.append(second);
      details.append(firstLabel,secondLabel);
      // Bloc « remplacer » : vide tant qu'aucune note certaine n'est identifiée.
      const replaceRow=el('div','ankibridge-replacerow'); details.append(replaceRow);
      row.append(check, dot, status, details);
      main.append(row);
      entries.push({card,check,dot,status,title,first,second,notice,details,replaceRow,replace:null,item:null,kind:null});
    });
    dialog.append(main);
    const foot=el('div','ankibridge-foot'); const msg=el('span','ankibridge-msg','Anki doit être ouvert. Aucune donnée ne part vers un service tiers.');
    const replaceBtn=el('button','ankibridge-replace','Remplacer les notes existantes'); replaceBtn.type='button'; replaceBtn.disabled=true;
    const save=el('button','ankibridge-action','Importer dans Anki'); save.type='button'; save.disabled=true;
    const currentCards=()=>entries.map(e=>({
      ...e.card,
      ...(e.card.type==='cloze'?{text:e.first.value.trim(),extra:e.second.value.trim()}:
        {front:e.first.value.trim(),back:e.second.value.trim()})
    }));
    let verified=false;
    let revision=0;
    let lastReport=null;
    let analysisSeq=0;      // jeton anti-course : tout résultat périmé est ignoré
    let debounceTimer=null;
    const updateCount=()=>{
      const n=entries.filter(e=>e.check.checked).length;
      count.textContent=`${n} sélectionnée(s) sur ${entries.length}`;
    };
    const updateReplaceState=()=>{
      const n=entries.filter(e=>e.replace?.checked).length;
      replaceBtn.disabled = !verified || n===0;
      replaceBtn.textContent = n ? `Remplacer ${n} note(s) existante(s)` : 'Remplacer les notes existantes';
    };
    for(const e of entries) e.check.addEventListener('change',()=>{updateCount();updateReplaceState();});
    selectNew.onclick=()=>{for(const e of entries)e.check.checked=(e.kind==='new');updateCount();updateReplaceState();};
    selectNone.onclick=()=>{for(const e of entries)e.check.checked=false;updateCount();updateReplaceState();};
    // Statut d'une carte : libellé textuel + point coloré, jamais la couleur seule.
    const STATUS={new:['Nouvelle','ankibridge-dot new'],similar:['Formulation similaire','ankibridge-dot similar'],exact:['Déjà présente','ankibridge-dot exact']};
    const setStatus=(e,kind)=>{
      const [word,cls]=STATUS[kind]||STATUS.new;
      e.dot.className=cls;
      e.dot.setAttribute('aria-label',word);
      e.dot.setAttribute('title',word);
      e.status.textContent=word;
    };
    // État intermédiaire neutre : aucune couleur de statut tant que la comparaison
    // n'a pas abouti, et case d'import désactivée (rien n'est encore vérifié).
    const setPending=()=>{for(const e of entries){
      e.dot.className='ankibridge-dot pending';
      e.dot.setAttribute('aria-label','Comparaison en cours');
      e.dot.setAttribute('title','Comparaison en cours');
      e.status.textContent='Comparaison en cours';
      e.check.disabled=true;
    }};
    // Après une écriture, les conclusions de l'analyse ne valent plus : les points
    // repassent en état neutre « à revérifier » au lieu de rester verts ou rouges.
    const setStale=()=>{for(const e of entries){
      e.dot.className='ankibridge-dot pending';
      e.dot.setAttribute('aria-label','À revérifier');
      e.dot.setAttribute('title','À revérifier');
      e.status.textContent='À revérifier';
      e.notice.className='ankibridge-notice';
      e.notice.textContent='Écriture effectuée : relance la comparaison pour revérifier cette carte.';
    }};
    // Dès l'ouverture, AVANT que la liste des paquets soit connue : aucune case
    // cochable, aucun statut coloré. Si le chargement des paquets échoue, l'import
    // reste impossible au lieu de laisser croire à une sélection valide.
    setPending(); updateCount();
    // AnkiConnect renvoie des chemins complets « Parent::Enfant ». On n'affiche qu'un
    // libellé lisible ; la valeur de l'option reste EXACTEMENT le nom complet.
    const deckLabel=name=>String(name).split('::').map(s=>s.trim()).filter(Boolean).join(' › ');
    let closed=false;
    // La fenêtre est « vivante » tant qu'elle n'a pas été fermée et qu'elle est
    // encore attachée au document : aucune analyse ne doit se poursuivre ni
    // s'appliquer sur un dialogue détaché.
    const alive=()=>!closed&&!!overlay.parentElement;
    const invalidate=({resetChecks=false,why}={})=>{revision++;analysisSeq++;verified=false;lastReport=null;save.disabled=true;
      // Une analyse en vol est abandonnée : on rend la main tout de suite, sinon
      // le bouton resterait désactivé indéfiniment après une édition.
      analyze.disabled=false;
      if(resetChecks)for(const e of entries){e.check.checked=true;e.notice.replaceChildren();}
      for(const e of entries){e.replaceRow.replaceChildren();e.replace=null;}
      replaceBtn.disabled=true; replaceBtn.textContent='Remplacer les notes existantes';
      msg.textContent=why||'Cartes modifiées : relancer la comparaison avant import.';
      for(const e of entries)e.notice.textContent='Non vérifié depuis la dernière modification.';
      setPending();
      updateCount();
    };
    for(const e of entries){e.first.addEventListener('input',()=>invalidate());e.second.addEventListener('input',()=>invalidate());}
    // Détail d'un doublon : identifiant, paquet EXACT (même hors de la spécialité
    // choisie) et modèle. Plusieurs résultats sont TOUS listés, jamais arbitrés.
    const duplicateBlock=item=>{
      const box=el('div','ankibridge-dup');
      for(const d of item.duplicates){
        const where=d.deck?`paquet « ${deckLabel(d.deck)} »`:'paquet inconnu';
        const head=el('p','ankibridge-duphead',`Note #${d.id} — ${where}${d.model?` (modèle ${d.model})`:''}`+
          (d.certain?'':' — ressemblance, non certaine')+(d.score!=null?` (${Math.round(d.score*100)} % lexical)`:'')); 
        box.append(head);
        box.append(el('p','ankibridge-dupfield',`Recto : ${d.front||'(vide)'}`));
        if(d.back)box.append(el('p','ankibridge-dupfield',`Verso : ${d.back}`));
        if(Array.isArray(d.tags)&&d.tags.length)box.append(el('p','ankibridge-dupfield',`Tags : ${d.tags.join(', ')}`));
      }
      return box;
    };
    // Bloc de remplacement : proposé UNIQUEMENT pour une note certaine, unique et
    // de modèle compatible. Rien n'est coché par défaut.
    const buildReplaceRow=(e,item)=>{
      e.replaceRow.replaceChildren();
      e.replace=null;
      if(!item.replaceable||item.duplicates.length!==1)return;
      const m=item.duplicates[0];
      const wanted=[e.first.value.trim(),e.second.value.trim()];
      const changes=[];
      if((m.front||'')!==wanted[0])changes.push({label:e.card.type==='cloze'?'Texte':'Question',from:m.front||'(vide)',to:wanted[0]});
      if((m.back||'')!==wanted[1])changes.push({label:e.card.type==='cloze'?'Précisions':'Réponse',from:m.back||'(vide)',to:wanted[1]});
      const row=el('div','ankibridge-replacebox');
      const label=el('label','ankibridge-replacepick');
      const box=el('input'); box.type='checkbox'; box.className='ankibridge-replacebox-input';
      box.setAttribute('aria-label',`Remplacer la note ${m.id}`);
      label.append(box, document.createTextNode(` Remplacer la note #${m.id} — paquet « ${deckLabel(m.deck)} » (modèle ${m.model})`));
      row.append(label);
      row.append(el('p','ankibridge-replacehint','Identifiant, paquet, planning de révision et tags sont conservés ; seuls les champs ci-dessous sont réécrits.'));
      if(!changes.length){
        box.disabled=true;
        row.append(el('p','ankibridge-diff','Aucun champ ne diffère : rien à remplacer pour cette carte.'));
      } else {
        const diff=el('div','ankibridge-diff');
        diff.append(el('p','ankibridge-difftitle','Aperçu avant → après'));
        for(const c of changes){
          diff.append(el('p','ankibridge-diffline',`${c.label} — avant : ${c.from}`));
          diff.append(el('p','ankibridge-diffline after',`${c.label} — après : ${c.to}`));
        }
        row.append(diff);
      }
      box.addEventListener('change',updateReplaceState);
      e.replaceRow.append(row);
      e.replace=box;
    };
    const runAnalysis=async()=>{
      if(!alive())return;
      const token=++analysisSeq;
      const atStart=revision;
      analyze.disabled=true; save.disabled=true; replaceBtn.disabled=true;
      setPending();
      msg.textContent=`Comparaison avec « ${deckLabel(picker.value)} » (et ses sous-paquets)…`;
      try {
        const current=AnkiCards.toCards({cards:currentCards()});
        const report=await api('ANALYZE',{deck:picker.value,cards:current});
        // Résultat périmé, ou fenêtre fermée pendant l'appel : on l'ignore.
        if(!alive()||token!==analysisSeq||atStart!==revision)return;
        verified=true;
        lastReport=report;
        let exact=0, similar=0, replaceable=0;
        report.items.forEach((item,i)=>{
          const e=entries[i];
          e.item=item; e.kind=item.kind;
          // Le statut s'affiche immédiatement, sans ouvrir la ligne.
          setStatus(e,item.kind);
          // Un doublon certain n'est jamais importable : case désactivée ET décochée.
          e.check.disabled=(item.kind==='exact');
          e.notice.replaceChildren();
          e.notice.className='ankibridge-notice '+item.kind;
          if(item.kind==='exact'){
            e.check.checked=false; exact++;
            e.notice.textContent='Doublon exact déjà présent dans la collection (ou répété dans ce lot) : ignoré à l\'import.';
            if(item.duplicates.length)e.notice.append(duplicateBlock(item));
            e.notice.append(el('p','ankibridge-dupnote',item.note));
          } else if(item.kind==='similar'){
            similar++;
            e.check.checked=false; // Décochée par précaution, réactivable explicitement.
            e.notice.textContent='Formulation proche détectée. Non cochée par précaution : à vérifier avant de la réactiver.';
            e.notice.append(duplicateBlock(item));
          } else {
            // Carte neuve : pré-sélectionnée pour l'import, comme avant l'analyse.
            e.check.checked=true;
            e.notice.textContent='Aucun doublon détecté dans la zone analysée.';
          }
          buildReplaceRow(e,item);
          if(item.replaceable)replaceable++;
        });
        updateCount();
        updateReplaceState();
        msg.textContent=`${report.totalExisting} notes existantes (${report.scanned} analysées) • ${exact} doublon(s) certain(s), ${similar} ressemblance(s) à relire`+
          (replaceable?`, ${replaceable} remplacement(s) possible(s)`:'')+'.'+
          (report.partial?' Attention : analyse de similarité PARTIELLE, collection trop volumineuse. Les doublons exacts restent vérifiés globalement.':'')+
          ' Une ressemblance de formulation ne garantit pas que les informations sont identiques.';
        save.disabled=false;
      } catch(e){
        if(!alive()||token!==analysisSeq)return;
        verified=false;
        msg.textContent=`Comparaison impossible : ${e.message} — clique sur « Relancer la comparaison ».`;
      }
      finally{ if(alive()&&token===analysisSeq) analyze.disabled=false; }
    };
    analyze.onclick=runAnalysis;
    // Changer de paquet relance la comparaison automatiquement (jamais d'import
    // ni de remplacement basé sur les conclusions du paquet précédent).
    const onDeckSelected=name=>{
      if(name===lastAnalyzedDeck&&verified)return;
      lastAnalyzedDeck=name;
      invalidate({resetChecks:true,why:`Paquet changé : comparaison de « ${deckLabel(name)} » en cours…`});
      clearTimeout(debounceTimer);
      debounceTimer=setTimeout(runAnalysis,250);
    };
    let lastAnalyzedDeck='';
    foot.append(msg,replaceBtn,save);dialog.append(foot); overlay.append(dialog); document.body.append(overlay);
    // Fermer la fenêtre abandonne l'analyse en vol : sans cela, une comparaison
    // lancée juste avant la fermeture continuerait de coûter des appels Anki.
    const closeModal=()=>{closed=true;analysisSeq++;verified=false;clearTimeout(debounceTimer);overlay.remove();};
    overlay.addEventListener('click',e=>{if(e.target===overlay) closeModal();});
    const esc=(e)=>{if(e.key==='Escape'){closeModal();document.removeEventListener('keydown',esc);}};
    document.addEventListener('keydown',esc);
    try {
      const names=await api('DECKS');
      if(!alive())return;                 // fenêtre fermée pendant le chargement des paquets
      picker.setNames(names);
      const saved=await chrome.storage.local.get('deck');
      if(!alive())return;
      if(!names.length)throw new Error('Aucun paquet Anki disponible. Crée un paquet dans Anki.');
      picker.setValue(names.includes(saved.deck)?saved.deck:names[0]);
      lastAnalyzedDeck=picker.value;
      analyze.disabled=false;
      runAnalysis();            // comparaison automatique dès l'ouverture de la fenêtre
    } catch(e){if(alive())msg.textContent=`Erreur : ${e.message}`;}
    // Remplacement : liste sélectionnée explicitement, aperçu affiché, confirmation
    // obligatoire. Annuler ne déclenche AUCUNE écriture.
    replaceBtn.onclick=async()=>{
      try{
        if(!verified)throw new Error('Comparer les cartes à Anki avant tout remplacement.');
        // L'aperçu est RECALCULÉ au moment du clic : une carte devenue identique
        // (aucun champ à changer) n'est jamais confirmée ni écrite.
        const rows=entries
          .filter(e=>e.replace?.checked&&e.item?.replaceable&&e.item.duplicates.length===1)
          .map(e=>({e,m:e.item.duplicates[0]}))
          .map(({e,m})=>{
            const wanted=[e.first.value.trim(),e.second.value.trim()];
            const changes=[];
            if((m.front||'')!==wanted[0])changes.push({label:e.card.type==='cloze'?'Texte':'Question',from:m.front||'(vide)',to:wanted[0]});
            if((m.back||'')!==wanted[1])changes.push({label:e.card.type==='cloze'?'Précisions':'Réponse',from:m.back||'(vide)',to:wanted[1]});
            return {e,m,wanted,changes};
          });
        const noop=rows.filter(r=>!r.changes.length);
        const selected=rows.filter(r=>r.changes.length);
        if(!selected.length)throw new Error(noop.length
          ?'Aucun champ ne diffère pour les notes cochées : rien à remplacer.'
          :'Aucune note cochée pour remplacement.');
        const lines=[
          `${selected.length} note(s) existante(s) vont être modifiées dans Anki.`,
          'Identifiant de note, paquet d\'origine, planning de révision et tags sont conservés ; seuls les champs listés ci-dessous sont réécrits.',
          'Le contenu actuel de ces champs sera écrasé. Aucune note n\'est supprimée ni déplacée.',
        ];
        for(const {e,m,changes} of selected.slice(0,6)){
          lines.push(`Note #${m.id} — paquet « ${deckLabel(m.deck)} » (modèle ${m.model}) : `+
            changes.map(c=>`${c.label} « ${c.from} » → « ${c.to} »`).join(' ; '));
        }
        if(selected.length>6)lines.push(`… et ${selected.length-6} autre(s).`);
        if(noop.length)lines.push(`${noop.length} note(s) cochée(s) sans changement : elles ne seront pas touchées.`);
        const ok=await askConfirm(dialog,`Confirmer le remplacement de ${selected.length} note(s) ?`,lines);
        if(!ok){msg.textContent='Remplacement annulé : aucune écriture effectuée.';return;}
        const replacements=selected.map(({e,m,wanted})=>({noteId:m.id,model:m.model,deck:m.deck,decks:m.decks,type:e.card.type,
          // Champs complets (non tronqués) : les versions courtes ne servent qu'à l'affichage.
          fingerprint:m.frontFull||m.front,originalSecond:m.secondFull??m.second,mod:m.mod,first:wanted[0],second:wanted[1]}));
        replaceBtn.disabled=true; save.disabled=true;
        msg.textContent=`Remplacement en cours : ${replacements.length} note(s)…`;
        const r=await api('REPLACE',{replacements});
        msg.textContent=`${r.updated} note(s) mise(s) à jour, ${r.skipped} sans changement`+
          (r.failed.length?`, ${r.failed.length} refusée(s) : ${r.failed.map(f=>`#${f.noteId} ${f.reason}`).join(' | ')}`:'')+'.';
        // Les conclusions de l'analyse ne sont plus valables après écriture.
        verified=false; save.disabled=true; replaceBtn.disabled=true;
        analyze.disabled=false;
        setStale();
      }catch(e){msg.textContent=`Erreur : ${e.message}`;replaceBtn.disabled=!verified;}
    };
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
        save.disabled=true; analyze.disabled=true; replaceBtn.disabled=true;
        msg.textContent=`Import en cours : ${selected.length} carte(s)...`;
        await chrome.storage.local.set({deck:picker.value});
        const r=await api('IMPORT',{deck:picker.value,cards:selected});
        msg.textContent=`${r.added} ajoutée(s), ${r.skipped} doublon(s) ignoré(s).`+
          (r.errors.length ? `\n${r.errors.join('\n')}` : ' Révise ensuite dans Anki.');
        save.textContent='Import terminé';
        // Ne jamais réimporter accidentellement la même sélection après un premier lot.
        verified=false;
        analyze.disabled=false;
        setStale();
      }catch(e){msg.textContent=`Erreur : ${e.message}`;save.disabled=false;analyze.disabled=false;}
    };
    updateCount();
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
