'use strict';
importScripts('shared.js', 'search.js', 'similarity.js');
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
   3) Sinon, sonde des ports usuels dans l'ordre standard : 8765 puis 8766.

   La sonde n'accepte qu'un service qui se comporte réellement comme AnkiConnect
   (HTTP 200, JSON {result, error}, action « version » renvoyant un numéro) avec
   un délai court. Un port occupé par un autre logiciel est écarté sans lui
   envoyer la moindre écriture : l'extension ne parle qu'à un service identifié
   comme AnkiConnect.
--------------------------------------------------------------------------- */
const PROBE_PORTS = [8765, 8766]; // ports AnkiConnect usuels, ordre standard
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
/* Texte de carte → champ Anki : échappement complet, puis mise en forme limitée
   (gras, italique, code, listes, exposant, indice). Voir shared.js. */
function fieldHtml(text) { return AnkiShared.toAnkiHtml(text); }
function normalizeTag(s) { return AnkiShared.normalizeTag(s); }
function fieldPlain(text) { return AnkiShared.htmlToText(text); }
function normalizeField(text) {
  return fieldPlain(text).replace(/\s+/g, ' ').trim();
}
// Champs d'une note dans l'ordre du modèle : l'index 0 est le « recto ».
function orderedFields(info) {
  return Object.entries(info?.fields || {})
    .map(([name, v]) => ({name, order: Number(v?.order ?? 0), text: String(v?.value ?? '')}))
    .sort((a, b) => a.order - b.order);
}
/* AnkiConnect ne donne pas le paquet dans notesInfo : il faut cardsInfo. Une note
   peut avoir plusieurs cartes (texte à trous) : on conserve TOUS les paquets
   rencontrés pour ne jamais affirmer un emplacement approximatif. */
async function decksForCardIds(cardIds) {
  const unique = [...new Set((Array.isArray(cardIds) ? cardIds : []).map(Number).filter(Number.isFinite))].slice(0, 500);
  const found = {};
  for (let i = 0; i < unique.length; i += SCAN_BATCH) {
    const infos = await anki('cardsInfo', {cards: unique.slice(i, i + SCAN_BATCH)});
    for (const c of (Array.isArray(infos) ? infos : [])) {
      const note = Number(c?.note);
      if (!Number.isFinite(note)) continue;
      (found[note] = found[note] || new Set()).add(String(c?.deckName || ''));
    }
  }
  const out = {};
  for (const [note, decks] of Object.entries(found)) out[note] = {deck: [...decks][0] || '', decks: [...decks]};
  return out;
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
/* Résultat d'une sous-action de « multi ». AnkiConnect (version 6) renvoie
   {result, error} pour chacune ; les très anciennes versions renvoient la valeur
   brute. Une erreur sur UNE note n'interrompt jamais les autres. */
function multiEntry(entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry) &&
      Object.prototype.hasOwnProperty.call(entry, 'result') && Object.prototype.hasOwnProperty.call(entry, 'error')) {
    return entry.error ? {error: String(entry.error)} : {id: entry.result};
  }
  return {id: entry};
}
/* Écriture groupée : un seul appel « multi » contenant un addNote par carte, au
   lieu d'un aller-retour par carte. addNotes n'est pas utilisé : ses versions
   récentes refusent tout le lot dès qu'une seule note est rejetée.
   Si « multi » échoue en bloc (erreur globale d'AnkiConnect, délai dépassé…), on
   ne sait pas ce qui a été écrit : les doublons sont donc recontrôlés AVANT le
   repli carte par carte, pour ne jamais compter ni tenter deux fois la même note. */
