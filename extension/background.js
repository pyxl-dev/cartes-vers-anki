'use strict';
importScripts('search.js', 'similarity.js');
const DEFAULT_PORT = 8765;
function validatedPort(value) {
  const raw = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^[0-9]+$/.test(raw)) throw new Error('Saisis un numéro de port entier entre 1 et 65535.');
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('Le port doit être compris entre 1 et 65535.');
  }
  return port;
}
/* ---------------------------------------------------------------------------
   Résolution du port local d'AnkiConnect.

   1) Port fixé explicitement dans le popup  → prioritaire, toujours respecté.
   2) Port déjà détecté automatiquement      → réutilisé s'il répond encore.
   3) Sinon, sonde des ports usuels (8765, puis 8766).

   La sonde n'accepte qu'un service qui se comporte réellement comme AnkiConnect
   (HTTP 200, JSON {result, error}, action « version ») avec un délai court.
   Un port occupé par un autre logiciel est écarté sans lui envoyer la moindre
   écriture : l'extension ne parle qu'à un service identifié comme AnkiConnect.
--------------------------------------------------------------------------- */
const PROBE_PORTS = [8765, 8766];
const PROBE_TIMEOUT_MS = 1500;
const PORT_KEY = 'ankiPort';             // choix manuel (prioritaire)
const DETECTED_KEY = 'ankiPortDetected'; // port trouvé automatiquement
const TIMEOUT_MS = 12000;

// Vérification d'identité : lecture seule (action « version »), jamais d'écriture.
async function identifyAnkiConnect(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action: 'version', version: 6, params: {}}),
      signal: controller.signal
    });
    if (!response.ok) return {ok: false, reason: `HTTP ${response.status}`};
    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType && !contentType.includes('application/json')) return {ok: false, reason: 'réponse non JSON'};
    let body;
    try { body = await response.json(); } catch { return {ok: false, reason: 'JSON illisible'}; }
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        !Object.prototype.hasOwnProperty.call(body, 'result') ||
        !Object.prototype.hasOwnProperty.call(body, 'error')) {
      return {ok: false, reason: 'format non AnkiConnect'};
    }
    if (body.error) return {ok: false, reason: String(body.error)};
    if (typeof body.result !== 'number' || !Number.isFinite(body.result)) return {ok: false, reason: 'version absente'};
    return {ok: true};
  } catch (e) {
    return {ok: false, reason: e?.name === 'AbortError' ? 'aucune réponse' : 'injoignable'};
  } finally { clearTimeout(timer); }
}

// Port choisi par l'utilisateur, ou null s'il n'a rien fixé.
async function manualPort() {
  const config = await chrome.storage.local.get(PORT_KEY);
  const value = config?.[PORT_KEY];
  if (value === undefined || value === null || String(value).trim() === '') return null;
  try { return validatedPort(value); } catch { return null; }
}

async function resolvePort() {
  const manual = await manualPort();
  if (manual !== null) return manual;
  const config = await chrome.storage.local.get(DETECTED_KEY);
  const previous = config?.[DETECTED_KEY];
  if (previous !== undefined && previous !== null) {
    try {
      const port = validatedPort(previous);
      if ((await identifyAnkiConnect(port)).ok) return port;
    } catch { /* on ressonde ci-dessous */ }
  }
  for (const port of PROBE_PORTS) {
    if ((await identifyAnkiConnect(port)).ok) {
      await chrome.storage.local.set({[DETECTED_KEY]: port});
      return port;
    }
  }
  return DEFAULT_PORT;
}

let cachedPort = null;
async function currentPort() {
  if (cachedPort !== null) return cachedPort;
  cachedPort = await resolvePort();
  return cachedPort;
}
function invalidatePort() { cachedPort = null; }

async function ankiOnce(port, action, params = {}) {
  const endpoint = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action, version: 6, params}), signal: controller.signal
    });
    if (response.redirected || !response.ok) {
      throw new Error(`Le service sur le port ${port} ne répond pas comme AnkiConnect (HTTP ${response.status}${response.redirected ? ', redirection' : ''}). Vérifie le port dans Anki → Outils → Greffons → AnkiConnect → Configuration.`);
    }
    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType && !contentType.includes('application/json')) {
      throw new Error(`Le port ${port} répond avec du contenu non JSON : c'est probablement une autre application.`);
    }
    let body;
    try { body = await response.json(); } catch {
      throw new Error(`La réponse du port ${port} n'est pas du JSON AnkiConnect.`);
    }
    if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'result') || !Object.prototype.hasOwnProperty.call(body, 'error')) {
      throw new Error(`Le service sur ${port} n'est pas compatible avec l'API AnkiConnect.`);
    }
    if (body.error) throw new Error(String(body.error));
    return body.result;
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('Anki ne répond pas (délai dépassé). Ouvre Anki puis réessaie.'), {__retryable: true});
    if (e instanceof TypeError) throw Object.assign(new Error(`Aucun service AnkiConnect n'écoute sur le port ${port}. Ouvre Anki (AnkiConnect installé) puis clique sur « Tester Anki / actualiser ».`), {__retryable: true});
    throw e;
  } finally { clearTimeout(timeout); }
}

