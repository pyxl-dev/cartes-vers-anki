'use strict';
const $=id=>document.getElementById(id);
const api=(type, extra={}) => new Promise((resolve,reject)=>{
  chrome.runtime.sendMessage({type,...extra}, r=>{
    if(chrome.runtime.lastError)return reject(new Error(chrome.runtime.lastError.message));
    if(!r?.ok)return reject(new Error(r?.error||'Erreur de connexion'));
    resolve(r.value);
  });
});
const status=t=>{ $('status').textContent=t; };
// Le port peut venir d'un choix explicite de l'utilisateur ou d'une détection automatique.
let portIsManual=false;
async function loadPort() {
  const info=await api('PORT_INFO');
  portIsManual=!!info.manual;
  $('ankiPort').value=String(info.port);
  return info;
}
$('savePort').onclick=async()=>{
  try {
    const raw=$('ankiPort').value.trim();
    if(!/^\d+$/.test(raw)) throw new Error('Saisis un port entier entre 1 et 65535.');
    const port=Number(raw);
    if(!Number.isSafeInteger(port) || port<1 || port>65535) throw new Error('Port hors plage (1–65535).');
    await api('SET_PORT',{port});
    portIsManual=true;
    invalidate();
    status(`Port ${port} enregistré. Ce port doit être identique dans AnkiConnect. Test de connexion...`);
    await loadPort().then(refresh).catch(e=>status(`Initialisation impossible : ${e.message}`));
  } catch(e) {status(`Port non enregistré : ${e.message}`);}
};
// Revenir à la détection automatique (8765 puis 8766), sans rien saisir.
$('autoPort').onclick=async()=>{
  try {
    await api('CLEAR_PORT');
    invalidate();
    status('Détection automatique du port d’AnkiConnect...');
    await loadPort().then(refresh).catch(e=>status(`Détection impossible : ${e.message}`));
  } catch(e) {status(`Détection impossible : ${e.message}`);}
};
let analyzed=null;
const invalidate=()=>{ analyzed=null;$('import').disabled=true;$('analysis').replaceChildren(); };
async function refresh(){
  try{
    await api('CONNECT');
    const decks=await api('DECKS');
    const saved=await chrome.storage.local.get('deck');
    $('deck').replaceChildren();
    // Libellé lisible par niveaux ; la valeur reste le nom complet Anki « Parent::Enfant ».
    const deckLabel=d=>String(d).split('::').map(s=>s.trim()).filter(Boolean).join(' › ');
    for(const d of decks){const o=document.createElement('option');o.value=d;o.textContent=deckLabel(d);$('deck').append(o);}
    if(decks.includes(saved.deck))$('deck').value=saved.deck;
    invalidate(); status(`Anki connecté sur le port ${$('ankiPort').value}`
      +(portIsManual?' (port choisi manuellement)':' (détecté automatiquement)')
      +`. ${decks.length} paquet(s) disponible(s).`);
  }catch(e){status(`Connexion impossible : ${e.message}`);}
}
$('deck').addEventListener('change',invalidate);
$('json').addEventListener('input',invalidate);
$('refresh').onclick=refresh;
$('sample').onclick=()=>{
  $('json').value=JSON.stringify({cards:[
    {type:'basic',front:'Quel organe produit l’insuline ?',back:'Les cellules β des îlots de Langerhans, dans le pancréas.',tags:['demo_medecine']},
    {type:'cloze',text:'L’insuline est produite par les {{c1::cellules β}} du {{c2::pancréas}}.',extra:'Carte de démonstration.'}
  ]},null,2);invalidate();status('Exemple chargé. Choisis un paquet pour tester.');
};
$('review').onclick=async()=>{
  $('review').disabled=true; invalidate();
  try{
    const cards=AnkiCards.toCards($('json').value);
    const deck=$('deck').value;
    if(!deck)throw new Error('Sélectionne un paquet Anki.');
    status(`Recherche des cartes existantes pour « ${deck} »...`);
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
      for(const match of r.matches){
        const small=document.createElement('small');
        small.textContent=`Anki #${match.id} (${Math.round(match.score*100)} % lexical) : ${match.front}`;
        box.append(small);
      }
      $('analysis').append(box);
    });
    const exact=report.items.filter(x=>x.kind==='exact').length;
    const similar=report.items.filter(x=>x.kind==='similar').length;
    status(`${report.totalExisting} notes existantes, ${report.scanned} comparées : ${exact} doublon(s) exact(s), ${similar} ressemblance(s).`+
      (report.partial?' Analyse de similarité PARTIELLE (plus de 20 000 notes).':'')+
      '\nLes ressemblances lexicales sont seulement des alertes ; vérifie les faits médicaux.');
    $('import').disabled=false;
  }catch(e){status(`Vérification impossible : ${e.message}`);}
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
    status(`Import en cours (${cards.length} carte(s))...`);
    const r=await api('IMPORT',{deck:analyzed.deck,cards});
    status(`${r.added} ajoutée(s), ${r.skipped} doublon(s) ignoré(s).${r.errors.length?'\n'+r.errors.join('\n'):''}`);
    invalidate();
  }catch(e){status(`Erreur : ${e.message}`);}
  finally{$('import').disabled=!analyzed;}
};
loadPort().then(refresh).catch(e=>status(`Initialisation impossible : ${e.message}`));


// Parcours normal : prépare le prompt dans l'éditeur ChatGPT. Le JSON est technique
// et sera interprété automatiquement par le bouton d'import injecté sous la réponse.
function buildMedicalPrompt(count) {
  return `À partir du cours que j’ai joint ou fourni dans cette conversation, crée ${count} flashcards Anki pour mes révisions de médecine. Si tu n’as pas reçu le cours, demande-moi de le fournir avant de générer.

Exigences : une connaissance par carte ; formulation non ambiguë ; réponses concises ; privilégier les connaissances importantes pour l’examen. Respecte strictement les valeurs, unités, références et recommandations du document. N’invente aucune information et n’ajoute aucune connaissance absente du cours. Évite les doublons dans ce lot.

Pour permettre l’import direct dans Anki, réponds avec un seul bloc de code JSON valide, sans texte avant ou après. Structure attendue : {"cards":[{"type":"basic","front":"Question","back":"Réponse","tags":["medecine"]},{"type":"cloze","text":"Le {{c1::terme}} est ...","extra":"Précision éventuelle","tags":["medecine"]}]}. Utilise des cartes classiques ou cloze selon le type de connaissance. L’extension Anki affiche un bouton d’import automatiquement : je n’ai pas besoin de copier ce JSON.`;
}
$('composePrompt').onclick=async()=>{
  const btn=$('composePrompt');btn.disabled=true;
  try {
    const count=Number($('cardCount').value);
    if(![10,20,30,50].includes(count))throw new Error('Nombre de cartes non valide.');
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error('Aucun onglet ChatGPT actif.');
    const response=await new Promise((resolve,reject)=>{
      chrome.tabs.sendMessage(tab.id,{type:'ANKI_INSERT_PROMPT',prompt:buildMedicalPrompt(count)},r=>{
        if(chrome.runtime.lastError)return reject(new Error(chrome.runtime.lastError.message));
        resolve(r);
      });
    });
    if(!response?.ok)throw new Error(response?.error||'Éditeur ChatGPT non trouvé.');
    status('Demande insérée dans ChatGPT. Vérifie-la puis envoie-la. Le bouton Ajouter à Anki apparaîtra sous les cartes.');
  }catch(e){status(`Ouvre d’abord chatgpt.com dans cet onglet, puis réessaie. Détail : ${e.message}`);}
  finally{btn.disabled=false;}
};