async function addPrepared(prepared) {
  if (!prepared.length) return [];
  let entries = null;
  try {
    const raw = await anki('multi', {actions: prepared.map(p => ({action: 'addNote', version: 6, params: {note: p.note}}))});
    if (Array.isArray(raw) && raw.length === prepared.length) entries = raw.map(multiEntry);
  } catch { entries = null; }
  if (entries) return entries;
  const still = await anki('canAddNotes', {notes: prepared.map(p => p.note)});
  const out = [];
  for (let k = 0; k < prepared.length; k++) {
    if (!still?.[k]) { out.push({skipped: true}); continue; }
    try { out.push({id: await anki('addNote', {note: prepared[k].note})}); }
    catch (e) { out.push({error: String(e?.message || e)}); }
  }
  return out;
}
async function importCards(deckName, cards) {
  if (!Array.isArray(cards) || !cards.length || cards.length > 100) throw new Error('Import limité à 1–100 cartes par lot.');
  const decks = await anki('deckNames');
  if (!decks.includes(deckName)) throw new Error('Paquet introuvable. Crée-le depuis la fenêtre de vérification ou dans Anki, puis actualise la liste.');
  const models = await anki('modelNames');
  const types = [...new Set(cards.map(c => c.type))];
  const modelMap = {};
  for (const type of types) modelMap[type] = await findModel(type, models);
  const seen = new Set();
  const result = {added: 0, skipped: 0, errors: [], total: cards.length};
  // 1) Préparation et validation de chaque note, sans rien écrire.
  const prepared = [];
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
      fieldsObj[fields[0]] = fieldHtml(content);
      fieldsObj[fields[1]] = fieldHtml(c.type === 'cloze' ? c.extra || '' : c.back || '');
      const own = (Array.isArray(c.tags) ? c.tags : []).filter(x => typeof x === 'string').slice(0, 8);
      const tags = [...new Set(['chatgpt', ...own].map(normalizeTag).filter(Boolean))];
      // Même règle de doublon que la vérification : collection entière, tous modèles.
      const note = {deckName, modelName: model, fields: fieldsObj, tags,
        options: {allowDuplicate: false, duplicateScope: 'collection', duplicateScopeOptions: {checkAllModels: true}}};
      prepared.push({i, note});
    } catch (e) {
      result.errors.push(`Carte ${i + 1} : ${e.message || e}`);
      if (result.errors.length >= 12) { result.errors.push('Trop d’erreurs, import interrompu.'); return result; }
    }
  }
  // 2) Un seul contrôle de doublons pour tout le lot (au lieu d'un appel par carte).
  const canAdd = prepared.length ? await anki('canAddNotes', {notes: prepared.map(p => p.note)}) : [];
  // 3) Écriture groupée des seules cartes acceptées ; chaque carte garde son
  //    propre résultat (ajoutée, doublon ou erreur numérotée).
  const toAdd = prepared.filter((_, k) => canAdd?.[k]);
  result.skipped += prepared.length - toAdd.length;
  const outcomes = await addPrepared(toAdd);
  let hidden = 0;
  outcomes.forEach((o, k) => {
    if (o.skipped) { result.skipped++; return; }
    const error = o.error || (o.id === null || o.id === undefined ? 'Anki a refusé cette carte.' : '');
    if (!error) { result.added++; return; }
    if (result.errors.length < 12) result.errors.push(`Carte ${toAdd[k].i + 1} : ${error}`);
    else hidden++;
  });
  if (hidden) result.errors.push(`… et ${hidden} autre(s) erreur(s).`);
  lastIndex = null;
  return result;
}

/* Création d'un paquet depuis la fenêtre de vérification, après confirmation
   explicite dans la page. Seule écriture possible : createDeck. Un paquet déjà
   présent (même nom, casse ignorée) n'est jamais recréé. */
async function createDeck(rawName) {
  const check = AnkiShared.validateDeckName(rawName);
  if (!check.ok) throw new Error(check.error);
  const decks = await anki('deckNames');
  const existing = (Array.isArray(decks) ? decks : []).find(d => AnkiShared.sameDeck(d, check.name));
  if (existing) return {deck: existing, created: false};
  await anki('createDeck', {deck: check.name});
  const after = await anki('deckNames');
  const made = (Array.isArray(after) ? after : []).find(d => AnkiShared.sameDeck(d, check.name));
  if (!made) throw new Error('Anki n’a pas confirmé la création du paquet.');
  lastIndex = null;
  return {deck: made, created: true};
}

