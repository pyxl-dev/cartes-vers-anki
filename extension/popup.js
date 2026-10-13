'use strict';
const $=id=>document.getElementById(id);
const api=(type, extra={}) => new Promise((resolve,reject)=>{
  chrome.runtime.sendMessage({type,...extra}, r=>{
    if(chrome.runtime.lastError)return reject(new Error(chrome.runtime.lastError.message));
    if(!r?.ok)return reject(new Error(r?.error||'Erreur de connexion'));
    resolve(r.value);
  });
});

/* ---------------------------------------------------------------------------
   Deux zones de retour DISTINCTES, volontairement séparées :
   - l'état de connexion vit dans l'en-tête (`connState`), mis à jour seulement
     par les opérations de connexion ;
   - le message d'action (`status`) rend compte de la préparation du prompt, de
     la vérification des doublons ou d'un import.
   Ainsi, un échec de préparation de prompt n'efface jamais « Anki connecté ».
--------------------------------------------------------------------------- */
const setConn=(kind,text)=>{
  $('connDot').className='dot '+kind;
  $('connState').textContent=text;
  // Le bouton de reprise n'apparaît que lorsque quelque chose est à reprendre.
  $('retry').hidden=(kind!=='bad');
};
// Chaque message porte sa SOURCE et un numéro d'ordre. Une reprise de connexion
// ne peut effacer qu'un message d'erreur de connexion encore affiché : un compte
// rendu d'action arrivé entre-temps n'est jamais détruit.
let feedbackSeq=0, feedbackSource=null, lastConnSeq=-1;
const feedback=(msg,kind='',source='action')=>{
  const el=$('status');
  el.textContent=msg;
  el.className='feedback'+(kind?' '+kind:'');
  feedbackSource = msg ? source : null;
  feedbackSeq++;
  if(msg && source==='connection') lastConnSeq=feedbackSeq;
};
const clearConnFeedback=()=>{
  if(feedbackSource==='connection' && feedbackSeq===lastConnSeq) feedback('');
};
// Détail technique : visible uniquement dans le bloc de dépannage, jamais dans
// la vue normale. Le message d'action reste court et actionnable.
const setTech=msg=>{ const el=$('techDetail'); if(el)el.textContent = msg ? `Détail technique : ${msg}` : ''; };

let portIsManual=false;
async function loadPort() {
  const info=await api('PORT_INFO');
  portIsManual=!!info.manual;
  $('ankiPort').value=String(info.port);
  return info;
}

/* --- Réglages : port manuel et retour à la détection automatique ---------- */
$('savePort').onclick=async()=>{
  try {
    const raw=$('ankiPort').value.trim();
    if(!/^\d+$/.test(raw)) throw new Error('Saisis un port entier entre 1 et 65535.');
    const port=Number(raw);
    if(!Number.isSafeInteger(port) || port<1 || port>65535) throw new Error('Port hors plage (1–65535).');
    await api('SET_PORT',{port});
    portIsManual=true;
    invalidate();
    feedback(`Port ${port} enregistré. Test de la connexion…`);
    await loadPort().then(refresh).catch(e=>feedback(`Initialisation impossible : ${e.message}`,'error'));
  } catch(e) {feedback(`Port non enregistré : ${e.message}`,'error');}
};
$('autoPort').onclick=async()=>{
  try {
    await api('CLEAR_PORT');
    invalidate();
    feedback('Recherche automatique du port d’AnkiConnect…');
    await loadPort().then(refresh).catch(e=>feedback(`Détection impossible : ${e.message}`,'error'));
  } catch(e) {feedback(`Détection impossible : ${e.message}`,'error');}
};

/* --- Secours JSON : recherche de paquet, vérification, import ------------ */
let analyzed=null;
const invalidate=()=>{ analyzed=null;$('import').disabled=true;$('analysis').replaceChildren(); };
// Recherche de paquet : casse et accents ignorés, sur le chemin complet.
const normText=s=>String(s??'').replace(/œ/gi,'oe').replace(/æ/gi,'ae').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const deckLabel=d=>String(d).split('::').map(s=>s.trim()).filter(Boolean).join(' › ');
let allDecks=[];
function fillDecks(list,{keepCurrent=true}={}){
  const current=$('deck').value;
  $('deck').replaceChildren();
  // La recherche ne change JAMAIS la destination toute seule : le paquet
  // sélectionné est conservé même s'il ne correspond pas au filtre.
  const shown=(keepCurrent&&current&&!list.includes(current))?[current,...list]:list;
  for(const d of shown){const o=document.createElement('option');o.value=d;o.textContent=deckLabel(d);$('deck').append(o);}
  $('deck').value=shown.includes(current)?current:(shown[0]||'');
}
$('deckSearch').addEventListener('input',()=>{
  const words=normText($('deckSearch').value).split(/\s+/).filter(Boolean);
  const kept=allDecks.filter(d=>{const hay=normText(d).replace(/::/g,' ');return words.every(w=>hay.includes(w));});
  fillDecks(kept);
  // Toute modification de recherche périme l'analyse précédente.
  invalidate();
  feedback(kept.length?`${kept.length} paquet(s) correspondant(s).`
    :'Aucun paquet ne correspond : la destination actuelle est conservée.');
});

