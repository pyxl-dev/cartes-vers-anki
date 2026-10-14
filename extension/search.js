/* Fonctions pures pour lire des notes et transmettre un contexte ciblé à ChatGPT. */
(function(root) {
  'use strict';
  const MAX_CONTEXT_CHARS=18000;
  // Décodage commun (shared.js) ; on retire en plus scripts et feuilles de style.
  function stripped(html) {
    return root.AnkiShared.htmlToText(String(html??'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'')).trim();
  }
  function sanitizeResult(info) {
    const raw=Object.entries(info.fields||{}).sort((a,b)=>(a[1].order??0)-(b[1].order??0));
    return {id:Number(info.noteId),model:String(info.modelName||'').slice(0,100),
      tags:Array.isArray(info.tags)?info.tags.filter(s=>typeof s==='string').slice(0,15):[],
      fields:raw.slice(0,8).map(([name,v])=>({name:name.slice(0,90),text:stripped(v.value).slice(0,2200)}))};
  }
  function formatContext(notes, meta={}) {
    if(!notes.length)throw Error('Aucune note sélectionnée.');
    const deck=String(meta.deck||'tous les paquets').slice(0,150);
    const query=String(meta.query||'').slice(0,150);
    const total=Number(meta.total??notes.length);
    let content=`Contexte ANKI EXISTANT (fourni par une extension locale AnkiConnect)\nRecherche : ${query||'(tout le paquet)'} | Paquet : ${deck}\n${notes.length} note(s) sélectionnée(s) sur ${total} résultat(s). Ceci est un extrait : ne présume pas qu'il couvre toute la collection.\n\nConsigne : utilise ces notes existantes comme contexte. Évite de créer des cartes répétant la même connaissance. Si tu identifies un chevauchement, indique le lien avec l'ID Anki existant. Ne supprime ou ne modifie rien sans demande expresse.\n`;
    let included=0;
    for(const note of notes) {
      const fields=(note.fields||[]).map(f=>`${f.name} : ${f.text}`).join('\n');
      const part=`\n[Note ${note.id} | ${note.model} | tags: ${(note.tags||[]).join(', ')}]\n${fields}\n`;
      if(content.length+part.length>MAX_CONTEXT_CHARS)break;
      content+=part;included++;
    }
    if(!included)throw Error('Notes trop longues pour être envoyées. Réduis la sélection.');
    if(included<notes.length)content+=`\n[Extrait tronqué : ${notes.length-included} note(s) sélectionnée(s) non transmises.]\n`;
    return content;
  }
  root.AnkiSearch=Object.freeze({stripped,sanitizeResult,formatContext,MAX_CONTEXT_CHARS});
})(typeof globalThis!=='undefined'?globalThis:this);