// Prévisualisation de doublons avant import. Contrôle natif exact : collection entière.
// Détection lexicale : notes du paquet choisi (et sous-paquets), sans serveur externe.
const MAX_SIMILARITY_SCAN = 20000;
const SCAN_BATCH = 200;
const MAX_LOCATE = 100;           // couvre un lot complet (1–100) : aucun doublon non localisé
const MAX_LOCATE_CANDIDATES = 60; // notes examinées par recherche de doublon
let lastIndex = null;
async function getDeckIndex(deck) {
  if (lastIndex?.deck === deck && Date.now()-lastIndex.time < 60_000) return lastIndex;
  const query='deck:'+quotedQuery(deck);
  const ids=await anki('findNotes', {query});
  if (!Array.isArray(ids)) throw new Error('Recherche Anki invalide.');
  const capped=ids.slice(0,MAX_SIMILARITY_SCAN);
  const notes=[]; const cards={};
  for(let i=0;i<capped.length;i+=SCAN_BATCH) {
    const info=await anki('notesInfo',{notes:capped.slice(i,i+SCAN_BATCH)});
    for(const item of (Array.isArray(info)?info:[])) {
      const clean=AnkiSearch.sanitizeResult(item);
      notes.push(clean);
      cards[clean.id]=Array.isArray(item.cards)?item.cards:[];
    }
  }
  lastIndex={deck,time:Date.now(),notes,cards,total:ids.length,partial:ids.length>MAX_SIMILARITY_SCAN};
  return lastIndex;
}

/* Localisation d'un doublon CERTAIN : même premier champ (la clé de doublon d'Anki)
   et même modèle. Aucune heuristique lexicale ici. Une liste vide signifie « doublon
   signalé par Anki mais non localisé », jamais « pas de doublon ». */