/* Point d'entrée unique vers AnkiConnect. En cas d'échec réseau, le port est
   résolu de nouveau une seule fois (Anki a pu démarrer ou changer de port). */
async function anki(action, params = {}) {
  const port = await currentPort();
  try {
    return await ankiOnce(port, action, params);
  } catch (e) {
    if (!e || !e.__retryable) throw e;
    invalidatePort();
    const retried = await currentPort();
    if (retried === port) throw e;
    return await ankiOnce(retried, action, params);
  }
}
function plainToHtml(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\n','<br>');
}
function normalizeTag(s) {
  return String(s).trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_\-À-ÿ]/g, '').slice(0, 40);
}
async function findModel(type, available) {
  const candidates = type === 'cloze'
    ? [/^cloze$/i, /texte.*trou/i, /cloze/i]
    : [/^basic$/i, /^basique$/i, /^simple$/i, /basic/i, /basique/i];
  let model = null;
  for (const pattern of candidates) { model = available.find(x => pattern.test(x)); if (model) break; }
  if (!model) throw new Error(type === 'cloze'
    ? 'Type de note Cloze introuvable. Crée un type « Texte à trous » dans Anki.'
    : 'Type de note Basic/Basique introuvable. Crée un type de note « Basique » dans Anki.');
  const fields = await anki('modelFieldNames', {modelName: model});
  if (!Array.isArray(fields) || fields.length < 2) throw new Error(`Le modèle ${model} doit avoir au moins 2 champs.`);
  return {model, fields};
}
async function importCards(deckName, cards) {
  if (!Array.isArray(cards) || !cards.length || cards.length > 100) throw new Error('Import limité à 1–100 cartes par lot.');
  const decks = await anki('deckNames');
  if (!decks.includes(deckName)) throw new Error('Paquet introuvable. Crée-le dans Anki puis actualise la liste.');
  const models = await anki('modelNames');
  const types = [...new Set(cards.map(c => c.type))];
  const modelMap = {};
  for (const type of types) modelMap[type] = await findModel(type, models);
  const seen = new Set();
  const result = {added: 0, skipped: 0, errors: [], total: cards.length};
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    try {
      if (!['basic','cloze'].includes(c.type)) throw new Error('Type de carte invalide.');
      const content = c.type === 'cloze' ? String(c.text || '') : String(c.front || '');
      if (!content.trim() || content.length > 8000) throw new Error('Contenu principal invalide.');
      if (c.type === 'basic' && !String(c.back || '').trim()) throw new Error('Réponse vide.');
      if (c.type === 'cloze' && !/\{\{c\d+::[\s\S]+?\}\}/.test(content)) throw new Error('Texte à trous invalide.');
      const fingerprint = `${c.type}:${content.trim().toLocaleLowerCase()}`;
      if (seen.has(fingerprint)) { result.skipped++; continue; }
      seen.add(fingerprint);
      const {model,fields} = modelMap[c.type];
      const fieldsObj = {};
      for (const field of fields) fieldsObj[field] = '';
      fieldsObj[fields[0]] = plainToHtml(content);
      fieldsObj[fields[1]] = plainToHtml(c.type === 'cloze' ? c.extra || '' : c.back || '');
      const tags = [...new Set(['chatgpt', ...(Array.isArray(c.tags) ? c.tags : [])].map(normalizeTag).filter(Boolean))];
      const note = {deckName, modelName: model, fields: fieldsObj, tags,
        options: {allowDuplicate: false, duplicateScope: 'collection'}};
      const canAdd = await anki('canAddNotes', {notes: [note]});
      if (!canAdd?.[0]) { result.skipped++; continue; }
      const id = await anki('addNote', {note});
      if (id === null || id === undefined) throw new Error('Anki a refusé cette carte.');
      result.added++;
    } catch (e) {
      result.errors.push(`Carte ${i + 1} : ${e.message || e}`);
      if (result.errors.length >= 12) { result.errors.push('Trop d’erreurs, import interrompu.'); break; }
    }
  }
  lastIndex = null;
  return result;
}

