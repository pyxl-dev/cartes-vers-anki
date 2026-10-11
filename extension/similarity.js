/* Heuristique locale, sans API IA : signale les formulations voisines ; ne prouve pas l'équivalence scientifique. */
(function (root) {
  'use strict';
  const stop = new Set('a au aux de des du le la les un une et ou en dans sur sous par pour avec sans qui que quel quelle quels quelles est sont ce cette ces qu qui comment combien pourquoi ou où on se ses leurs il elle elles ils d l s c ne pas plus moins chez entre indique citer donne nomme vrai faux role rôle fait'.split(' '));
  function normalize(s) {
    return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/g, '$1')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function tokens(s) {
    return [...new Set(normalize(s).split(' ').filter(t => t.length > 2 && !stop.has(t)).map(t=>t.length>6&&/[es]$/.test(t)?t.slice(0,-1):t))];
  }
  function similarity(a,b) {
    const x=normalize(a), y=normalize(b);
    if(!x || !y)return 0;
    if(x===y)return 1;
    const ta=tokens(a), tb=tokens(b);
    if(!ta.length || !tb.length)return 0;
    const bx=new Set(tb);const shared=ta.filter(t=>bx.has(t)).length;
    const overlap=shared/Math.min(ta.length,tb.length);
    const dice=2*shared/(ta.length+tb.length);
    // Les textes très courts avec un seul mot partagé ne doivent pas devenir un faux positif.
    return shared<2 ? Math.min(.55,dice) : .65*dice+.35*overlap;
  }
  function candidateText(card) { return card.type==='cloze'?card.text:card.front; }
  function shortText(s) {return String(s||'').replace(/\s+/g,' ').slice(0,175);}
  function analyze(cards, existing, exactCanAdd) {
    // Index inversé en mémoire : ne comparer que les notes contenant au moins
    // un terme de la question. Évite des millions de traitements regex.
    const indexed=existing.map(note=>{
      const front=note.fields?.[0]?.text||'';
      return {id:note.id,front,normalized:normalize(front),tok:tokens(front),
        answer:normalize(note.fields?.[1]?.text||'')};
    });
    const inverted=new Map();
    indexed.forEach((note,i)=>{
      for(const token of note.tok){
        if(!inverted.has(token))inverted.set(token,[]);
        inverted.get(token).push(i);
      }
    });
    const signatures=new Set();
    return cards.map((card,i)=>{
      const front=candidateText(card), sig=normalize(front);
      const repeated=signatures.has(sig);signatures.add(sig);
      if(repeated||exactCanAdd[i]===false)return {kind:'exact',matches:[]};
      const words=tokens(front), answer=normalize(card.type==='cloze'?card.extra:card.back);
      const candidates=new Set();
      for(const word of words)for(const index of inverted.get(word)||[])candidates.add(index);
      const ranked=[];
      for(const index of candidates){
        const note=indexed[index];
        const shared=words.filter(t=>note.tok.includes(t)).length;
        const d=2*shared/(words.length+note.tok.length);
        const overlap=shared/Math.min(words.length,note.tok.length);
        let score=note.normalized===sig?1:shared<2?Math.min(.55,d):.65*d+.35*overlap;
        // L'égalité de réponse peut signaler une paraphrase, sans prouver
        // qu'il s'agit d'une même connaissance médicale.
        if(answer.length>3&&answer===note.answer&&shared>=1)score=Math.max(score,.7);
        if(score>=.67)ranked.push({id:note.id,front:shortText(note.front),score:Number(score.toFixed(2))});
      }
      ranked.sort((a,b)=>b.score-a.score);
      return {kind:ranked.length?'similar':'new',matches:ranked.slice(0,3)};
    });
  }
  root.AnkiSimilarity=Object.freeze({normalize,tokens,similarity,analyze});
})(typeof globalThis!=='undefined'?globalThis:this);