const locateCache = new Map();
async function locateExact(firstFieldText, modelName, {fresh = false} = {}) {
  const plain = normalizeField(firstFieldText);
  if (!plain) return {matches: [], searched: false};
  const key = modelName + '\u0000' + plain;
  const hit = fresh ? null : locateCache.get(key);
  if (hit && Date.now() - hit.time < 60_000) return hit.value;
  // Recherche Anki sur le plus long passage SANS balise : une carte mise en forme
  // (« Na<sup>+</sup> ») est retrouvée que la recherche porte sur le HTML brut ou
  // sur le texte. La preuve d'identité reste la comparaison complète ci-dessous.
  const term = String(firstFieldText ?? '').split(/<[^>]*>/).map(normalizeField)
    .reduce((best, part) => (part.length > best.length ? part : best), '') || plain;
  let value;
  try {
    const ids = await anki('findNotes', {query: quotedText(term)});
    if (!Array.isArray(ids) || !ids.length) value = {matches: [], searched: true};
    else if (ids.length > MAX_LOCATE_CANDIDATES) {
      // Trop de candidats pour les examiner TOUS : l'unicité ne peut pas être
      // prouvée. On refuse de conclure plutôt que d'écraser une note ambiguë.
      value = {matches: [], searched: true, truncated: true, candidates: ids.length};
    } else {
      const infos = await anki('notesInfo', {notes: ids});
      const certain = (Array.isArray(infos)?infos:[]).filter(info => {
        const fields = orderedFields(info);
        return fields.length && normalizeField(fields[0].text) === plain;
      });
      const cardIds = [];
      for (const info of certain) for (const c of (info.cards||[])) cardIds.push(c);
      const decks = await decksForCardIds(cardIds);
      value = {searched: true, matches: certain.map(info => {
        const fields = orderedFields(info);
        const d = decks[Number(info.noteId)] || {deck:'', decks:[]};
        return {id: Number(info.noteId), model: String(info.modelName||''),
          deck: d.deck, decks: d.decks, certain: true,
          compatible: String(info.modelName||'') === modelName,
          // Instantané : sert à refuser un remplacement si la note a bougé depuis.
          mod: Number(info.mod || 0),
          // Champs COMPLETS (non tronqués) : ce sont eux qui servent aux
          // comparaisons. Les versions courtes ci-dessous ne servent qu'à l'affichage.
          frontFull: plain,
          secondFull: normalizeField(fields[1]?.text||''),
          second: normalizeField(fields[1]?.text||'').slice(0,4000),
          front: plain.slice(0,240),
          back: normalizeField(fields[1]?.text||'').slice(0,240),
          tags: Array.isArray(info.tags)?info.tags.slice(0,15):[]};
      })};
    }
  } catch { value = {matches: [], searched: false}; }
  if (!fresh) locateCache.set(key, {time: Date.now(), value});
  return value;
}
// Indices de texte à trous : {{c1::…}}, {{c2::…}}. Changer l'ENSEMBLE des indices
// change le nombre de cartes générées par Anki, donc le planning de révision.
// Un même indice répété (deux {{c1::…}}) ne crée qu'une seule carte : c'est un
// ENSEMBLE, pas un multiensemble.
function clozeIndices(text) {
  const all = Array.from(String(text ?? '').matchAll(/\{\{c(\d+)::/g), m => Number(m[1]));
  return [...new Set(all)].sort((a, b) => a - b);
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
    fieldMap[fields[0]]=fieldHtml(source);fieldMap[fields[1]]=fieldHtml(value2);
    return {deckName:deck,modelName:model,fields:fieldMap,
      options:{allowDuplicate:false,duplicateScope:'collection',duplicateScopeOptions:{checkAllModels:true}}};
  });
  const addable=await anki('canAddNotes',{notes:candidateNotes});
  const idx=await getDeckIndex(deck);
  const base=AnkiSimilarity.analyze(cards,idx.notes,addable);
  // Cartes répétées dans le lot : doublon interne, sans note Anki à localiser.
  const sigs=cards.map(c=>AnkiSimilarity.normalize(c.type==='cloze'?c.text:c.front));
  const repeated=sigs.map((s,i)=>sigs.indexOf(s)!==i);
  // Ressemblances lexicales : on joint paquet et modèle, jamais présentés comme certains.
  const similarIds=[];
  base.forEach(it=>{ if(it.kind==='similar') for(const m of it.matches) similarIds.push(m.id); });
  const similarDecks=similarIds.length?await decksForCardIds(similarIds.flatMap(id=>idx.cards[id]||[])):{};
  const byId=new Map(idx.notes.map(n=>[n.id,n]));
  const items=[];
  let locatedCount=0;
  for(let i=0;i<cards.length;i++){
    const item=base[i];
    if(item.kind==='new'){
      items.push({kind:'new',duplicates:[],replaceable:false,blocked:null,
        note:'Aucun doublon détecté dans la zone analysée.'});
      continue;
    }
    if(item.kind==='similar'){
      const duplicates=item.matches.map(m=>{
        const note=byId.get(m.id);
        const d=similarDecks[m.id]||{deck:'',decks:[]};
        return {id:m.id,model:String(note?.model||''),deck:d.deck,decks:d.decks,certain:false,
          compatible:false,score:m.score,front:m.front,
          back:String(note?.fields?.[1]?.text||'').slice(0,240),tags:note?.tags||[]};
      });
      items.push({kind:'similar',duplicates,replaceable:false,blocked:null,
        note:'Formulation proche : ressemblance lexicale, pas une preuve d\'équivalence.'});
      continue;
    }
    if(repeated[i]){
      items.push({kind:'exact',duplicates:[],replaceable:false,blocked:'interne-au-lot',
        note:'Carte répétée dans ce lot : une seule copie sera importée.'});
      continue;
    }
    if(locatedCount>=MAX_LOCATE){
      items.push({kind:'exact',duplicates:[],replaceable:false,blocked:'limite',
        note:'Doublon déjà présent dans la collection (localisation non effectuée : limite atteinte).'});
      continue;
    }
    locatedCount++;
    const first=cards[i].type==='cloze'?cards[i].text:cards[i].front;
    // Même champ que celui envoyé à Anki (mis en forme), pas le texte Markdown brut.
    const res=await locateExact(fieldHtml(first), modelMap[cards[i].type].model);
    const duplicates=res.matches;
    if(!duplicates.length){
      items.push({kind:'exact',duplicates:[],replaceable:false,
        blocked:res.searched?'non-localise':'recherche-impossible',
        note:'Doublon déjà présent dans la collection, emplacement non déterminé : remplacement non proposé.'});
      continue;
    }
    const compatibles=duplicates.filter(d=>d.compatible);
    const blocked = duplicates.length>1 ? 'ambigu' : (compatibles.length ? null : 'incompatible');
    items.push({kind:'exact',duplicates,replaceable:blocked===null,blocked,
      note: blocked==='ambigu'
        ? 'Plusieurs notes identiques trouvées : remplacement bloqué, choisis la note exacte dans Anki.'
        : blocked==='incompatible'
          ? 'Note identique trouvée mais modèle différent : remplacement refusé.'
          : 'Doublon exact déjà présent dans la collection : ignoré à l\'import.'});
  }
  return {items,totalExisting:idx.total,scanned:idx.notes.length,partial:idx.partial,scope:deck};
}