// Prévisualisation de doublons avant import. Contrôle natif exact : collection entière.
// Détection lexicale : notes du paquet choisi (et sous-paquets), sans serveur externe.
const MAX_SIMILARITY_SCAN = 20000;
const SCAN_BATCH = 200;
let lastIndex = null;
async function getDeckIndex(deck) {
  if (lastIndex?.deck === deck && Date.now()-lastIndex.time < 60_000) return lastIndex;
  const query='deck:'+quotedQuery(deck);
  const ids=await anki('findNotes', {query});
  if (!Array.isArray(ids)) throw new Error('Recherche Anki invalide.');
  const capped=ids.slice(0,MAX_SIMILARITY_SCAN);
  const notes=[];
  for(let i=0;i<capped.length;i+=SCAN_BATCH) {
    const info=await anki('notesInfo',{notes:capped.slice(i,i+SCAN_BATCH)});
    notes.push(...info.map(AnkiSearch.sanitizeResult));
  }
  lastIndex={deck,time:Date.now(),notes,total:ids.length,partial:ids.length>MAX_SIMILARITY_SCAN};
  return lastIndex;
}
async function analyzeCards(deck,cards) {
  if(!Array.isArray(cards) || cards.length<1 || cards.length>100)throw new Error('Lot invalide (1–100 cartes).');
  const decks=await anki('deckNames');
  if(!decks.includes(deck))throw new Error('Paquet Anki introuvable.');
  const models=await anki('modelNames');
  const modelMap={};
  for(const type of [...new Set(cards.map(c=>c.type))]) {
    if (!['basic','cloze'].includes(type))throw new Error('Type de carte invalide.');
    modelMap[type]=await findModel(type,models);
  }
  const candidateNotes=cards.map(c=>{
    const source=c.type==='cloze'?String(c.text||''):String(c.front||'');
    const value2=c.type==='cloze'?String(c.extra||''):String(c.back||'');
    if(!source.trim() || (c.type==='basic'&&!value2.trim()))throw new Error('Une carte contient un champ requis vide.');
    const {model,fields}=modelMap[c.type];
    const fieldMap=Object.fromEntries(fields.map(f=>[f,'']));
    fieldMap[fields[0]]=plainToHtml(source);fieldMap[fields[1]]=plainToHtml(value2);
    return {deckName:deck,modelName:model,fields:fieldMap,
      options:{allowDuplicate:false,duplicateScope:'collection',duplicateScopeOptions:{checkAllModels:true}}};
  });
  const addable=await anki('canAddNotes',{notes:candidateNotes});
  const idx=await getDeckIndex(deck);
  return {items:AnkiSimilarity.analyze(cards,idx.notes,addable),totalExisting:idx.total,
    scanned:idx.notes.length,partial:idx.partial,scope:deck};
}

// Recherche côté Anki : les données ne sont jamais envoyées à un serveur tiers.
function quotedQuery(value) {
  const cleaned=String(value??'').trim().replace(/[\r\n]/g,' ').slice(0,150);
  return '"'+cleaned.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';
}
async function searchNotes(deck, term, offset=0) {
  const decks=await anki('deckNames');
  if (deck && !decks.includes(deck)) throw new Error('Paquet Anki introuvable.');
  if(!deck && String(term??'').trim().length<2)throw new Error('Sélectionne un paquet ou saisis au moins 2 caractères.');
  const start=Math.min(Math.max(Math.floor(Number(offset)||0),0),5000);
  const t=String(term??'').trim().slice(0,120);
  const query=(deck?'deck:'+quotedQuery(deck)+' ':'')+(t?quotedQuery(t):'');
  const ids=await anki('findNotes',{query:query.trim()});
  const total=ids.length;
  const page=ids.slice(start,start+25);
  const info=page.length?await anki('notesInfo',{notes:page}):[];
  return {deck:deck||'',query:t,total,offset:start,hasMore:start+page.length<total,
    notes:info.map(AnkiSearch.sanitizeResult)};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderUrl = sender.url || sender.tab?.url || '';
  const allowed = sender.id === chrome.runtime.id && (
    senderUrl.startsWith('chrome-extension://') || senderUrl.startsWith('https://chatgpt.com/') ||
    senderUrl.startsWith('https://chat.openai.com/')
  );
  if (!allowed) { sendResponse({ok:false,error:'Origine non autorisée.'}); return false; }
  (async () => {
    switch (message?.type) {
      case 'DECKS': return await anki('deckNames');
      case 'PORT': return await currentPort();
      case 'PORT_INFO': {
        const manual = await manualPort();
        return {port: await currentPort(), manual: manual !== null};
      }
      case 'SET_PORT': {
        const port = validatedPort(message.port);
        await chrome.storage.local.set({[PORT_KEY]: port});
        await chrome.storage.local.remove(DETECTED_KEY);
        invalidatePort();
        lastIndex = null;
        return port;
      }
      case 'CLEAR_PORT': {
        await chrome.storage.local.remove([PORT_KEY, DETECTED_KEY]);
        invalidatePort();
        lastIndex = null;
        return await currentPort();
      }
      case 'CONNECT': {
        invalidatePort();
        const state=await anki('requestPermission');
        if(state.permission!=='granted')throw new Error('Accès à Anki refusé. Autorise cette extension dans AnkiConnect.');
        if(state.requireApiKey)throw new Error('AnkiConnect exige une clé API non configurée dans cette extension.');
        return state;
      }
      case 'SEARCH': return await searchNotes(message.deck,message.term,message.offset);
      case 'ANALYZE': return await analyzeCards(message.deck,message.cards);
      case 'PING': return await anki('version');
      case 'IMPORT': return await importCards(message.deck, message.cards);
      default: throw new Error('Action non autorisée.');
    }
  })().then(value => sendResponse({ok:true,value}))
    .catch(error => sendResponse({ok:false,error: String(error.message || error)}));
  return true;
});