/* --- Connexion à Anki ---------------------------------------------------- */
async function refresh(){
  setConn('unknown','Vérification…');
  try{
    await api('CONNECT');
    // Une détection automatique peut changer le port réellement utilisé : la
    // valeur affichée est remise à jour, sauf si l'utilisateur est en train de
    // la saisir. Un port fixé manuellement reste prioritaire (PORT_INFO le dit).
    try{ if(document.activeElement!==$('ankiPort')) await loadPort(); }catch{}
    const decks=await api('DECKS');
    const saved=await chrome.storage.local.get('deck');
    const previous=$('deck').value;
    allDecks=decks;
    fillDecks(decks,{keepCurrent:false});
    // Ne JAMAIS conserver un paquet qui n'existe plus (supprimé ou renommé dans
    // Anki) : l'analyse partirait sur une destination obsolète et échouerait.
    const wanted=[saved.deck,previous].find(v=>v&&decks.includes(v));
    $('deck').value=wanted||decks[0]||'';
    invalidate();
    setConn('ok', decks.length ? `Anki connecté · ${decks.length} paquet(s)` : 'Anki connecté');
    // Une connexion réussie efface l'ancien message d'échec de connexion, mais
    // jamais le compte rendu d'une action (prompt, vérification, import).
    clearConnFeedback();
    setTech('');
    if(!decks.length)feedback('Anki est connecté mais aucun paquet n’existe : crée un paquet dans Anki.','','connection');
  }catch(e){
    setConn('bad','Anki non détecté');
    $('deck').replaceChildren();
    invalidate();
    // Message court et actionnable ; le détail technique va dans les réglages.
    feedback('Ouvre Anki (avec AnkiConnect), puis clique Réessayer.','error','connection');
    setTech(e && e.message ? e.message : String(e));
  }
}
$('retry').onclick=refresh;
$('refresh').onclick=refresh;
$('deck').addEventListener('change',invalidate);
$('json').addEventListener('input',invalidate);

$('sample').onclick=()=>{
  $('json').value=JSON.stringify({cards:[
    {type:'basic',front:'Quelle est la capitale de l’Australie ?',back:'Canberra.',tags:['revision','geographie']},
    {type:'cloze',text:'En Python, la fonction {{c1::len()}} renvoie le nombre d’éléments d’une séquence.',extra:'Carte de démonstration.',tags:['revision','programmation']}
  ]},null,2);invalidate();feedback('Exemple chargé. Choisis un paquet pour tester.');
};
$('review').onclick=async()=>{
  $('review').disabled=true; invalidate();
  try{
    // Lecture tolérante : une carte mal formée est écartée, pas tout le lot.
    const parsed=AnkiCards.parse($('json').value);
    if(!parsed.cards.length)throw new Error(parsed.rejected[0]?.reason||'Aucune carte reconnue. Format attendu : {"cards":[{"front":"...","back":"..."}]}');
    if(parsed.cards.length>AnkiCards.MAX_CARDS)throw new Error(`${parsed.cards.length} cartes : colle-les par lots de ${AnkiCards.MAX_CARDS} au maximum (ou utilise les boutons de lot dans ChatGPT).`);
    const cards=parsed.cards;
    const skippedNote=(parsed.rejected.length?`${parsed.rejected.length} carte(s) mal formée(s) ignorée(s) : ${parsed.rejected.slice(0,3).map(r=>r.reason).join(' ; ')}. `:'')+(parsed.truncated?'JSON coupé : dernière carte incomplète ignorée. ':'');
    const deck=$('deck').value;
    if(!deck)throw new Error('Sélectionne un paquet Anki.');
    feedback(`Recherche des cartes existantes pour « ${deck} »…`);
    const report=await api('ANALYZE',{deck,cards});
    analyzed={cards,deck,items:report.items};
    report.items.forEach((r,i)=>{
      const box=document.createElement('div');box.className='preview-item';
      const label=document.createElement('label');
      const check=document.createElement('input');check.type='checkbox';check.dataset.index=String(i);
      check.checked=r.kind==='new';
      const text=document.createElement('span');
      const summary=r.kind==='exact'?'Doublon exact — ignoré':r.kind==='similar'?'Carte proche — à vérifier':'Nouvelle carte';
      const source=(cards[i].front||cards[i].text).slice(0,90);
      text.textContent=`${i+1}. ${summary} : ${source}`;
      label.append(check,text);box.append(label);
      // Libellés distincts : un doublon CERTAIN (même premier champ) n'est pas
      // une simple ressemblance lexicale. Les deux sont affichés, sans doublon.
      for(const match of r.duplicates||[]){
        const small=document.createElement('small');
        const kind=match.certain?'Doublon certain':'Ressemblance';
        small.textContent=`${kind} — Anki #${match.id} — paquet « ${deckLabel(match.deck||'')||'inconnu'} »`+
          `${match.model?` (modèle ${match.model})`:''}`+
          `${match.score!=null?` ${Math.round(match.score*100)} % lexical`:''} : ${match.front}`;
        box.append(small);
      }
      $('analysis').append(box);
    });
    const exact=report.items.filter(x=>x.kind==='exact').length;
    const similar=report.items.filter(x=>x.kind==='similar').length;
    feedback(skippedNote+`${report.totalExisting} notes existantes, ${report.scanned} comparées : ${exact} doublon(s) exact(s), ${similar} ressemblance(s).`+
      (report.partial?' Analyse de similarité PARTIELLE (plus de 20 000 notes).':'')+
      '\nLes ressemblances lexicales sont seulement des alertes ; vérifie que les informations sont identiques.');
    $('import').disabled=false;
  }catch(e){feedback(`Vérification impossible : ${e.message}`,'error');}
  finally{$('review').disabled=false;}
};
$('import').onclick=async()=>{
  $('import').disabled=true;
  try{
    if(!analyzed)throw new Error('Il faut vérifier les doublons.');
    const selected=new Set([...$('analysis').querySelectorAll('input:checked')].map(x=>Number(x.dataset.index)));
    const cards=analyzed.cards.filter((_,i)=>selected.has(i));
    if(!cards.length)throw new Error('Aucune carte sélectionnée.');
    if(!confirm(`Importer ${cards.length} carte(s) dans « ${analyzed.deck} » ?`))return;
    await chrome.storage.local.set({deck:analyzed.deck});
    feedback(`Import en cours (${cards.length} carte(s))…`);
    const r=await api('IMPORT',{deck:analyzed.deck,cards});
    feedback(`${r.added} ajoutée(s), ${r.skipped} doublon(s) ignoré(s).${r.errors.length?'\n'+r.errors.join('\n'):''}`,'ok');
    invalidate();
  }catch(e){feedback(`Erreur : ${e.message}`,'error');}
  finally{$('import').disabled=!analyzed;}
};