/* Remplacement du contenu de notes EXISTANTES, sans suppression ni recréation.
   - updateNoteFields uniquement : identifiant de note, paquet, planning et
     historique de révision sont conservés ; les tags ne sont jamais modifiés
     (aucune clé « tags » n'est transmise à AnkiConnect).
   - Concurrence optimiste (anti-TOCTOU) : la note est relue juste avant écriture
     et le remplacement est refusé si le modèle, le premier champ, le second champ,
     l'horodatage « mod » ou le paquet diffèrent de l'instantané de l'analyse.
   - Modèle comparé à l'identique : « Basique » et « Basique (carte inversée
     optionnelle) » partagent le même premier champ mais ne sont PAS interchangeables.
   - Texte à trous : si l'ensemble des indices {{c1}}/{{c2}} change, le nombre de
     cartes générées changerait aussi → remplacement refusé.
   - Les champs sont appliqués par POSITION (recto = champ 0, verso = champ 1), donc
     un modèle aux champs nommés différemment est traité correctement et les champs
     supplémentaires ne sont pas touchés. */
async function replaceNotes(replacements) {
  if (!Array.isArray(replacements) || !replacements.length) throw new Error('Aucun remplacement sélectionné.');
  if (replacements.length > 100) throw new Error('Remplacement limité à 100 notes par lot.');
  const models = await anki('modelNames');
  const result = {updated: 0, skipped: 0, skippedDetails: [], failed: [], total: replacements.length};
  for (const item of replacements) {
    const noteId = Number(item?.noteId);
    try {
      if (!Number.isSafeInteger(noteId) || noteId <= 0) throw new Error('Identifiant de note invalide.');
      // Défense en profondeur : aucune écriture de tags ou de paquet n'est acceptée.
      if (item && ('tags' in item || 'deckName' in item)) throw new Error('Données non autorisées dans la demande de remplacement.');
      const expectedModel = String(item?.model || '');
      const fingerprint = normalizeField(item?.fingerprint || '');
      const type = String(item?.type || '');
      if (!expectedModel || !fingerprint) throw new Error('Données de remplacement incomplètes.');
      if (type !== 'basic' && type !== 'cloze') throw new Error('Type de carte non précisé.');
      if (!models.includes(expectedModel)) throw new Error(`Le modèle « ${expectedModel} » n'existe plus dans Anki.`);
      const infos = await anki('notesInfo', {notes: [noteId]});
      const info = Array.isArray(infos) ? infos[0] : null;
      if (!info) throw new Error('La note n\'existe plus dans Anki.');
      // Modèle à l'identique : un modèle voisin (carte inversée, saisie de réponse…)
      // partage le même premier champ mais change la mécanique de révision.
      if (String(info.modelName) !== expectedModel) {
        throw new Error(`Modèle différent de celui comparé (${info.modelName}) : remplacement refusé.`);
      }
      const fields = orderedFields(info);
      if (fields.length < 2) throw new Error('Note sans champs recto/verso exploitables.');
      if (normalizeField(fields[0].text) !== fingerprint) {
        throw new Error('Le premier champ a changé depuis la comparaison : remplacement refusé.');
      }
      if (item.originalSecond !== undefined && normalizeField(fields[1].text) !== normalizeField(item.originalSecond)) {
        throw new Error('Le second champ a changé depuis la comparaison : remplacement refusé.');
      }
      if (item.mod !== undefined && Number(item.mod) !== Number(info.mod || 0)) {
        throw new Error('La note a été modifiée dans Anki depuis la comparaison : remplacement refusé.');
      }
      const deckInfo = (await decksForCardIds(info.cards || []))[noteId];
      const expectedDeck = String(item?.deck || '');
      // Comparaison de l'ENSEMBLE des paquets, pas d'une simple appartenance :
      // une note passée de [A, B] à [A, C] contient encore A mais a bien bougé.
      const expectedDecks = (Array.isArray(item?.decks) && item.decks.length ? item.decks : (expectedDeck ? [expectedDeck] : [])).map(String);
      const actualDecks = (deckInfo?.decks || []).map(String);
      if (expectedDecks.length && actualDecks.length) {
        const sameSet = expectedDecks.length === actualDecks.length &&
          [...expectedDecks].sort().join('\u0000') === [...actualDecks].sort().join('\u0000');
        if (!sameSet) throw new Error(`La note a été déplacée vers « ${deckInfo.deck} » : remplacement refusé.`);
      }
      // Ambiguïté : plusieurs notes du MÊME modèle partagent ce premier champ.
      // On refuse plutôt que de modifier une note au hasard. La vérification est
      // refaite SANS cache juste avant l'écriture : une note créée dans Anki
      // après l'analyse ne doit pas passer entre les mailles.
      const located = await locateExact(fingerprint, expectedModel, {fresh: true});
      if (located.truncated) {
        throw new Error(`Trop de notes partagent ce premier champ (${located.candidates}) pour prouver l'unicité : remplacement refusé.`);
      }
      const sameModel = located.matches.filter(m => m.model === expectedModel);
      if (sameModel.length > 1) {
        throw new Error(`Plusieurs notes identiques (${sameModel.length}) partagent ce premier champ : remplacement refusé, précise la note dans Anki.`);
      }
      const wanted = [item?.first, item?.second].map(v => fieldHtml(String(v ?? '')));
      if (type === 'cloze') {
        const before = clozeIndices(fieldPlain(fields[0].text)).join(',');
        const after = clozeIndices(fieldPlain(wanted[0])).join(',');
        if (before !== after) {
          throw new Error('Le nombre de textes à trous change : le nombre de cartes et le planning seraient modifiés, remplacement refusé.');
        }
      }
      const updates = {};
      if (normalizeField(fields[0].text) !== normalizeField(wanted[0])) updates[fields[0].name] = wanted[0];
      if (normalizeField(fields[1].text) !== normalizeField(wanted[1])) updates[fields[1].name] = wanted[1];
      // Aucun champ ne diffère : rien à écrire, et surtout pas une écriture inutile.
      if (!Object.keys(updates).length) {
        result.skipped++;
        result.skippedDetails.push({noteId, reason: 'Aucun champ ne diffère : note laissée intacte.'});
        continue;
      }
      await anki('updateNoteFields', {note: {id: noteId, fields: updates}});
      result.updated++;
    } catch (e) {
      result.failed.push({noteId: Number.isFinite(noteId) ? noteId : null, reason: String(e?.message || e)});
    }
  }
  lastIndex = null;
  locateCache.clear();
  return result;
}

