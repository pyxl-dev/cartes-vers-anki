'use strict';
/* Fenêtre de vérification avant import : liste des cartes modifiables avec leur
   éditeur visuel, choix (ou création) du paquet,
   comparaison avec Anki, import et remplacement sûr.
   Ouverte par content.js (bouton sous la réponse de ChatGPT). Tout le contenu
   venant de ChatGPT ou d'Anki est inséré avec textContent, jamais comme du HTML. */
(() => {
  const {deckLabel, renderInto, sameDeck, stripMarkdown, validateDeckName, readableTitle} = AnkiShared;
  const {richEditor} = AnkiRich;
  const {createDeckPicker, askConfirm, themeControl, busy, el} = AnkiPicker;
  // Durée minimale de l'état « en cours » : même si Anki répond instantanément,
  // le clic produit un retour visible.
  const MIN_BUSY_MS = 300;
  const api = (type, extra={}) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({type,...extra}, res => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error || 'Connexion indisponible'));
      resolve(res.value);
    });
  });
  /* Le texte lu dans Anki (balises retirées, espaces réduits) et la carte saisie
     (Markdown) sont comparés sur la même base que le service worker : un simple
     changement de mise en forme n'est donc pas annoncé comme un remplacement. */
  const flat = x => String(x ?? '').replace(/\s+/g, ' ').trim();
  const sameText = (fromAnki, typed) => flat(fromAnki) === flat(stripMarkdown(typed));
  /* Un champ de carte : éditeur visuel par défaut (barre d'outils, trous en
     cases), « Texte brut » pour voir et modifier le texte exact avec son aperçu.
     La zone de texte reste la source dans les deux modes ; elle s'agrandit avec
     son contenu. */
  function fieldBlock(name, area, rawField, clozes) {
    const wrap = el('div','ankibridge-fieldwrap');
    const head = el('div','ankibridge-fieldhead');
    head.append(el('span','ankibridge-fieldname',name));
    const toggle = el('button','ankibridge-rawtoggle','Texte brut');
    toggle.type = 'button';
    toggle.setAttribute('title','Voir et modifier le texte exact envoyé à Anki');
    head.append(toggle);
    const rich = richEditor(area, {clozes, label: name});
    const grow = () => { area.style.height = 'auto'; area.style.height = Math.max(120, area.scrollHeight || 0) + 'px'; };
    area.addEventListener('input', grow);
    const setMode = raw => {
      rich.box.hidden = raw; rawField.hidden = !raw;
      toggle.textContent = raw ? 'Éditeur visuel' : 'Texte brut';
      toggle.setAttribute('aria-pressed', raw ? 'true' : 'false');
      if (raw) grow(); else rich.paint();
    };
    toggle.onclick = () => setMode(rawField.hidden);
    setMode(false);
    wrap.append(head, rich.box, rawField);
    return wrap;
  }
  async function showModal(cards, info = {}) {
    document.querySelector('.ankibridge-overlay')?.remove();
    const overlay = el('div','ankibridge-overlay');
    const dialog = el('section','ankibridge-dialog'); dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true');
    const head = el('div','ankibridge-head');
    const lotLabel = info.lots > 1 ? ` (lot ${info.lot.from}–${info.lot.to})` : '';
    head.append(el('h2','',`Vérifier ${cards.length} carte${cards.length>1?'s':''} avant import${lotLabel}`));
    const close = el('button','ankibridge-close','×'); close.type='button'; close.setAttribute('aria-label','Fermer'); close.onclick=()=>closeModal();
    const theme = themeControl(overlay);
    const headTools = el('div','ankibridge-headtools');
    headTools.append(theme.button, close);
    head.append(headTools); dialog.append(head);
    // Réglages en haut (paquet, sélection, légende) : toujours visibles ; seule
    // la liste des cartes défile en dessous.
    const top = el('div','ankibridge-top');
    dialog.append(top);
    const main = el('div','ankibridge-main');
    const control = el('div','ankibridge-control');
    control.append(el('span','ankibridge-decklabel','Paquet Anki :'));
    const picker = createDeckPicker([], name => onDeckSelected(name), {onCreate: name => onCreateDeck(name)});
    const analyze = el('button','ankibridge-review','Relancer la comparaison');
    analyze.type='button'; analyze.disabled=true;
    control.append(picker.root, analyze); top.append(control);
    // Sélection en masse : les cartes déjà présentes ne sont jamais cochées par défaut.
    const bulk = el('div','ankibridge-bulk');
    const selectNew = el('button','ankibridge-selectnew','Tout sélectionner (cartes nouvelles)');
    const selectNone = el('button','ankibridge-selectnone','Tout désélectionner');
    const count = el('span','ankibridge-count','0 sélectionnée(s)');
    selectNew.type='button'; selectNone.type='button';
    bulk.append(selectNew, selectNone, count); top.append(bulk);
    // Légende discrète : le statut ne repose jamais sur la seule couleur.
    const legend=el('div','ankibridge-legend');
    for(const [cls,word] of [['new','Nouvelle'],['similar','Formulation similaire'],['exact','Déjà présente (non réimportable)']]){
      const cell=el('span','ankibridge-legenditem');
      const d=el('span','ankibridge-dot '+cls);
      d.setAttribute('role','img'); d.setAttribute('aria-label',word);
      cell.append(d, document.createTextNode(' '+word));
      legend.append(cell);
    }
    top.append(legend);
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
      // Titre sans marqueurs de mise en forme : l'aperçu les montre dans le détail.
      const title=el('span','ankibridge-title',`${i+1}. ${typeLabel}${readableTitle(card.front||card.text).slice(0,140)}`);
      summary.append(title); details.append(summary);
      const notice=el('div','ankibridge-notice','Comparaison avec Anki en cours…');
      details.append(notice);
      const cloze=card.type==='cloze';
      const firstName=cloze?'Texte à trous':'Question', secondName=cloze?'Précisions facultatives':'Réponse';
      const firstLabel=el('label','',cloze?'Texte brut (un trou s’écrit {{c1::réponse}}, le gras **ainsi**)':'Texte brut (le gras s’écrit **ainsi**)');
      const first=el('textarea'); first.value=card.type==='cloze'?card.text:card.front; firstLabel.append(first);
      const secondLabel=el('label','','Texte brut (le gras s’écrit **ainsi**)');
      const second=el('textarea'); second.value=card.type==='cloze'?card.extra:card.back; secondLabel.append(second);
      // Aperçu mis en forme à côté du texte modifiable, reconstruit à chaque frappe.
      const withPreview=(label,area)=>{
        const field=el('div','ankibridge-field');
        const preview=el('div','ankibridge-preview');
        preview.setAttribute('aria-label','Aperçu dans Anki');
        const shown=el('div','ankibridge-previewbody');
        preview.append(el('span','ankibridge-previewcap','Aperçu dans Anki'),shown);
        const paint=()=>renderInto(shown,area.value,document);
        area.addEventListener('input',paint); paint();
        field.append(label,preview);
        return field;
      };
      details.append(fieldBlock(firstName,first,withPreview(firstLabel,first),cloze),
        fieldBlock(secondName,second,withPreview(secondLabel,second),false));
      // Bloc « remplacer » : vide tant qu'aucune note certaine n'est identifiée.
      const replaceRow=el('div','ankibridge-replacerow'); details.append(replaceRow);
      row.append(check, dot, status, details);
      main.append(row);
      entries.push({card,check,dot,status,title,first,second,notice,details,replaceRow,replace:null,item:null,kind:null});
    });
    dialog.append(main);
    const foot=el('div','ankibridge-foot'); const msg=el('span','ankibridge-msg','Anki doit être ouvert. Aucune donnée ne part vers un service tiers.');
    msg.setAttribute('role','status'); msg.setAttribute('aria-live','polite');
    // N'apparaît que si au moins une mise à jour de note est cochée.
    const replaceBtn=el('button','ankibridge-replace','Remplacer les notes existantes'); replaceBtn.type='button'; replaceBtn.disabled=true; replaceBtn.hidden=true;
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
      // Le bouton dit ce qu'il va faire : plus besoin de récapitulatif.
      save.textContent=n?`Importer ${n} carte${n>1?'s':''}`:'Importer dans Anki';
    };
    const updateReplaceState=()=>{
      const n=entries.filter(e=>e.replace?.checked).length;
      replaceBtn.disabled = !verified || n===0;
      replaceBtn.hidden = n===0;
      replaceBtn.textContent = n ? `Mettre à jour ${n} note${n>1?'s':''} dans Anki` : 'Remplacer les notes existantes';
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
    let closed=false;
    // La fenêtre est « vivante » tant qu'elle n'a pas été fermée et qu'elle est
    // encore attachée au document : aucune analyse ne doit se poursuivre ni
    // s'appliquer sur un dialogue détaché.
    const alive=()=>!closed&&!!overlay.parentElement;
    const invalidate=({resetChecks=false,why}={})=>{revision++;analysisSeq++;verified=false;lastReport=null;save.disabled=true;
      // Une analyse en vol est abandonnée : on rend la main tout de suite, sinon
      // le bouton resterait désactivé indéfiniment après une édition.
      busy(analyze,false); analyze.disabled=false;
      if(resetChecks)for(const e of entries){e.check.checked=true;e.notice.replaceChildren();}
      for(const e of entries){e.replaceRow.replaceChildren();e.replace=null;}
      replaceBtn.disabled=true; replaceBtn.hidden=true; replaceBtn.textContent='Remplacer les notes existantes';
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
      if(!sameText(m.frontFull??m.front,wanted[0]))changes.push({label:e.card.type==='cloze'?'Texte':'Question',from:m.front||'(vide)',to:wanted[0]});
      if(!sameText(m.secondFull??m.back,wanted[1]))changes.push({label:e.card.type==='cloze'?'Précisions':'Réponse',from:m.back||'(vide)',to:wanted[1]});
      // Rien à mettre à jour : rien n'est proposé (pas de bloc vide ni de case grisée).
      if(!changes.length)return;
      const row=el('div','ankibridge-replacebox');
      const label=el('label','ankibridge-replacepick');
      const box=el('input'); box.type='checkbox'; box.className='ankibridge-replacebox-input';
      box.setAttribute('aria-label',`Mettre à jour la note ${m.id} dans Anki`);
      label.append(box, document.createTextNode(' Mettre à jour la note dans Anki avec cette version'));
      row.append(label);
      // Le détail reste replié : il n'intéresse que si l'on hésite.
      const more=el('details','ankibridge-diffdetails');
      more.append(el('summary','','Voir les changements'));
      const diff=el('div','ankibridge-diff');
      for(const c of changes){
        diff.append(el('p','ankibridge-diffline',`${c.label} dans Anki : ${c.from}`));
        const after=el('div','ankibridge-diffline after');
        after.append(el('span','',`${c.label} après mise à jour : `));
        const shown=el('span','ankibridge-previewbody'); renderInto(shown,c.to,document); after.append(shown);
        diff.append(after);
      }
      diff.append(el('p','ankibridge-replacehint',`Note #${m.id}, paquet « ${deckLabel(m.deck)} » : son planning de révision, son paquet et ses tags sont conservés.`));
      more.append(diff);
      row.append(more);
      box.addEventListener('change',updateReplaceState);
      e.replaceRow.append(row);
      e.replace=box;
    };
    const runAnalysis=async()=>{
      if(!alive())return;
      const token=++analysisSeq;
      const atStart=revision;
      const started=Date.now();
      busy(analyze,true,'Comparaison…'); save.disabled=true; replaceBtn.disabled=true;
      setPending();
      msg.textContent=`Comparaison avec « ${deckLabel(picker.value)} » (et ses sous-paquets)…`;
      try {
        const current=AnkiCards.toCards({cards:currentCards()});
        const report=await api('ANALYZE',{deck:picker.value,cards:current});
        // Résultat périmé, ou fenêtre fermée pendant l'appel : on l'ignore.
        if(!alive()||token!==analysisSeq||atStart!==revision)return;
        verified=true;
        lastReport=report;
        let exact=0, similar=0;
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
            const where=item.duplicates[0]?.deck?` (paquet « ${deckLabel(item.duplicates[0].deck)} »)`:'';
            e.notice.textContent=item.blocked==='interne-au-lot'
              ?'Répétée dans ce lot : une seule copie sera importée.'
              :`Déjà dans Anki${where} : ne sera pas importée en double.`;
            if(item.duplicates.length||item.note){
              const more=el('details','ankibridge-dupdetails');
              more.append(el('summary','',item.duplicates.length>1?`Voir les ${item.duplicates.length} notes identiques`:'Voir la note existante'));
              if(item.duplicates.length)more.append(duplicateBlock(item));
              more.append(el('p','ankibridge-dupnote',item.note));
              e.notice.append(more);
            }
          } else if(item.kind==='similar'){
            similar++;
            e.check.checked=false; // Décochée par précaution, réactivable explicitement.
            e.notice.textContent='Ressemble à une carte déjà dans Anki : non cochée par précaution. Coche-la si elle apporte autre chose.';
            const more=el('details','ankibridge-dupdetails');
            more.append(el('summary','','Voir la carte proche'));
            more.append(duplicateBlock(item));
            e.notice.append(more);
          } else {
            // Carte neuve : pré-sélectionnée pour l'import, comme avant l'analyse.
            e.check.checked=true;
            e.notice.textContent='';   // rien à signaler : pas de message
          }
          buildReplaceRow(e,item);
        });
        updateCount();
        updateReplaceState();
        // Un résumé court : le détail est sur chaque carte.
        const fresh=report.items.length-exact-similar;
        msg.textContent=[fresh?`${fresh} nouvelle${fresh>1?'s':''}`:'',similar?`${similar} à vérifier`:'',exact?`${exact} déjà dans Anki`:'']
          .filter(Boolean).join(' · ')+(report.partial?' · comparaison partielle (collection très grande)':'');
        save.disabled=false;
      } catch(e){
        if(!alive()||token!==analysisSeq)return;
        verified=false;
        msg.textContent=`Comparaison impossible : ${e.message} — clique sur « Relancer la comparaison ».`;
      }
      finally{
        if(alive()&&token===analysisSeq){
          setTimeout(()=>{ if(alive()&&token===analysisSeq){ busy(analyze,false); analyze.disabled=false; } },
            Math.max(0,MIN_BUSY_MS-(Date.now()-started)));
        }
      }
    };
    analyze.onclick=runAnalysis;
    // Changer de paquet relance la comparaison automatiquement (jamais d'import
    // ni de remplacement basé sur les conclusions du paquet précédent).
    const onDeckSelected=(name,why)=>{
      if(name===lastAnalyzedDeck&&verified)return;
      lastAnalyzedDeck=name;
      invalidate({resetChecks:true,why:why||`Paquet changé : comparaison de « ${deckLabel(name)} » en cours…`});
      clearTimeout(debounceTimer);
      debounceTimer=setTimeout(runAnalysis,250);
    };
    let lastAnalyzedDeck='';
    /* Création d'un paquet : le formulaire du sélecteur montre ce qui sera créé
       (parent compris) et n'appelle onCreate qu'au clic sur « Créer le paquet » ;
       c'est la confirmation explicite. Une erreur remonte dans ce formulaire.
       Après création, la liste est rechargée, le paquet sélectionné et la
       comparaison relancée. */
    let deckNames=[];
    const onCreateDeck=async name=>{
      if(!alive())return;
      const check=validateDeckName(name);
      if(!check.ok)throw new Error(check.error);
      const r=await api('CREATE_DECK',{deck:check.name});
      const names=await api('DECKS');
      if(!alive())return;
      deckNames=Array.isArray(names)?names:[];
      picker.setNames(deckNames);
      const target=deckNames.find(d=>sameDeck(d,r.deck))||r.deck;
      picker.setValue(target);
      analyze.disabled=false;
      onDeckSelected(target, r.created
        ?`Paquet « ${deckLabel(target)} » créé dans Anki. Comparaison en cours…`
        :`Le paquet « ${deckLabel(target)} » existait déjà : il est sélectionné. Comparaison en cours…`);
    };
    foot.append(msg,replaceBtn,save);dialog.append(foot); overlay.append(dialog); document.body.append(overlay);
    // Fermer la fenêtre abandonne l'analyse en vol : sans cela, une comparaison
    // lancée juste avant la fermeture continuerait de coûter des appels Anki.
    const closeModal=()=>{closed=true;analysisSeq++;verified=false;clearTimeout(debounceTimer);theme.stop();overlay.remove();};
    overlay.addEventListener('click',e=>{if(e.target===overlay) closeModal();});
    const esc=(e)=>{if(e.key==='Escape'){closeModal();document.removeEventListener('keydown',esc);}};
    document.addEventListener('keydown',esc);
    try {
      const names=await api('DECKS');
      if(!alive())return;                 // fenêtre fermée pendant le chargement des paquets
      deckNames=Array.isArray(names)?names:[];
      picker.setNames(deckNames);
      const saved=await chrome.storage.local.get('deck');
      if(!alive())return;
      if(!names.length)throw new Error('Aucun paquet Anki disponible : tape un nom dans « Paquet Anki » pour en créer un.');
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
            if(!sameText(m.frontFull??m.front,wanted[0]))changes.push({label:e.card.type==='cloze'?'Texte':'Question',from:m.front||'(vide)',to:wanted[0]});
            if(!sameText(m.secondFull??m.back,wanted[1]))changes.push({label:e.card.type==='cloze'?'Précisions':'Réponse',from:m.back||'(vide)',to:wanted[1]});
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
        busy(replaceBtn,true,'Mise à jour…'); save.disabled=true;
        msg.textContent=`Mise à jour en cours : ${replacements.length} note(s)…`;
        const r=await api('REPLACE',{replacements});
        msg.textContent=`${r.updated} note(s) mise(s) à jour, ${r.skipped} sans changement`+
          (r.failed.length?`, ${r.failed.length} refusée(s) : ${r.failed.map(f=>`#${f.noteId} ${f.reason}`).join(' | ')}`:'')+'.';
        // Les conclusions de l'analyse ne sont plus valables après écriture.
        busy(replaceBtn,false);
        verified=false; save.disabled=true; replaceBtn.disabled=true;
        analyze.disabled=false;
        setStale();
      }catch(e){busy(replaceBtn,false);msg.textContent=`Erreur : ${e.message}`;replaceBtn.disabled=!verified;}
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
        busy(save,true,'Import en cours…'); analyze.disabled=true; replaceBtn.disabled=true;
        msg.textContent=`Import en cours : ${selected.length} carte(s)…`;
        await chrome.storage.local.set({deck:picker.value});
        const r=await api('IMPORT',{deck:picker.value,cards:selected});
        msg.textContent=`${r.added} ajoutée(s), ${r.skipped} doublon(s) ignoré(s).`+
          (r.errors.length ? `\n${r.errors.join('\n')}` : ' Révise ensuite dans Anki.');
        busy(save,false);
        save.textContent='Import terminé'; save.disabled=true;
        // Ne jamais réimporter accidentellement la même sélection après un premier lot.
        verified=false;
        analyze.disabled=false;
        setStale();
      }catch(e){busy(save,false);msg.textContent=`Erreur : ${e.message}`;save.disabled=false;analyze.disabled=false;}
    };
    updateCount();
  }
  globalThis.AnkiReview = Object.freeze({showModal});
})();