/* ---------------------------------------------------------------------------
   Action principale : préparer le prompt dans ChatGPT.
   Elle ne dépend PAS d'Anki : l'utilisateur peut préparer sa demande même si
   Anki est momentanément fermé. L'état de connexion reste affiché à part.
--------------------------------------------------------------------------- */
function buildGeneralPrompt(count) {
  return `À partir du cours, des notes, du document ou du contenu que j’ai joint ou fourni dans cette conversation, crée ${count} flashcards Anki pour mes révisions. Si tu n’as pas reçu de contenu à transformer, demande-moi de te le fournir avant de générer.

Exigences : une connaissance par carte ; formulation non ambiguë ; réponse concise ; privilégier les connaissances importantes du document. Respecte strictement les faits, chiffres, unités, noms et références du contenu, quel que soit le sujet traité. N’invente aucune information et n’ajoute aucune connaissance absente du contenu fourni. Évite les doublons dans ce lot.

Pour permettre l’import direct dans Anki, réponds avec un seul bloc de code JSON valide, sans texte avant ou après. Si la réponse risque d’être trop longue pour un seul message, découpe-la en plusieurs blocs de code JSON complets, chacun au même format, plutôt que de couper une carte au milieu. Structure attendue : {"cards":[{"type":"basic","front":"Question","back":"Réponse","tags":["revision"]},{"type":"cloze","text":"Un concept est {{c1::une notion}}.","extra":"Précision éventuelle","tags":["revision"]}]}. Utilise des cartes classiques ou cloze selon ce qui convient au contenu. Dans "tags", mets un ou deux mots-clés du thème traité, ou "revision" si le thème n’est pas évident. L’extension Anki affiche un bouton d’import automatiquement : je n’ai pas besoin de copier ce JSON.`;
}
$('composePrompt').onclick=async()=>{
  const btn=$('composePrompt');btn.disabled=true;
  try {
    const count=Number($('cardCount').value);
    if(![10,20,30,50,100].includes(count))throw new Error('Nombre de cartes non valide.');
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error('Aucun onglet actif.');
    const response=await new Promise((resolve,reject)=>{
      chrome.tabs.sendMessage(tab.id,{type:'ANKI_INSERT_PROMPT',prompt:buildGeneralPrompt(count)},r=>{
        if(chrome.runtime.lastError)return reject(new Error(chrome.runtime.lastError.message));
        resolve(r);
      });
    });
    if(!response?.ok)throw new Error(response?.error||'Éditeur ChatGPT non trouvé.');
    feedback('Demande insérée dans ChatGPT. Envoie-la : le bouton « Ajouter à Anki » apparaîtra sous les cartes.','ok');
  }catch(e){feedback(`Ouvre chatgpt.com dans cet onglet, puis réessaie. (${e.message})`,'error');}
  finally{btn.disabled=false;}
};

// L'interface est utilisable immédiatement : la connexion se vérifie ensuite,
// sans bloquer l'action principale.
loadPort().then(refresh).catch(e=>{
  setConn('bad','Anki non détecté');
  feedback('Ouvre Anki (avec AnkiConnect), puis clique Réessayer.','error','connection');
  setTech(e && e.message ? e.message : String(e));
});