// Recherche côté Anki : les données ne sont jamais envoyées à un serveur tiers.
function quotedQuery(value) {
  const cleaned=String(value??'').trim().replace(/[\r\n]/g,' ').slice(0,150);
  return '"'+cleaned.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';
}
/* Texte cherché DANS les champs : « : » sépare un nom de champ, « * » et « _ » sont
   des jokers. Non échappés, « Question : … » ou « {{c1::… » ne trouvaient rien et
   le doublon restait « non localisé » (vérifié sur un vrai Anki). */
function quotedText(value) {
  const cleaned=String(value??'').trim().replace(/[\r\n]/g,' ').slice(0,150);
  return '"'+cleaned.replace(/[\\"*_:]/g,'\\$&')+'"';
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
        locateCache.clear();
        return port;
      }
      case 'CLEAR_PORT': {
        await chrome.storage.local.remove([PORT_KEY, DETECTED_KEY]);
        invalidatePort();
        lastIndex = null;
        locateCache.clear();
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
      case 'CREATE_DECK': return await createDeck(message.deck);
      case 'REPLACE': return await replaceNotes(message.replacements);
      default: throw new Error('Action non autorisée.');
    }
  })().then(value => sendResponse({ok:true,value}))
    .catch(error => sendResponse({ok:false,error: String(error.message || error)}));
  return true;
});
