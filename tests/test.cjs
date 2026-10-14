'use strict';
/* Tests hors navigateur de l'extension « Cartes vers Anki ».
   Exécution : node tests/test.cjs
   Aucun accès réseau externe : les serveurs simulés écoutent sur la boucle locale. */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const EXT = p => path.join(__dirname, '..', 'extension', p);
let pass = 0, fail = 0;
let declared = 0;   // nombre de tests déclarés, pour détecter une suite tronquée
const t = (name, fn) => { declared++; try { fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      -> ' + e.message); } };
const ta = async (name, fn) => { declared++; try { await fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      -> ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n         ') : e.message)); } };
const load = (ctx, name) => vm.runInContext(fs.readFileSync(EXT(name), 'utf8'), ctx, { filename: name });
/* Ordre de chargement RÉEL, lu dans les fichiers livrés : les tests chargent les
   scripts exactement comme le navigateur (manifeste, popup.html, importScripts). */
const MANIFEST = () => JSON.parse(fs.readFileSync(EXT('manifest.json'), 'utf8'));
const CONTENT_SCRIPTS = () => MANIFEST().content_scripts[0].js;
const POPUP_SCRIPTS = () => [...fs.readFileSync(EXT('popup.html'), 'utf8').matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
const BACKGROUND_SCRIPTS = () => {
  const m = fs.readFileSync(EXT('background.js'), 'utf8').match(/importScripts\(([^)]*)\)/);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]).concat('background.js');
};
// chrome.storage.local simulé, respectant les clés demandées.
const fakeStorage = (storage = {}) => ({
  get: async keys => {
    if (keys == null) return { ...storage };
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {}; for (const k of list) if (k in storage) out[k] = storage[k];
    return out;
  },
  set: async obj => { Object.assign(storage, obj); },
  remove: async keys => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete storage[k]; }
});

/* ------------------------------------------------------------------ *
 * 1. Analyse du JSON produit par ChatGPT (cards.js)                  *
 * ------------------------------------------------------------------ */
function cardsContext() {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  load(ctx, 'cards.js');
  return ctx.AnkiCards;
}
function sharedContext() {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  load(ctx, 'shared.js');
  return ctx.AnkiShared;
}

const basic = n => Array.from({ length: n }, (_, i) => ({ type: 'basic', front: 'Q' + (i + 1), back: 'R' + (i + 1) }));
const json = n => JSON.stringify({ cards: basic(n) });

function parserTests() {
  const A = cardsContext();
  t('lot de 5 cartes', () => assert.equal(A.toCards(json(5)).length, 5));
  t('lot de 50 cartes', () => assert.equal(A.toCards(json(50)).length, 50));
  t('lot de 100 cartes (plafond)', () => assert.equal(A.toCards(json(100)).length, 100));
  t('lot de 101 cartes refusé', () => assert.throws(() => A.toCards(json(101)), /Maximum 100/));
  t('lot de 200 cartes refusé', () => assert.throws(() => A.toCards(json(200)), /Maximum 100/));
  t('plafond annoncé = 100', () => assert.equal(A.MAX_CARDS, 100));
  t('bloc ```json accepté', () => assert.equal(A.toCards('```json\n' + json(3) + '\n```').length, 3));
  t('tableau nu accepté', () => assert.equal(A.toCards(JSON.stringify(basic(2))).length, 2));
  t('clé "notes" acceptée', () => assert.equal(A.toCards('{"notes":[{"front":"a","back":"b"}]}').length, 1));
  t('cloze valide accepté', () => assert.equal(A.toCards('{"cards":[{"type":"cloze","text":"Le {{c1::cœur}} pompe."}]}')[0].type, 'cloze'));
  t('cloze auto-détecté sans type', () => assert.equal(A.toCards('{"cards":[{"text":"Le {{c1::cœur}} pompe."}]}')[0].type, 'cloze'));
  t('cloze sans {{c1::}} refusé', () => assert.throws(() => A.toCards('{"cards":[{"type":"cloze","text":"cœur"}]}'), /cloze sans/));
  t('basic sans réponse refusé', () => assert.throws(() => A.toCards('{"cards":[{"front":"Q"}]}'), /manquante/));
  t('conteneur vide refusé', () => assert.throws(() => A.toCards('{"cards":[]}'), /Aucune carte/));
  t('Markdown non-JSON refusé', () => assert.throws(() => A.toCards('Front: Q\nBack: R')));
  t('accents et texte français préservés', () => {
    const c = A.toCards('{"cards":[{"front":"Quel est le rôle de l’œsophage ?","back":"Déglutition, 25 cm environ."}]}')[0];
    assert.equal(c.front, 'Quel est le rôle de l’œsophage ?');
    assert.ok(c.back.includes('Déglutition'));
  });
  t('tags : 8 max, chaînes seules', () => {
    const c = A.toCards(JSON.stringify({ cards: [{ front: 'q', back: 'b', tags: ['a', 'b', 7, 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }] }))[0];
    assert.equal(c.tags.length, 8);
    assert.ok(c.tags.every(x => typeof x === 'string'));
  });
  t('HTML non échappé à ce stade (échappé à l’import)', () => {
    const c = A.toCards('{"cards":[{"front":"<img src=x onerror=alert(1)>","back":"<script>alert(2)</script>"}]}')[0];
    assert.equal(c.front, '<img src=x onerror=alert(1)>');
  });
  t('contenu > 8000 caractères refusé', () => assert.throws(() => A.toCards(JSON.stringify({ cards: [{ front: 'x'.repeat(8001), back: 'b' }] })), /trop long/));
  t('carte non-objet refusée', () => assert.throws(() => A.toCards('{"cards":["nope"]}'), /invalide/));

  /* --- Lecture tolérante (parse) : ce que ChatGPT affiche réellement --- */
  t('parse : JSON complet -> toutes les cartes, rien d’écarté', () => {
    const r = A.parse(json(12));
    assert.equal(r.cards.length, 12); assert.equal(r.rejected.length, 0); assert.equal(r.truncated, false);
  });
  t('parse : une carte invalide n’empêche pas les 99 autres', () => {
    const items = basic(100); items[41] = { type: 'cloze', text: 'sans trou' };
    const r = A.parse(JSON.stringify({ cards: items }));
    assert.equal(r.cards.length, 99); assert.equal(r.rejected.length, 1);
    assert.match(r.rejected[0].reason, /Carte 42 : cloze sans/);
  });
  t('parse : réponse coupée au milieu d’une carte -> cartes complètes récupérées', () => {
    const full = JSON.stringify({ cards: basic(60) });
    const cut = full.slice(0, full.indexOf('"Q58"') + 3);   // coupé dans la 58e carte
    const r = A.parse(cut);
    assert.equal(r.cards.length, 57); assert.equal(r.truncated, true);
    assert.equal(r.cards[56].front, 'Q57');
  });
  t('parse : réponse coupée puis reprise dans un 2e bloc -> recollée', () => {
    const full = JSON.stringify({ cards: basic(30) });
    const at = full.indexOf('"Q17"') + 2;
    const r = A.parse([full.slice(0, at), full.slice(at)].join(''));   // comme codeText() de content.js
    assert.equal(r.cards.length, 30);
    assert.equal(A.parse(full.slice(0, at)).cards.length, 16, 'le 1er bloc seul ne donne que 16 cartes');
  });
  t('parse : plusieurs blocs JSON complets à la suite -> fusionnés', () => {
    const r = A.parse(json(50) + '\n' + JSON.stringify({ cards: basic(50).map(c => ({ ...c, front: c.front + 'b' })) }));
    assert.equal(r.cards.length, 100);
  });
  t('parse : plus de 100 cartes acceptées, découpées en lots de 100', () => {
    const r = A.parse(json(230));
    assert.equal(r.cards.length, 230);
    assert.equal(JSON.stringify(A.chunks(r.cards).map(l => [l.from, l.to, l.cards.length])), '[[1,100,100],[101,200,100],[201,230,30]]');
  });
  t('parse : accolades et guillemets dans le texte des cartes ne trompent pas le découpage', () => {
    const tricky = [{ front: 'Que vaut {x} dans "f(x)" ?', back: 'Un } isolé \\ et "guillemets"' }, { type: 'cloze', text: 'Le {{c1::cœur}} pompe.' }];
    const full = JSON.stringify({ cards: tricky });
    const r = A.parse(full.slice(0, -2));                    // fermeture manquante
    assert.equal(r.cards.length, 2);
    assert.equal(r.cards[0].back, 'Un } isolé \\ et "guillemets"');
  });
  t('parse : du code ordinaire ne produit aucune carte', () => {
    for (const code of ['function f(){ return {a:1}; }', '{"name":"pkg","version":"1.0.0"}', 'ceci n’est pas du JSON', '']) {
      const r = A.parse(code);
      assert.equal(r.cards.length, 0, code);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 2. Validation du port (background.js)                              *
 * ------------------------------------------------------------------ */
function bgContext({ fetchImpl, storage = {} } = {}) {
  const listeners = [];
  const ctx = {
    console, setTimeout, clearTimeout, AbortController, URL, TypeError, Response, Headers,
    fetch: fetchImpl || (() => { throw new TypeError('fetch not stubbed'); }),
    chrome: {
      runtime: { id: 'test-extension-id', onMessage: { addListener: fn => listeners.push(fn) } },
      storage: { local: fakeStorage(storage) }
    },
    importScripts: () => {}
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of BACKGROUND_SCRIPTS()) load(ctx, f);
  return { ctx, listeners, storage };
}
const ankiOk = value => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ result: value, error: null }) });
const foreign = (status, text, ct) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => ct }, json: async () => { throw new Error('no json'); }, text: async () => text });

function portTests() {
  t('validate : accepte 1, 8765, 8766, 65535', () => {
    const { ctx } = bgContext();
    for (const v of [1, 8765, 8766, 65535, '8765']) assert.equal(ctx.validatedPort(v), Number(v));
  });
  t('validate : refuse 0, 65536, décimal, texte, vide', () => {
    const { ctx } = bgContext();
    for (const v of [0, 65536, 8765.5, '8 765', 'abc', '', null, undefined, '8e3', '-1']) assert.throws(() => ctx.validatedPort(v));
  });
  ta('identify : accepte un vrai AnkiConnect ({result, error})', async () => {
    const { ctx } = bgContext({ fetchImpl: async () => ankiOk(6) });
    assert.equal((await ctx.identifyAnkiConnect(8765)).ok, true);
  });
  ta('identify : refuse un JSON étranger (401 unauthorized)', async () => {
    const { ctx } = bgContext({ fetchImpl: async () => foreign(401, '{"error":"unauthorized"}', 'application/json') });
    assert.equal((await ctx.identifyAnkiConnect(8765)).ok, false);
  });
  ta('identify : refuse une page HTML de connexion', async () => {
    const { ctx } = bgContext({ fetchImpl: async () => foreign(200, '<!doctype html><form action="/login"></form>', 'text/html') });
    assert.equal((await ctx.identifyAnkiConnect(8765)).ok, false);
  });
  ta('identify : refuse un objet {result, error} sans version numérique', async () => {
    const { ctx } = bgContext({ fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ result: null, error: null }) }) });
    assert.equal((await ctx.identifyAnkiConnect(8765)).ok, false);
  });
  ta('identify : la sonde n’envoie QUE l’action « version » (aucune écriture)', async () => {
    const seen = [];
    const { ctx } = bgContext({ fetchImpl: async (url, opt) => { seen.push(JSON.parse(opt.body)); return ankiOk(6); } });
    await ctx.identifyAnkiConnect(8765);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].action, 'version');
  });
  ta('resolvePort : sonde 8765 puis 8766 et retient 8766 si 8765 est occupé', async () => {
    const { ctx, storage } = bgContext({ fetchImpl: async (url) => (url.endsWith(':8765') ? foreign(401, '{"error":"unauthorized"}', 'application/json') : ankiOk(6)) });
    assert.equal(await ctx.resolvePort(), 8766);
    assert.equal(storage.ankiPortDetected, 8766);
  });
  ta('resolvePort : le choix manuel gagne sur la sonde', async () => {
    const { ctx } = bgContext({ storage: { ankiPort: 49000 }, fetchImpl: async () => ankiOk(6) });
    assert.equal(await ctx.resolvePort(), 49000);
  });
  ta('resolvePort : réutilise le port détecté s’il répond toujours', async () => {
    const calls = [];
    const { ctx } = bgContext({ storage: { ankiPortDetected: 8766 }, fetchImpl: async (url) => { calls.push(url); return ankiOk(6); } });
    assert.equal(await ctx.resolvePort(), 8766);
    assert.equal(calls.length, 1);
  });
  ta('resolvePort : aucun service -> repli sur 8765 sans plante', async () => {
    const { ctx } = bgContext({ fetchImpl: async () => { throw new TypeError('connection refused'); } });
    assert.equal(await ctx.resolvePort(), 8765);
  });
}

/* ------------------------------------------------------------------ *
 * 3. Intégration avec un AnkiConnect SIMULÉ (boucle locale, port libre) *
 * ------------------------------------------------------------------ */
/* Faux AnkiConnect. Comme le vrai :
   - « multi » exécute chaque sous-action et renvoie {result, error} pour CHACUNE
     (une note refusée n'empêche pas les autres) ;
   - « addNotes » des versions récentes échoue EN BLOC si une seule note est refusée.
   Une note dont le recto contient « REFUS » est rejetée par Anki (échec partiel).
   state.failMulti simule une erreur globale de « multi » (repli carte par carte). */
function startMockAnki() {
  const state = { decks: ['Par défaut', 'Cours'], models: ['Basique', 'Basic', 'Cloze', 'Texte à trous'], notes: new Map(), nextId: 5000, actions: [], added: [], failMulti: false };
  const fp = n => {
    const f = n.fields || {};
    const key = /(clo|trou)/i.test(n.modelName || '') ? 'cloze' : 'basic';
    return key + ':' + String(Object.values(f)[0] ?? '').toLowerCase();
  };
  const addOne = note => {
    if (String(Object.values(note.fields || {})[0] ?? '').includes('REFUS')) throw new Error('cannot create note: refused by test');
    const k = fp(note);
    if (state.notes.has(k)) throw new Error('cannot create note because it is a duplicate');
    const id = ++state.nextId; state.notes.set(k, id); state.added.push(note); return id;
  };
  const handle = (action, prm) => {
    switch (action) {
      case 'version': return 6;
      case 'requestPermission': return { permission: 'granted', requireApiKey: false };
      case 'deckNames': return state.decks.slice();
      case 'createDeck': { const found = state.decks.find(d => d.toLowerCase() === String(prm.deck).toLowerCase()); if (!found) state.decks.push(String(prm.deck)); return 1700000000000 + state.decks.length; }
      case 'modelNames': return state.models.slice();
      case 'modelFieldNames': return /(clo|trou)/i.test(prm.modelName) ? ['Text', 'Back Extra'] : ['Front', 'Back'];
      case 'canAddNotes': { const seen = new Set(); return (prm.notes || []).map(n => { const k = fp(n); if (state.notes.has(k) || seen.has(k)) return false; seen.add(k); return true; }); }
      case 'addNote': return addOne(prm.note);
      case 'addNotes': {
        const notes = prm.notes || [];
        const bad = notes.findIndex(n => String(Object.values(n.fields || {})[0] ?? '').includes('REFUS') || state.notes.has(fp(n)));
        if (bad >= 0) throw new Error(`['cannot create note (index ${bad})']`);
        return notes.map(addOne);
      }
      case 'multi':
        if (state.failMulti) throw new Error('multi indisponible (test)');
        return (prm.actions || []).map(a => {
          state.actions.push('multi:' + a.action);
          try { return { result: handle(a.action, a.params || {}), error: null }; }
          catch (e) { return { result: null, error: e.message }; }
        });
      case 'findNotes': { const q = String(prm.query || ''); return q.includes('"Cours"') ? [...state.notes.values()] : []; }
      case 'notesInfo': return (prm.notes || []).map(id => ({ noteId: id, modelName: 'Basique', tags: ['chatgpt'], fields: { Front: { value: 'Note ' + id, order: 0 }, Back: { value: 'r', order: 1 } } }));
      default: throw new Error('unsupported action ' + action);
    }
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let out = { result: null, error: null };
      try {
        const p = JSON.parse(body || '{}');
        state.actions.push(p.action);
        out.result = handle(p.action, p.params || {});
      } catch (e) { out.error = e.message || String(e); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

/* Garde-fou : les tests d'intégration ne joignent QUE le faux AnkiConnect. Sans
   lui, après CLEAR_PORT, la détection automatique sonderait 8765 / 8766 et
   pourrait écrire dans le vrai Anki ouvert sur la machine de développement. */
const onlyMock = (port, seen = []) => (url, opt) => {
  seen.push(String(url));
  return String(url) === `http://127.0.0.1:${port}` ? globalThis.fetch(url, opt) : Promise.reject(new TypeError('hors du faux AnkiConnect : ' + url));
};
const SENDER = { id: 'test-extension-id', url: 'https://chatgpt.com/' };
// Objets créés dans le contexte vm : comparés par leur contenu JSON.
const plain = v => JSON.parse(JSON.stringify(v));
function send(listeners, message, sender = SENDER) {
  return new Promise(resolve => { const r = v => resolve(v); listeners[0](message, sender, r); });
}

async function integrationTests() {
  const { server, state, port } = await startMockAnki();
  const urls = [];
  const { ctx, listeners, storage } = bgContext({ fetchImpl: onlyMock(port, urls) });
  storage.ankiPort = port; // choix manuel pointant sur le faux AnkiConnect
  const cards = n => basic(n).map(c => ({ ...c, tags: ['test'] }));

  await ta('CONNECT via port choisi manuellement', async () => {
    const r = await send(listeners, { type: 'CONNECT' });
    assert.equal(r.ok, true, JSON.stringify(r));
  });
  await ta('DECKS renvoie les paquets du serveur simulé', async () => {
    const r = await send(listeners, { type: 'DECKS' });
    assert.deepEqual(r.value, ['Par défaut', 'Cours']);
  });
  await ta('PORT_INFO signale un port manuel', async () => {
    const r = await send(listeners, { type: 'PORT_INFO' });
    assert.equal(r.value.port, port); assert.equal(r.value.manual, true);
  });
  await ta('ANALYZE : 50 cartes neuves -> 50 « new »', async () => {
    storage.ankiPort = port; ctx.invalidatePort();
    const r = await send(listeners, { type: 'ANALYZE', deck: 'Cours', cards: cards(50) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value.items.filter(i => i.kind === 'new').length, 50);
  });
  await ta('ANALYZE refuse 101 cartes', async () => {
    const r = await send(listeners, { type: 'ANALYZE', deck: 'Cours', cards: cards(101) });
    assert.equal(r.ok, false); assert.match(r.error, /1–100/);
  });
  await ta('IMPORT : 100 cartes ajoutées', async () => {
    const r = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards: cards(100) });
    assert.equal(r.value.added, 100); assert.equal(r.value.skipped, 0);
  });
  await ta('IMPORT : réimport des 100 -> 0 ajoutée, 100 doublons', async () => {
    const r = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards: cards(100) });
    assert.equal(r.value.added, 0); assert.equal(r.value.skipped, 100);
  });
  await ta('tags : hiérarchie « :: » et lettres comme œ conservées', async () => {
    assert.equal(ctx.normalizeTag('Cardio::Item 221'), 'Cardio::Item_221');
    assert.equal(ctx.normalizeTag('cœur'), 'cœur');
    assert.equal(ctx.normalizeTag('a:b'), 'ab');
    assert.equal(ctx.normalizeTag('::a:::b::'), 'a::b');
    assert.equal(ctx.normalizeTag('<script>'), 'script');
  });
  await ta('IMPORT : un seul canAddNotes pour tout le lot', async () => {
    const before = state.actions.filter(a => a === 'canAddNotes').length;
    const r = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards: basic(30).map(c => ({ ...c, front: c.front + '-lot', tags: [] })) });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value.added, 30);
    assert.equal(state.actions.filter(a => a === 'canAddNotes').length - before, 1);
  });
  await ta('IMPORT : doublon interne au lot -> 1 ajoutée / 1 ignorée', async () => {
    const r = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards: [{ type: 'basic', front: 'X', back: '1' }, { type: 'basic', front: 'X', back: '1' }] });
    assert.equal(r.value.added, 1); assert.equal(r.value.skipped, 1);
  });
  await ta('IMPORT : cloze accepté (modèle « Texte à trous » présent)', async () => {
    const r = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards: [{ type: 'cloze', text: 'Le {{c1::cœur}} pompe.', extra: '' }] });
    assert.equal(r.value.added, 1);
  });
  await ta('IMPORT : 200 cartes refusé', async () => {
    const r = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards: cards(200) });
    assert.equal(r.ok, false); assert.match(r.error, /1–100/);
  });
  await ta('IMPORT : paquet inconnu refusé', async () => {
    const r = await send(listeners, { type: 'IMPORT', deck: 'Inexistant', cards: cards(1) });
    assert.equal(r.ok, false); assert.match(r.error, /Paquet introuvable/);
  });
  await ta('ANALYZE : tout en doublon -> tous « exact » (cas du message neutre)', async () => {
    const r = await send(listeners, { type: 'ANALYZE', deck: 'Cours', cards: cards(100) });
    assert.equal(r.value.items.length, 100);
    assert.ok(r.value.items.every(i => i.kind === 'exact'));
    assert.equal(r.value.items.filter(i => i.kind !== 'exact').length, 0);
  });
  await ta('SET_PORT puis CLEAR_PORT : le manuel est oublié, retour à la détection', async () => {
    await send(listeners, { type: 'SET_PORT', port: 49001 });
    assert.equal(storage.ankiPort, 49001);
    await send(listeners, { type: 'CLEAR_PORT' });
    assert.equal('ankiPort' in storage, false);
    // Retour au faux AnkiConnect pour la suite.
    storage.ankiPort = port; ctx.invalidatePort();
  });
  await ta('SÉCURITÉ : origine non autorisée rejetée', async () => {
    const r = await send(listeners, { type: 'DECKS' }, { id: 'test-extension-id', url: 'https://evil.example.com/' });
    assert.equal(r.ok, false); assert.match(r.error, /Origine non autorisée/);
  });
  await ta('SÉCURITÉ : mauvais identifiant d’extension rejeté', async () => {
    const r = await send(listeners, { type: 'DECKS' }, { id: 'other', url: 'chrome-extension://other/' });
    assert.equal(r.ok, false);
  });
  await ta('SÉCURITÉ : action inconnue rejetée', async () => {
    const r = await send(listeners, { type: 'DROP_TABLE' });
    assert.equal(r.ok, false); assert.match(r.error, /non autorisée/);
  });
  await ta('Aucune action d’écriture pendant la sonde de port', async () => {
    assert.ok(!state.actions.includes('deleteNotes'));
    assert.ok(!state.actions.includes('deleteDecks'));
  });

  await ta('isolement : aucune requête n’est partie ailleurs que vers le faux AnkiConnect', async () => {
    const others = urls.filter(u => u !== `http://127.0.0.1:${port}`);
    assert.ok(others.every(u => /:(8765|8766)$/.test(u)), 'seule la sonde (refusée) peut viser un port usuel : ' + others.join(', '));
    assert.equal((await send(listeners, { type: 'PORT' })).value, port, 'le port de test est de nouveau utilisé');
  });

  /* --- 1.6.0 : import groupé (multi) --- */
  const fresh = (n, tag) => basic(n).map(c => ({ ...c, front: c.front + '-' + tag, tags: [] }));
  const count = (a, before = []) => state.actions.filter(x => x === a).length - before.filter(x => x === a).length;
  await ta('IMPORT groupé : un seul appel multi, aucun addNote individuel', async () => {
    const before = state.actions.slice();
    const r = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards: fresh(40, 'multi') });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([r.value.added, r.value.skipped, r.value.errors.length], [40, 0, 0]);
    assert.equal(count('multi', before), 1, 'un seul envoi groupé');
    assert.equal(count('addNote', before), 0, 'aucun aller-retour par carte');
    assert.equal(count('multi:addNote', before), 40);
    assert.equal(count('addNotes', before), 0, 'addNotes (échec en bloc) jamais utilisé');
  });
  await ta('IMPORT groupé : échec partiel -> les autres cartes passent, erreur numérotée', async () => {
    const cards = fresh(5, 'partiel'); cards[1].front = 'REFUS carte deux'; cards[3].front = 'REFUS carte quatre';
    const r = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards });
    assert.equal(r.value.added, 3);
    assert.equal(r.value.skipped, 0);
    assert.deepEqual(plain(r.value.errors), ['Carte 2 : cannot create note: refused by test', 'Carte 4 : cannot create note: refused by test']);
  });
  await ta('IMPORT groupé : doublons et erreurs gardent le numéro de la carte d’origine', async () => {
    const cards = [{ type: 'basic', front: 'Q1-multi', back: 'déjà là' }, ...fresh(2, 'numero'), { type: 'basic', front: 'REFUS numéro 4', back: 'x' }];
    const r = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards });
    assert.deepEqual([r.value.added, r.value.skipped], [2, 1]);
    assert.deepEqual(plain(r.value.errors), ['Carte 4 : cannot create note: refused by test']);
  });
  await ta('IMPORT groupé : erreur globale de multi -> repli carte par carte, même résultat', async () => {
    state.failMulti = true;
    try {
      const before = state.actions.slice();
      const cards = fresh(5, 'repli'); cards[1].front = 'REFUS repli';
      const r = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.value.added, 4);
      assert.deepEqual(plain(r.value.errors), ['Carte 2 : cannot create note: refused by test']);
      assert.equal(count('addNote', before), 5, 'repli : un addNote par carte encore ajoutable');
      assert.equal(count('canAddNotes', before), 2, 'doublons recontrôlés avant le repli');
    } finally { state.failMulti = false; }
  });
  await ta('IMPORT groupé : multi écrit puis échoue -> aucune note écrite deux fois', async () => {
    const realHandle = state.failMulti;
    const addedBefore = state.added.length;
    // Simule un délai dépassé : Anki a écrit les notes mais la réponse est perdue.
    state.failMulti = false;
    const cards = fresh(3, 'perdu');
    const r0 = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards });
    assert.equal(r0.value.added, 3);
    state.failMulti = true;
    try {
      const r = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards });
      assert.equal(r.value.added, 0);
      assert.equal(r.value.skipped, 3, 'notes déjà présentes : signalées comme doublons');
      assert.equal(state.added.length - addedBefore, 3, 'jamais de double écriture');
    } finally { state.failMulti = realHandle; }
  });

  /* --- 1.6.0 : mise en forme et doublons --- */
  await ta('IMPORT : mise en forme convertie en HTML dans les champs Anki', async () => {
    const card = { type: 'basic', front: '**Ion** Na^+^ et H~2~O', back: 'Liste :\n- un\n- deux', tags: [] };
    const r = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards: [card] });
    assert.equal(r.value.added, 1);
    const note = state.added[state.added.length - 1];
    assert.equal(note.fields.Front, '<b>Ion</b> Na<sup>+</sup> et H<sub>2</sub>O');
    assert.equal(note.fields.Back, 'Liste :<ul><li>un</li><li>deux</li></ul>');
  });
  await ta('doublon : une carte reformatée à l’identique reste un doublon (analyse et import)', async () => {
    const card = { type: 'basic', front: '**Ion** Na^+^ et H~2~O', back: 'autre', tags: [] };
    const a = await send(listeners, { type: 'ANALYZE', deck: 'Cours', cards: [card] });
    assert.equal(a.value.items[0].kind, 'exact');
    const r = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards: [card] });
    assert.deepEqual([r.value.added, r.value.skipped], [0, 1]);
  });
  await ta('texte sans mise en forme : champ identique à la version 1.5 (doublons anciens reconnus)', async () => {
    const card = { type: 'basic', front: 'Ancienne <carte> & "guillemets"\nligne 2', back: 'r', tags: [] };
    await send(listeners, { type: 'IMPORT', deck: 'Cours', cards: [card] });
    const note = state.added[state.added.length - 1];
    assert.equal(note.fields.Front, 'Ancienne &lt;carte&gt; &amp; &quot;guillemets&quot;<br>ligne 2');
  });

  await ta('tags : « chatgpt » + 8 tags de la carte au maximum', async () => {
    const own = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];
    const cards = fresh(1, 'tag').map(c => ({ ...c, tags: own }));
    const r = await send(listeners, { type: 'IMPORT', deck: 'Cours', cards, batchTag: 'Ignoré' });
    assert.equal(r.value.added, 1);
    assert.deepEqual(plain(state.added[state.added.length - 1].tags), ['chatgpt', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
  });

  /* --- 1.6.0 : création de paquet --- */
  await ta('CREATE_DECK : sous-paquet « Parent::Enfant » créé, puis listé', async () => {
    const before = state.actions.slice();
    const r = await send(listeners, { type: 'CREATE_DECK', deck: '  Cardio :: Cours 3 ' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(plain(r.value), { deck: 'Cardio::Cours 3', created: true });
    assert.equal(count('createDeck', before), 1);
    const d = await send(listeners, { type: 'DECKS' });
    assert.ok(d.value.includes('Cardio::Cours 3'));
  });
  await ta('CREATE_DECK : paquet existant (casse ignorée) -> jamais recréé', async () => {
    const before = state.actions.slice();
    const r = await send(listeners, { type: 'CREATE_DECK', deck: 'cours' });
    assert.deepEqual(plain(r.value), { deck: 'Cours', created: false });
    assert.equal(count('createDeck', before), 0);
  });
  await ta('CREATE_DECK : noms vides, trop longs ou avec guillemets refusés sans écriture', async () => {
    const before = state.actions.slice();
    for (const deck of ['', '   ', '::', 'A::', 'A::::B', 'x'.repeat(151), 'Cours "3"', 'Cours « 3 »', null]) {
      const r = await send(listeners, { type: 'CREATE_DECK', deck });
      assert.equal(r.ok, false, 'accepté à tort : ' + JSON.stringify(deck));
    }
    assert.equal(count('createDeck', before), 0, 'aucune création');
    const ok = await send(listeners, { type: 'CREATE_DECK', deck: 'x'.repeat(150) });
    assert.equal(ok.ok, true, '150 caractères acceptés');
  });
  await ta('SÉCURITÉ : CREATE_DECK depuis une origine non autorisée rejeté', async () => {
    const before = state.actions.slice();
    const r = await send(listeners, { type: 'CREATE_DECK', deck: 'Pirate' }, { id: 'test-extension-id', url: 'https://evil.example.com/' });
    assert.equal(r.ok, false); assert.match(r.error, /Origine non autorisée/);
    assert.equal(count('createDeck', before), 0);
    assert.ok(!state.decks.includes('Pirate'));
  });
  await ta('import dans un paquet tout juste créé', async () => {
    const r = await send(listeners, { type: 'IMPORT', deck: 'Cardio::Cours 3', cards: fresh(2, 'nouveau') });
    assert.equal(r.value.added, 2);
    assert.ok(state.added.slice(-2).every(n => n.deckName === 'Cardio::Cours 3'));
  });
  await new Promise(r => server.close(r));
}

/* ------------------------------------------------------------------ *
 * 4. content.js : détection des cartes et bouton d’import (DOM simulé) *
 * ------------------------------------------------------------------ */
class El {
  constructor(tag, attrs = {}, text = null) {
    this.tagName = String(tag).toUpperCase();
    this._attrs = { ...attrs };
    this._text = text === null ? null : String(text);
    this.children = []; this.parent = null; this._listeners = {};
    this.className = this._attrs.class || '';
    this.dataset = new Proxy({}, { set: (t, k, v) => { t[k] = String(v); this._attrs['data-' + String(k).replace(/[A-Z]/g, m => '-' + m.toLowerCase())] = String(v); return true; } });
    this.style = { setProperty() {} };
    this.value = ''; this.checked = false; this.disabled = false; this._type = '';
    this.onclick = null; this.open = false; this.id = this._attrs.id || '';
  }
  // Comme dans le vrai DOM, `input.type = 'checkbox'` se reflète dans l'attribut.
  get type() { return this._type; }
  set type(v) { this._type = String(v); this._attrs.type = String(v); }
  get parentElement() { return (this.parent && this.parent.tagName !== '#TEXT') ? this.parent : null; }
  get nodeType() { return this.tagName === '#TEXT' ? 3 : 1; }
  get childNodes() { return this.children; }
  contains(n) { for (let x = n; x; x = x.parent || x.parentElement) if (x === this) return true; return false; }
  _classes() { return String(this.className || '').split(/\s+/).filter(Boolean); }
  get classList() {
    const s = this; return { add: c => { if (!s._classes().includes(c)) s.className = (s.className + ' ' + c).trim(); }, remove: c => { s.className = s._classes().filter(x => x !== c).join(' '); }, contains: c => s._classes().includes(c) };
  }
  get textContent() { return (this._text || '') + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerText() { return this.textContent; }
  get innerHTML() { return this.textContent; }
  get firstElementChild() { return this.children.find(c => c.tagName !== '#TEXT') || null; }
  get nextElementSibling() {
    if (!this.parent) return null;
    const sib = this.parent.children.slice(this.parent.children.indexOf(this) + 1);
    return sib.find(c => c.tagName !== '#TEXT') || null;
  }
  get previousElementSibling() {
    if (!this.parent) return null;
    const sib = this.parent.children.slice(0, this.parent.children.indexOf(this)).reverse();
    return sib.find(c => c.tagName !== '#TEXT') || null;
  }
  append(...kids) { for (const k of kids) { const n = typeof k === 'string' ? new El('#text', {}, k) : k; n.parent = this; this.children.push(n); } return this; }
  appendChild(k) { return this.append(k); }
  replaceChildren(...kids) { this._text = null; this.children = []; return this.append(...kids); }
  insertAdjacentElement(_pos, el) { const p = this.parent; if (!p) return null; p.children.splice(p.children.indexOf(this) + 1, 0, el); el.parent = p; return el; }
  remove() { if (!this.parent) return; const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; }
  setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'class') this.className = String(v); if (k === 'src' || k === 'href') this[k] = String(v); }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  removeAttribute(k) { delete this._attrs[k]; }
  hasAttribute(k) { return k in this._attrs; }
  getAttributeNames() { return Object.keys(this._attrs); }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener() {}
  dispatchEvent(ev) { for (const f of (this._listeners[ev.type] || [])) f({ preventDefault() {}, ...ev, target: this, type: ev.type, stopPropagation() {} }); return true; }
  focus() {} select() {} stopPropagation() {}
  click() { if (typeof this.onclick === 'function') this.onclick({ target: this, stopPropagation() {} }); for (const f of this._listeners.click || []) f({ target: this, stopPropagation() {} }); }
  _matchesSimple(sel) {
    sel = sel.trim(); if (!sel) return false;
    if (sel === '*') return this.tagName !== '#TEXT';
    const m = sel.match(/^([a-zA-Z#][a-zA-Z0-9-]*)?((?:[.#][\w-]+)*)((?:\[[^\]]+\])*)(:checked)?$/);
    if (!m) return false;
    const [, tag, classes, attrs, pseudo] = m;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (pseudo === ':checked' && !this.checked) return false;
    for (const c of (classes.match(/\.[\w-]+/g) || [])) if (!this._classes().includes(c.slice(1))) return false;
    for (const a of (attrs.match(/\[[^\]]+\]/g) || [])) {
      const [k, v] = a.slice(1, -1).split('=');
      if (v === undefined) { if (!this.hasAttribute(k)) return false; }
      else if (this.getAttribute(k) !== v.replace(/^["']|["']$/g, '')) return false;
    }
    return true;
  }
  matches(sel) {
    return sel.split(',').map(s => s.trim()).some(part => {
      const chain = part.split(/\s+/).filter(Boolean);
      if (!this._matchesSimple(chain[chain.length - 1])) return false;
      let node = this.parent;
      for (let i = chain.length - 2; i >= 0; i--) {
        while (node && !node._matchesSimple(chain[i])) node = node.parent;
        if (!node) return false; node = node.parent;
      }
      return true;
    });
  }
  _all(out) { for (const c of this.children) { if (c.tagName !== '#TEXT') { out.push(c); c._all(out); } } return out; }
  querySelectorAll(sel) { return this._all([]).filter(e => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) { let n = this; while (n) { if (n.matches(sel)) return n; n = n.parent; } return null; }
}
const h = (tag, attrs, ...kids) => { const e = new El(tag, attrs || {}); if (kids.length) e.append(...kids); return e; };

function contentHarness({ assistantBody, userBody, legacy, savedDeck = 'Cours', storage: initial = {} }, respond) {
  const root = h('div', { id: 'root' });
  if (userBody) {
    const ub = h('div', { 'data-user-message-bubble': '' }, h('div', { class: 'markdown' }, ...userBody));
    root.append(ub);
  }
  const attrs = legacy ? { 'data-message-author-role': 'assistant' } : { 'data-dil-source-message-id': 'msg-1' };
  root.append(h('div', attrs, h('div', { class: 'markdown' }, ...assistantBody)));

  const body = h('body');
  root.append(body);
  const documentListeners = {};
  const storage = { deck: savedDeck, ...initial };
  const doc = {
    documentElement: root, body,
    createElement: tag => new El(tag),
    createTextNode: t => new El('#text', {}, t),
    querySelectorAll: s => root.querySelectorAll(s),
    querySelector: s => root.querySelector(s),
    addEventListener: (t, f) => { (documentListeners[t] = documentListeners[t] || []).push(f); },
    removeEventListener: () => {}
  };
  const listeners = [];
  const observers = [];
  const ctx = {
    console, setTimeout, clearTimeout, Date, JSON, Promise, Event, document: doc,
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() {} },
    // display piloté par l'attribut data-display des fixtures (grille / flex / bloc)
    getComputedStyle: node => ({ display: (node && node._attrs && node._attrs['data-display']) || 'block' }),
    // getSelection remplaçable par un test (sélection simulée dans l'éditeur de trous).
    window: { selection: null, getSelection() { return this.selection || { removeAllRanges() {}, addRange() {}, rangeCount: 0, isCollapsed: true }; } },
    HTMLElement: class {}, HTMLTextAreaElement: class {},
    chrome: {
      runtime: {
        lastError: null,
        // respond peut renvoyer une promesse : nécessaire pour tester les courses
        sendMessage: (msg, cb) => { const r = respond(msg); if (r && typeof r.then === 'function') r.then(cb); else cb(r); },
        onMessage: { addListener: fn => listeners.push(fn) }
      },
      storage: { local: fakeStorage(storage) }
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of CONTENT_SCRIPTS()) load(ctx, f);
  return { ctx, root, body, listeners, observers, documentListeners, storage };
}
const countButtons = root => root.querySelectorAll('.ankibridge-btn').length;
const JSON13 = JSON.stringify({ cards: [...basic(10), { type: 'cloze', text: 'Le {{c1::GLOOP}} fabrique.', extra: '' }, { type: 'cloze', text: 'Le {{c1::ZORK}} sert.', extra: '' }, { type: 'cloze', text: 'Le GLOOP fait {{c1::42 blops}}.', extra: '' }] });
// Forme d'un item d'analyse telle que le backend la renvoie désormais.
const anItem = (kind, extra = {}) => ({ kind, duplicates: [], replaceable: false, blocked: null, note: '', ...extra });
// Ouvre la liste du sélecteur de paquet (le rendu est paresseux) et renvoie les options.
const pickerOptions = (root, query = '') => {
  const input = root.querySelector('.ankibridge-deckinput');
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return root.querySelectorAll('.ankibridge-deckoption');
};
const pickDeck = (root, query) => {
  const options = pickerOptions(root, query);
  if (!options.length) throw new Error('aucune option pour « ' + query + ' »');
  options[0].click();
  return options[0].getAttribute('data-value');
};

const respondOk = (analyzeItems) => (msg) => {
  if (msg.type === 'DECKS') return { ok: true, value: ['Cours', 'Par défaut'] };
  if (msg.type === 'ANALYZE') return { ok: true, value: { items: analyzeItems.map(i => anItem(i.kind, i)), totalExisting: 0, scanned: 0, partial: false, scope: 'Cours' } };
  if (msg.type === 'IMPORT') return { ok: true, value: { added: 13, skipped: 0, errors: [], total: 13 } };
  if (msg.type === 'REPLACE') return { ok: true, value: { updated: 1, skipped: 0, skippedDetails: [], failed: [], total: 1 } };
  return { ok: false, error: 'unexpected ' + msg.type };
};

async function contentTests() {
  await ta('DOM moderne : bouton « Ajouter 13 cartes à Anki » créé', async () => {
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    assert.equal(countButtons(root), 1);
    assert.equal(root.querySelector('.ankibridge-btn').textContent, 'Ajouter 13 cartes à Anki');
  });
  await ta('le conteneur du bouton est placé dans le message assistant, après le bloc de code', async () => {
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    const wrap = root.querySelector('.ankibridge-actions');
    const btn = root.querySelector('.ankibridge-btn');
    assert.ok(btn.closest('[data-dil-source-message-id]'), 'le bouton doit rester dans le message assistant');
    assert.equal(wrap.previousElementSibling.tagName, 'PRE', 'le conteneur suit le bloc de code');
  });
  await ta('re-rendu : un second scan sur le MÊME DOM ne duplique pas le conteneur', async () => {
    const { root, observers } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    assert.equal(root.querySelectorAll('.ankibridge-actions').length, 1);
    assert.ok(observers.length >= 1, 'aucun observateur enregistré');
    observers[0].fn();                       // rejoue le balayage, comme le fait le site
    await new Promise(r => setTimeout(r, 700));
    assert.equal(root.querySelectorAll('.ankibridge-actions').length, 1, 'conteneur dupliqué');
    assert.equal(root.querySelectorAll('.ankibridge-btn').length, 1, 'bouton dupliqué');
  });
  await ta('le message de l’utilisateur n’obtient jamais de bouton', async () => {
    const { root } = contentHarness({ userBody: [h('pre', {}, h('code', {}, JSON13))], assistantBody: [h('p', {}, 'réponse sans code')] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    assert.equal(countButtons(root), 0);
  });
  await ta('ancien DOM ([data-message-author-role]) toujours pris en charge', async () => {
    const { root } = contentHarness({ legacy: true, assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    assert.equal(countButtons(root), 1);
  });
  await ta('JSON invalide : aucun bouton', async () => {
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, 'ceci n’est pas du JSON'))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    assert.equal(countButtons(root), 0);
  });
  await ta('clic sur le bouton : modale avec 13 cartes et liste de paquets', async () => {
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 200));
    const ov = root.querySelector('.ankibridge-overlay');
    assert.ok(ov, 'overlay absent');
    assert.equal(ov.querySelectorAll('.ankibridge-card').length, 13);
    assert.equal(ov.querySelector('h2').textContent, 'Vérifier 13 cartes avant import');
    assert.deepEqual(pickerOptions(root).map(o => o.getAttribute('data-value')), ['Cours', 'Par défaut']);
  });
  await ta('UX : 100 % de doublons -> message neutre, aucun import envoyé', async () => {
    const sent = [];
    const respond = msg => { sent.push(msg.type); return respondOk(Array.from({ length: 13 }, () => ({ kind: 'exact' })))(msg); };
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respond);
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 300));
    const ov = root.querySelector('.ankibridge-overlay');
    ov.querySelector('.ankibridge-review').onclick();
    await new Promise(r => setTimeout(r, 250));
    ov.querySelector('.ankibridge-action').onclick();
    await new Promise(r => setTimeout(r, 250));
    assert.equal(ov.querySelector('.ankibridge-msg').textContent, 'Toutes les cartes existent déjà : aucune nouvelle carte ajoutée.');
    assert.ok(!sent.includes('IMPORT'), 'IMPORT ne doit pas être envoyé');
  });
  await ta('cartes neuves -> l’import est bien envoyé', async () => {
    const sent = [];
    const respond = msg => { sent.push(msg.type); return respondOk(Array.from({ length: 13 }, () => ({ kind: 'new' })))(msg); };
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respond);
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 300));
    const ov = root.querySelector('.ankibridge-overlay');
    ov.querySelector('.ankibridge-review').onclick();
    await new Promise(r => setTimeout(r, 250));
    ov.querySelector('.ankibridge-action').onclick();
    await new Promise(r => setTimeout(r, 400));
    assert.ok(sent.includes('IMPORT'), 'IMPORT attendu');
    assert.match(ov.querySelector('.ankibridge-msg').textContent, /13 ajoutée\(s\)/);
  });

  /* --- Lots de 100 cartes depuis un PDF --- */
  await ta('une carte mal formée n’efface plus le bouton : 99 cartes proposées, 1 signalée', async () => {
    const items = basic(100); items[9] = { type: 'cloze', text: 'pas de trou' };
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON.stringify({ cards: items })))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    assert.equal(root.querySelector('.ankibridge-btn').textContent, 'Ajouter 99 cartes à Anki');
    assert.match(root.querySelector('.ankibridge-parsenote').textContent, /1 carte mal formée ignorée/);
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 200));
    const ov = root.querySelector('.ankibridge-overlay');
    assert.equal(ov.querySelectorAll('.ankibridge-card').length, 99);
    assert.match(ov.querySelector('.ankibridge-rejected').textContent, /Carte 10 : cloze sans/);
  });
  await ta('230 cartes : 3 boutons de lot, chacun ouvre son lot', async () => {
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, json(230)))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    const btns = root.querySelectorAll('.ankibridge-btn');
    assert.equal(JSON.stringify(btns.map(b => b.textContent)), JSON.stringify(['Lot 1 : ajouter les cartes 1 à 100', 'Lot 2 : ajouter les cartes 101 à 200', 'Lot 3 : ajouter les cartes 201 à 230']));
    btns[2].click();
    await new Promise(r => setTimeout(r, 200));
    const ov = root.querySelector('.ankibridge-overlay');
    assert.equal(ov.querySelectorAll('.ankibridge-card').length, 30);
    assert.match(ov.querySelector('h2').textContent, /lot 201–230/);
  });
  await ta('réponse coupée : bouton proposé avec les cartes complètes et un avertissement', async () => {
    const full = json(40);
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, full.slice(0, full.indexOf('"Q31"') + 4)))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    assert.equal(root.querySelector('.ankibridge-btn').textContent, 'Ajouter 30 cartes à Anki');
    assert.match(root.querySelector('.ankibridge-parsenote').textContent, /réponse incomplète/);
  });
  await ta('deux blocs de code dans la même réponse : cartes additionnées', async () => {
    const second = JSON.stringify({ cards: basic(20).map(c => ({ ...c, front: c.front + '-bis' })) });
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, json(50))), h('p', {}, 'suite'), h('pre', {}, h('code', {}, second))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    assert.equal(countButtons(root), 1);
    assert.equal(root.querySelector('.ankibridge-btn').textContent, 'Ajouter 70 cartes à Anki');
  });

  /* --- régression PR #1 : courses entre analyse, édition et fermeture de la fenêtre --- */
  await ta('édition pendant une analyse en vol : la comparaison reste relançable', async () => {
    let release;
    const pending = new Promise(r => { release = r; });
    const sent = [];
    const respond = msg => {
      if (msg.type === 'DECKS') return { ok: true, value: ['Cours', 'Par défaut'] };
      sent.push(msg.type);
      return pending.then(() => ({ ok: true, value: { items: [], totalExisting: 0, scanned: 0, partial: false, scope: 'Cours' } }));
    };
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respond);
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 400));
    const ov = root.querySelector('.ankibridge-overlay');
    assert.equal(ov.querySelector('.ankibridge-review').disabled, true, 'analyse en vol : bouton attendu désactivé');
    ov.querySelectorAll('textarea')[0].dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    assert.equal(ov.querySelector('.ankibridge-review').disabled, false,
      'le bouton de comparaison reste bloqué après une édition pendant l’analyse');
    release();
    await new Promise(r => setTimeout(r, 150));
    assert.match(ov.querySelector('.ankibridge-msg').textContent, /relancer la comparaison/,
      'un résultat périmé ne doit pas écraser le message d’édition');
  });
  await ta('fermeture de la fenêtre pendant le chargement des paquets : aucune analyse déclenchée', async () => {
    let release;
    const pending = new Promise(r => { release = r; });
    const sent = [];
    const respond = msg => { sent.push(msg.type); return pending.then(() => respondOk([])(msg)); };
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respond);
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 200));
    const ov = root.querySelector('.ankibridge-overlay');
    assert.ok(ov, 'fenêtre attendue');
    assert.deepEqual(sent, ['DECKS'], 'seule la demande de paquets doit être en vol');
    ov.querySelector('.ankibridge-close').click();
    assert.equal(root.querySelector('.ankibridge-overlay'), null, 'la fenêtre doit être fermée');
    release();
    await new Promise(r => setTimeout(r, 300));
    assert.ok(!sent.includes('ANALYZE'), 'aucune analyse ne doit partir sur une fenêtre fermée');
  });
  await ta('fermeture par Échap pendant une analyse : le résultat périmé est ignoré', async () => {
    let release;
    const pending = new Promise(r => { release = r; });
    const respond = msg => {
      if (msg.type === 'DECKS') return { ok: true, value: ['Cours', 'Par défaut'] };
      return pending.then(() => ({ ok: true, value: { items: [], totalExisting: 0, scanned: 0, partial: false, scope: 'Cours' } }));
    };
    const { root, documentListeners } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respond);
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 400));
    const ov = root.querySelector('.ankibridge-overlay');
    const esc = (documentListeners.keydown || [])[0];
    assert.ok(esc, 'écouteur clavier attendu');
    const msgAvantFermeture = ov.querySelector('.ankibridge-msg').textContent;
    esc({ key: 'Escape' });
    assert.equal(root.querySelector('.ankibridge-overlay'), null, 'la fenêtre doit être fermée');
    release();
    await new Promise(r => setTimeout(r, 200));
    assert.equal(ov.querySelector('.ankibridge-msg').textContent, msgAvantFermeture,
      'la fenêtre fermée ne doit plus être mise à jour par un résultat périmé');
  });

  /* --- régression review PR #3 : état initial et statuts après écriture --- */
  await ta('cases désactivées et décochées tant que les paquets ne sont pas chargés', async () => {
    let release;
    const pending = new Promise(r => { release = r; });
    const respond = msg => msg.type === 'DECKS' ? pending.then(() => respondOk([])(msg)) : respondOk([])(msg);
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respond);
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 200));
    const ov = root.querySelector('.ankibridge-overlay');
    const boxes = ov.querySelectorAll('.ankibridge-pick');
    assert.equal(boxes.length, 13);
    assert.ok(boxes.every(b => b.disabled), 'aucune case ne doit être cochable avant le chargement des paquets');
    assert.ok(boxes.every(b => !b.checked), 'aucune case ne doit être cochée avant vérification');
    assert.match(ov.querySelector('.ankibridge-count').textContent, /^0 sélectionnée/);
    release();
    await new Promise(r => setTimeout(r, 400));
  });
  await ta('erreur de chargement des paquets : import impossible, cases bloquées', async () => {
    const respond = msg => msg.type === 'DECKS' ? { ok: false, error: 'Anki injoignable' } : respondOk([])(msg);
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respond);
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 400));
    const ov = root.querySelector('.ankibridge-overlay');
    assert.match(ov.querySelector('.ankibridge-msg').textContent, /Erreur/);
    assert.equal(ov.querySelector('.ankibridge-action').disabled, true, 'import impossible');
    assert.ok(ov.querySelectorAll('.ankibridge-pick').every(b => b.disabled), 'cases toujours bloquées');
  });
  await ta('après import, les statuts repassent en état neutre « à revérifier »', async () => {
    const items = Array.from({ length: 13 }, () => anItem('new'));
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk(items));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    const ov = root.querySelector('.ankibridge-overlay');
    assert.equal(ov.querySelectorAll('.ankibridge-row .ankibridge-dot.new').length, 13, 'statuts verts après analyse');
    ov.querySelector('.ankibridge-action').onclick();
    await new Promise(r => setTimeout(r, 500));
    assert.equal(ov.querySelectorAll('.ankibridge-row .ankibridge-dot.new').length, 0, 'aucun statut vert périmé après écriture');
    assert.equal(ov.querySelectorAll('.ankibridge-row .ankibridge-dot.pending').length, 13, 'statuts neutres attendus');
    assert.match(ov.querySelector('.ankibridge-sr').textContent, /À revérifier/);
  });

  await ta('message court après comparaison, sans discipline', async () => {
    const items = [...Array.from({ length: 10 }, () => anItem('new')), anItem('similar'), anItem('exact'), anItem('exact')];
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk(items));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    const ov = root.querySelector('.ankibridge-overlay');
    const msg = ov.querySelector('.ankibridge-msg').textContent;
    assert.equal(msg, '10 nouvelles · 1 à vérifier · 2 déjà dans Anki');
    assert.ok(!/m[ée]dical|m[ée]decine|clinique/i.test(msg));
    assert.equal(ov.querySelector('.ankibridge-action').textContent, 'Importer 10 cartes', 'le bouton dit ce qu’il va faire');
    ov.querySelectorAll('.ankibridge-pick')[0].checked = false;
    ov.querySelectorAll('.ankibridge-pick')[0].dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal(ov.querySelector('.ankibridge-action').textContent, 'Importer 9 cartes');
    assert.equal(ov.querySelector('.ankibridge-replace').hidden, true, 'pas de bouton « remplacer » sans mise à jour cochée');
    for (const gone of ['.ankibridge-taginput', '.ankibridge-recap', '.ankibridge-newdeckbtn', '.ankibridge-decktoggle']) assert.equal(ov.querySelector(gone), null, gone + ' retiré');
    assert.equal(ov.querySelectorAll('.ankibridge-notice')[0].textContent, '', 'carte nouvelle : aucun message');
  });

  /* --- ancrage du bouton (régression : colonne étirée dans la grille ChatGPT) --- */
  await ta('bouton : enveloppé dans .ankibridge-actions, unique, juste après le bloc de code', async () => {
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    const wraps = root.querySelectorAll('.ankibridge-actions');
    assert.equal(wraps.length, 1, 'un seul conteneur attendu');
    assert.equal(wraps[0].querySelectorAll('.ankibridge-btn').length, 1);
    assert.equal(wraps[0].previousElementSibling.tagName, 'PRE', 'le conteneur suit le bloc de code');
    assert.equal(root.querySelectorAll('.ankibridge-btn').length, 1);
  });
  await ta('grille ChatGPT : le bouton n’est PAS inséré dans le conteneur grid', async () => {
    const grid = h('div', { 'data-display': 'grid' }, h('pre', {}, h('code', {}, JSON13)));
    const { root } = contentHarness({ assistantBody: [grid] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    const wrap = root.querySelector('.ankibridge-actions');
    assert.ok(wrap, 'conteneur absent');
    assert.notEqual(wrap.parentElement, grid, 'le bouton ne doit pas être un item de la grille');
    assert.equal(wrap.previousElementSibling, grid, 'le bouton doit être placé après la grille');
  });
  await ta('flex : le bouton reste hors du conteneur flex', async () => {
    const flex = h('div', { 'data-display': 'flex' }, h('pre', {}, h('code', {}, JSON13)));
    const { root } = contentHarness({ assistantBody: [flex] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    const wrap = root.querySelector('.ankibridge-actions');
    assert.notEqual(wrap.parentElement, flex);
  });
  await ta('CSS : conteneur neutralisant grille/flex + bouton compact', () => {
    const css = fs.readFileSync(EXT('content.css'), 'utf8');
    const actions = (css.match(/\.ankibridge-actions\s*\{([^}]*)\}/) || [])[1] || '';
    for (const p of ['grid-column', 'align-self', 'width:100%', 'height:auto', 'flex:0 0 auto']) assert.ok(actions.includes(p), 'règle .ankibridge-actions sans ' + p);
    const btn = (css.match(/\.ankibridge-btn\s*\{([^}]*)\}/) || [])[1] || '';
    for (const p of ['display:inline-flex', 'width:max-content', 'align-items:center', 'justify-content:center', 'height:auto', 'flex:none', 'min-height', 'max-width:100%']) assert.ok(btn.includes(p), 'règle .ankibridge-btn sans ' + p);
  });

  /* --- hiérarchie des paquets + comparaison automatique --- */
  const DECKS_H = ['Cardiologie', 'Cardiologie::Item 221 — Test', 'Cardiologie::Item 221 — Test::Sous-item'];
  const respondDecks = (decks, calls) => msg => {
    if (msg.type === 'DECKS') return { ok: true, value: decks };
    if (msg.type === 'ANALYZE') { calls.push(msg.deck); return { ok: true, value: { items: Array.from({ length: 13 }, () => anItem('new')), totalExisting: 0, scanned: 0, partial: false, scope: msg.deck } }; }
    return { ok: true, value: { added: 13, skipped: 0, errors: [], total: 13 } };
  };
  await ta('paquets : libellé hiérarchique, valeur = nom complet « Parent::Enfant »', async () => {
    const calls = [];
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondDecks(DECKS_H, calls));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 600));
    const opts = pickerOptions(root);
    assert.deepEqual(opts.map(o => o.getAttribute('data-value')), DECKS_H);
    assert.deepEqual(opts.map(o => o.textContent), ['Cardiologie', 'Cardiologie › Item 221 — Test', 'Cardiologie › Item 221 — Test › Sous-item']);
  });
  await ta('comparaison automatique à l’ouverture, sur le paquet mémorisé', async () => {
    const calls = [];
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))], savedDeck: 'Cardiologie::Item 221 — Test' }, respondDecks(DECKS_H, calls));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    assert.ok(calls.length >= 1, 'aucune analyse automatique déclenchée');
    assert.equal(calls[0], 'Cardiologie::Item 221 — Test', 'analyse faite sur le mauvais paquet');
    assert.equal(root.querySelector('.ankibridge-overlay .ankibridge-action').disabled, false, 'import non réactivé après analyse');
  });
  await ta('changer de paquet relance la comparaison automatiquement (sans clic)', async () => {
    const calls = [];
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))], savedDeck: 'Cardiologie' }, respondDecks(DECKS_H, calls));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    const before = calls.length;
    const ov = root.querySelector('.ankibridge-overlay');
    pickDeck(root, 'Sous-item');
    assert.equal(ov.querySelector('.ankibridge-action').disabled, true, 'import doit être désactivé pendant la nouvelle comparaison');
    await new Promise(r => setTimeout(r, 1200));
    assert.ok(calls.length > before, 'aucune analyse relancée après changement de paquet');
    assert.equal(calls[calls.length - 1], 'Cardiologie::Item 221 — Test::Sous-item');
    assert.equal(ov.querySelector('.ankibridge-action').disabled, false, 'import non réactivé');
  });
  await ta('anti-course : un résultat périmé n’écrase pas le paquet courant', async () => {
    let n = 0;
    const respond = msg => {
      if (msg.type === 'DECKS') return { ok: true, value: ['Lent', 'Rapide'] };
      if (msg.type === 'ANALYZE') {
        n++;
        const first = n === 1;
        const value = { items: Array.from({ length: 13 }, () => anItem(first ? 'exact' : 'new')), totalExisting: 0, scanned: 0, partial: false, scope: msg.deck };
        // 1re analyse (paquet « Lent ») répond APRÈS la 2e : son résultat doit être ignoré
        return first ? new Promise(r => setTimeout(() => r({ ok: true, value }), 1200)) : { ok: true, value };
      }
      return { ok: true, value: { added: 0, skipped: 0, errors: [], total: 0 } };
    };
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))], savedDeck: 'Lent' }, respond);
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 250));
    const ov = root.querySelector('.ankibridge-overlay');
    pickDeck(root, 'Rapide');
    await new Promise(r => setTimeout(r, 2500));
    const checkedCount = [...ov.querySelectorAll('.ankibridge-pick')].filter(x => x.checked).length;
    assert.equal(checkedCount, 13, 'le résultat périmé (doublons) a été appliqué à tort');
    assert.equal(ov.querySelector('.ankibridge-action').disabled, false);
  });
  await ta('bouton manuel renommé « Relancer la comparaison » (secours)', async () => {
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 400));
    assert.equal(root.querySelector('.ankibridge-overlay .ankibridge-review').textContent, 'Relancer la comparaison');
  });

  /* --- recherche de paquet (combobox) --- */
  const DECKS_R = ['Médecine (TEST)::Cardiologie::Item TEST 01 — Anatomie du cœur', 'Médecine (TEST)::Pneumologie', 'Par défaut'];
  await ta('recherche : casse et accents ignorés, mots dans le désordre, « Aucun résultat »', async () => {
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondDecks(DECKS_R, []));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 600));
    assert.equal(pickerOptions(root, 'ANATOMIE').length, 1, 'insensible à la casse');
    assert.equal(pickerOptions(root, 'coeur').length, 1, 'insensible aux accents');
    assert.equal(pickerOptions(root, 'cardio coeur').length, 1, 'mots dans le désordre');
    assert.equal(pickerOptions(root, 'zzz').length, 0);
    assert.ok(root.querySelector('.ankibridge-deckempty'), 'message « Aucun résultat » attendu');
    const opt = pickerOptions(root, 'pneumo')[0];
    assert.equal(opt.getAttribute('data-value'), 'Médecine (TEST)::Pneumologie', 'valeur = nom complet');
    assert.equal(opt.textContent, 'Médecine (TEST) › Pneumologie', 'libellé lisible');
  });
  await ta('clavier : taper ne relance pas l’analyse, Entrée sélectionne', async () => {
    const calls = [];
    const decks = ['Cardiologie', 'Pneumologie'];
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))], savedDeck: 'Cardiologie' }, respondDecks(decks, calls));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    const before = calls.length;
    const input = root.querySelector('.ankibridge-deckinput');
    input.value = 'pneumo';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    assert.equal(calls.length, before, 'taper ne doit pas relancer la comparaison');
    input.dispatchEvent({ type: 'keydown', key: 'Enter' });
    await new Promise(r => setTimeout(r, 900));
    assert.ok(calls.length > before, 'Entrée doit lancer la comparaison');
    assert.equal(calls[calls.length - 1], 'Pneumologie');
  });
  await ta('1000 paquets : liste plafonnée à 50 avec message, recherche ciblée exacte', async () => {
    const decks = Array.from({ length: 1000 }, (_, i) => `Spécialité ${i}::Item ${i}`);
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondDecks(decks, []));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 600));
    assert.equal(pickerOptions(root).length, 50, 'affichage plafonné');
    assert.ok(root.querySelector('.ankibridge-deckmore'), 'message de précision attendu');
    const found = pickerOptions(root, 'Spécialité 777');
    assert.equal(found.length, 1);
    assert.equal(found[0].getAttribute('data-value'), 'Spécialité 777::Item 777');
  });

  /* --- sélection des cartes --- */
  const items5new8exact = [...Array.from({ length: 5 }, () => anItem('new')), ...Array.from({ length: 8 }, () => anItem('exact'))];
  await ta('sélection : cases individuelles, tout sélectionner (nouvelles), tout désélectionner, décompte', async () => {
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk(items5new8exact));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    const ov = root.querySelector('.ankibridge-overlay');
    const picks = () => ov.querySelectorAll('.ankibridge-pick').filter(x => x.checked).length;
    assert.equal(picks(), 5, 'seules les cartes nouvelles sont cochées après analyse');
    assert.match(ov.querySelector('.ankibridge-count').textContent, /5 sélectionnée\(s\) sur 13/);
    const first = ov.querySelectorAll('.ankibridge-pick')[0];
    first.checked = false; first.dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal(picks(), 4, 'décochage individuel pris en compte');
    assert.match(ov.querySelector('.ankibridge-count').textContent, /4 sélectionnée\(s\) sur 13/);
    ov.querySelector('.ankibridge-selectnew').onclick();
    assert.equal(picks(), 5, 'tout sélectionner coche les cartes nouvelles');
    ov.querySelector('.ankibridge-selectnone').onclick();
    assert.equal(picks(), 0, 'tout désélectionner');
    assert.match(ov.querySelector('.ankibridge-count').textContent, /0 sélectionnée\(s\) sur 13/);
  });
  const DUP_OK = { id: 4242, model: 'Basique', deck: 'Cours', decks: ['Cours'], certain: true, compatible: true, mod: 111, second: 'Ancienne réponse', front: 'Q1', back: 'Ancienne réponse' };
  await ta('doublon localisé : identifiant, paquet exact et modèle affichés', async () => {
    const dup = { ...DUP_OK, deck: 'Médecine (TEST)::Cardiologie::Item TEST 01 — Anatomie du cœur' };
    const items = [anItem('exact', { duplicates: [dup], replaceable: true }), ...Array.from({ length: 12 }, () => anItem('new'))];
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk(items));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    const notice = root.querySelector('.ankibridge-overlay .ankibridge-notice');
    assert.match(notice.textContent, /#4242/);
    assert.match(notice.textContent, /Médecine \(TEST\) › Cardiologie › Item TEST 01/);
    assert.match(notice.textContent, /Basique/);
  });
  await ta('ambiguïté : plusieurs notes identiques -> remplacement bloqué, toutes listées', async () => {
    const items = [anItem('exact', { duplicates: [{ ...DUP_OK, id: 1 }, { ...DUP_OK, id: 2, deck: 'Autre' }], replaceable: false, blocked: 'ambigu' }), ...Array.from({ length: 12 }, () => anItem('new'))];
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk(items));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    const ov = root.querySelector('.ankibridge-overlay');
    assert.equal(ov.querySelectorAll('.ankibridge-replacebox-input').length, 0, 'aucun remplacement proposé');
    assert.equal(ov.querySelectorAll('.ankibridge-duphead').length, 2, 'les deux notes sont listées');
    assert.equal(ov.querySelector('.ankibridge-replace').disabled, true);
  });
  await ta('remplacement : proposé seulement si certain, décoché par défaut, annuler = aucune écriture', async () => {
    const sent = [];
    const items = [anItem('exact', { duplicates: [DUP_OK], replaceable: true }), ...Array.from({ length: 12 }, () => anItem('new'))];
    const respond = msg => { sent.push(msg.type); return respondOk(items)(msg); };
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respond);
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    const ov = root.querySelector('.ankibridge-overlay');
    const box = ov.querySelector('.ankibridge-replacebox-input');
    assert.ok(box, 'case de remplacement attendue');
    assert.equal(box.checked, false, 'aucun remplacement coché par défaut');
    assert.equal(ov.querySelector('.ankibridge-replace').disabled, true);
    assert.ok(ov.querySelector('.ankibridge-diff'), 'aperçu avant/après attendu');
    box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal(ov.querySelector('.ankibridge-replace').disabled, false);
    ov.querySelector('.ankibridge-replace').onclick();
    await new Promise(r => setTimeout(r, 200));
    assert.ok(ov.querySelector('.ankibridge-confirm'), 'confirmation attendue');
    ov.querySelector('.ankibridge-cancel').onclick();
    await new Promise(r => setTimeout(r, 200));
    assert.ok(!sent.includes('REPLACE'), 'aucune écriture après annulation');
    assert.match(ov.querySelector('.ankibridge-msg').textContent, /annulé/);
  });
  await ta('remplacement confirmé : charge utile exacte, sans tags, avec instantané', async () => {
    let payload = null;
    const items = [anItem('exact', { duplicates: [DUP_OK], replaceable: true }), ...Array.from({ length: 12 }, () => anItem('new'))];
    const respond = msg => { if (msg.type === 'REPLACE') payload = msg.replacements; return respondOk(items)(msg); };
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respond);
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    const ov = root.querySelector('.ankibridge-overlay');
    const box = ov.querySelector('.ankibridge-replacebox-input');
    box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
    ov.querySelector('.ankibridge-replace').onclick();
    await new Promise(r => setTimeout(r, 200));
    ov.querySelector('.ankibridge-confirmok').onclick();
    await new Promise(r => setTimeout(r, 300));
    assert.ok(payload, 'REPLACE attendu');
    assert.equal(payload.length, 1);
    assert.deepEqual(Object.keys(payload[0]).sort(),
      ['deck', 'decks', 'fingerprint', 'first', 'model', 'mod', 'noteId', 'originalSecond', 'second', 'type'].sort());
    assert.equal(payload[0].noteId, 4242);
    assert.equal(payload[0].model, 'Basique');
    assert.equal(payload[0].deck, 'Cours');
    assert.deepEqual(payload[0].decks, ['Cours'], 'ensemble des paquets transmis pour l’anti-conflit');
    assert.equal(payload[0].type, 'basic');
    assert.equal(payload[0].fingerprint, 'Q1');
    assert.equal(payload[0].originalSecond, 'Ancienne réponse');
    assert.equal(payload[0].mod, 111);
    assert.equal(payload[0].second, 'R1');
    assert.ok(!('tags' in payload[0]), 'aucun tag transmis');
  });
  await ta('édition d’une carte : remplacement invalidé, case retirée, bouton désactivé', async () => {
    const items = [anItem('exact', { duplicates: [DUP_OK], replaceable: true }), ...Array.from({ length: 12 }, () => anItem('new'))];
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk(items));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    const ov = root.querySelector('.ankibridge-overlay');
    const box = ov.querySelector('.ankibridge-replacebox-input');
    box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal(ov.querySelector('.ankibridge-replace').disabled, false);
    const area = ov.querySelectorAll('.ankibridge-card textarea')[0];
    area.value = 'Q1 modifiée'; area.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(ov.querySelector('.ankibridge-replace').disabled, true, 'remplacement invalidé après édition');
    assert.equal(ov.querySelectorAll('.ankibridge-replacebox-input').length, 0, 'case de remplacement retirée');
  });
  await ta('sécurité : XSS dans le contenu d’une note n’est pas interprété', async () => {
    const items = [anItem('exact', { duplicates: [{ ...DUP_OK, front: '<img src=x onerror=alert(1)>', back: '<script>alert(2)</script>' }], replaceable: true }), ...Array.from({ length: 12 }, () => anItem('new'))];
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk(items));
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    const ov = root.querySelector('.ankibridge-overlay');
    assert.equal(ov.querySelectorAll('img').length, 0, 'aucune balise image créée');
    assert.equal(ov.querySelectorAll('script').length, 0, 'aucune balise script créée');
    assert.match(ov.querySelector('.ankibridge-notice').textContent, /onerror/);
  });

  /* --- visibilité des cases et statuts des cartes --- */
  const rowsOf = ov => ov.querySelectorAll('.ankibridge-row');
  const dotOf = (ov, i) => rowsOf(ov)[i].querySelector('.ankibridge-dot');
  const pickOf = (ov, i) => rowsOf(ov)[i].querySelector('.ankibridge-pick');
  const srOf = (ov, i) => rowsOf(ov)[i].querySelector('.ankibridge-sr');
  const openModal = async (respond, cardsJson = JSON13, savedDeck = 'Cours') => {
    const h2 = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, cardsJson))], savedDeck }, respond);
    await new Promise(r => setTimeout(r, 700));
    h2.root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    return h2.root.querySelector('.ankibridge-overlay');
  };

  await ta('structure : case visible même repliée, hors de <summary> et de <details>', async () => {
    const ov = await openModal(respondOk(items5new8exact));
    assert.equal(rowsOf(ov).length, 13);
    assert.equal(ov.querySelectorAll('.ankibridge-pick').length, 13, 'une case par ligne');
    for (let i = 0; i < 13; i++) {
      assert.equal(pickOf(ov, i).closest('summary'), null, 'la case ne doit pas être dans <summary>');
      assert.equal(pickOf(ov, i).closest('details'), null, 'la case ne doit pas être dans <details>');
      assert.ok(pickOf(ov, i).closest('summary') === null && pickOf(ov, i).parentElement === rowsOf(ov)[i],
        'la case doit être un frère direct de <details>');
    }
    const title = rowsOf(ov)[0].querySelector('.ankibridge-title');
    assert.ok(title.closest('summary'), 'le titre doit être dans <summary> pour déplier au clic');
    assert.ok([...ov.querySelectorAll('.ankibridge-card')].every(d => d.open === false), 'aucune ligne ouverte d’office');
  });
  await ta('titre : type de note conservé et texte peu tronqué', async () => {
    const ov = await openModal(respondOk(items5new8exact));
    const titles = rowsOf(ov).map(r => r.querySelector('.ankibridge-title').textContent);
    assert.match(titles[0], /^1\. \[Basique\] Q1/);
    assert.match(titles[10], /^11\. \[Texte à trous\] Le \[GLOOP\] fabrique\./, 'trou montré « [réponse] », sans syntaxe');
  });
  await ta('statuts : point + libellé accessible + tooltip, sans ouvrir les lignes', async () => {
    const items = [anItem('new'), anItem('similar'), anItem('exact'), ...Array.from({ length: 10 }, () => anItem('new'))];
    const ov = await openModal(respondOk(items));
    assert.equal(dotOf(ov, 0).getAttribute('aria-label'), 'Nouvelle');
    assert.equal(dotOf(ov, 0).getAttribute('title'), 'Nouvelle');
    assert.ok(dotOf(ov, 0).className.includes('new'));
    assert.equal(srOf(ov, 0).textContent, 'Nouvelle');
    assert.equal(dotOf(ov, 1).getAttribute('aria-label'), 'Formulation similaire');
    assert.ok(dotOf(ov, 1).className.includes('similar'));
    assert.equal(srOf(ov, 1).textContent, 'Formulation similaire');
    assert.equal(dotOf(ov, 2).getAttribute('aria-label'), 'Déjà présente');
    assert.ok(dotOf(ov, 2).className.includes('exact'));
    assert.equal(srOf(ov, 2).textContent, 'Déjà présente');
    assert.equal(dotOf(ov, 2).getAttribute('role'), 'img');
    assert.ok(pickOf(ov, 0).getAttribute('aria-describedby'), 'libellé de statut lié à la case');
    assert.ok([...ov.querySelectorAll('.ankibridge-card')].every(d => d.open === false), 'statuts visibles sans déplier');
    // légende : les trois statuts sont expliqués en clair
    const legend = ov.querySelector('.ankibridge-legend').textContent;
    for (const word of ['Nouvelle', 'Formulation similaire', 'Déjà présente']) assert.ok(legend.includes(word), 'légende sans ' + word);
  });
  await ta('doublon exact : case d’import désactivée, décochée, expliquée', async () => {
    const items = [anItem('new'), anItem('exact'), ...Array.from({ length: 11 }, () => anItem('new'))];
    const ov = await openModal(respondOk(items));
    assert.equal(pickOf(ov, 1).disabled, true, 'case d’import désactivée pour un doublon exact');
    assert.equal(pickOf(ov, 1).checked, false, 'doublon exact jamais coché');
    assert.equal(pickOf(ov, 0).disabled, false);
    assert.match(rowsOf(ov)[1].querySelector('.ankibridge-notice').textContent, /Déjà dans Anki/);
    // le contrôle de remplacement est DISTINCT et seulement sous le détail
    const itemsR = [anItem('new'), anItem('exact', { duplicates: [DUP_OK], replaceable: true }), ...Array.from({ length: 11 }, () => anItem('new'))];
    const ov2 = await openModal(respondOk(itemsR));
    const replaceBox = rowsOf(ov2)[1].querySelector('.ankibridge-replacebox-input');
    assert.ok(replaceBox, 'contrôle de remplacement attendu');
    assert.notEqual(replaceBox.className, pickOf(ov2, 1).className, 'contrôles distincts');
    assert.ok(replaceBox.closest('details'), 'le remplacement vit dans le détail');
    assert.equal(pickOf(ov2, 1).closest('details'), null);
  });
  await ta('compteur instantané : tout sélectionner (nouvelles) n’exact jamais un doublon', async () => {
    const items = [anItem('new'), anItem('exact'), anItem('similar'), ...Array.from({ length: 10 }, () => anItem('new'))];
    const ov = await openModal(respondOk(items));
    assert.match(ov.querySelector('.ankibridge-count').textContent, /11 sélectionnée\(s\) sur 13/);
    ov.querySelector('.ankibridge-selectnone').onclick();
    assert.match(ov.querySelector('.ankibridge-count').textContent, /0 sélectionnée\(s\) sur 13/);
    ov.querySelector('.ankibridge-selectnew').onclick();
    assert.match(ov.querySelector('.ankibridge-count').textContent, /11 sélectionnée\(s\) sur 13/);
    assert.equal(pickOf(ov, 1).checked, false, 'un doublon exact ne se réactive pas');
    assert.equal(pickOf(ov, 2).checked, false, 'une ressemblance ne se réactive pas toute seule');
  });
  await ta('état intermédiaire : points neutres pendant la comparaison, statuts ensuite', async () => {
    let resolveAnalyze = null;
    const respond = msg => {
      if (msg.type === 'DECKS') return { ok: true, value: ['Cours'] };
      if (msg.type === 'ANALYZE') return new Promise(r => { resolveAnalyze = () => r({ ok: true, value: { items: Array.from({ length: 13 }, () => anItem('new')), totalExisting: 0, scanned: 0, partial: false, scope: msg.deck } }); });
      return { ok: true, value: { added: 0, skipped: 0, errors: [], total: 0 } };
    };
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respond);
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 300));
    const ov = root.querySelector('.ankibridge-overlay');
    const dots = () => [...ov.querySelectorAll('.ankibridge-row .ankibridge-dot')];
    assert.ok(dots().length === 13);
    assert.ok(dots().every(d => d.className.includes('pending')), 'points neutres pendant la comparaison');
    assert.ok(dots().every(d => d.getAttribute('aria-label') === 'Comparaison en cours'));
    assert.ok([...ov.querySelectorAll('.ankibridge-pick')].every(c => c.disabled === true), 'cases désactivées pendant la comparaison');
    resolveAnalyze();
    await new Promise(r => setTimeout(r, 400));
    assert.ok(dots().every(d => d.className.includes('new')), 'statuts appliqués après la comparaison');
    assert.ok([...ov.querySelectorAll('.ankibridge-pick')].every(c => c.disabled === false));
  });
  await ta('changement de paquet : nouveaux statuts, doublons exacts jamais réactivés', async () => {
    const respond = msg => {
      if (msg.type === 'DECKS') return { ok: true, value: ['A', 'B'] };
      if (msg.type === 'ANALYZE') return { ok: true, value: { items: Array.from({ length: 13 }, (_, i) => anItem(i < 3 ? 'exact' : 'new')), totalExisting: 0, scanned: 0, partial: false, scope: msg.deck } };
      return { ok: true, value: { added: 0, skipped: 0, errors: [], total: 0 } };
    };
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))], savedDeck: 'A' }, respond);
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    const ov = root.querySelector('.ankibridge-overlay');
    assert.equal([...ov.querySelectorAll('.ankibridge-pick')].filter(x => x.disabled).length, 3);
    pickDeck(root, 'B');
    await new Promise(r => setTimeout(r, 1200));
    assert.equal([...ov.querySelectorAll('.ankibridge-pick')].filter(x => x.disabled).length, 3, 'les 3 exacts restent désactivés');
    assert.equal([...ov.querySelectorAll('.ankibridge-pick')].filter(x => x.checked).length, 10);
    assert.ok([...ov.querySelectorAll('.ankibridge-row .ankibridge-dot')].filter(d => d.className.includes('exact')).length === 3);
    ov.querySelector('.ankibridge-selectnew').onclick();
    assert.equal([...ov.querySelectorAll('.ankibridge-pick')].filter(x => x.checked).length, 10, 'jamais de réactivation des exacts');
  });
  await ta('CSS : la case est dessinée par nos règles, indépendante du thème et de la page', () => {
    const css = fs.readFileSync(EXT('content.css'), 'utf8');
    const pick = (css.match(/\.ankibridge-pick\s*\{([^}]*)\}/) || [])[1] || '';
    for (const p of ['appearance:none', 'width:18px', 'height:18px', 'border:2px solid', 'background:#fff', 'color-scheme:light']) {
      assert.ok(pick.includes(p), 'règle .ankibridge-pick sans ' + p);
    }
    assert.ok(/\.ankibridge-pick:checked\{[^}]*background:#15803d/.test(css), 'état coché sans fond explicite');
    assert.ok(/\.ankibridge-pick:checked\{[^}]*background-image:url\("data:image\/svg\+xml/.test(css), 'coche dessinée absente');
    assert.ok(/\.ankibridge-pick:disabled\{[^}]*background:#e2e8f0/.test(css), 'état désactivé sans fond explicite');
    assert.ok(/\.ankibridge-dialog\{[^}]*color-scheme:light/.test(css), 'le dialogue doit forcer le schéma clair');
  });
  await ta('lot de 50 cartes : 50 lignes, 50 cases visibles, statuts corrects', async () => {
    const items = Array.from({ length: 50 }, (_, i) => anItem(i < 20 ? 'new' : i < 35 ? 'similar' : 'exact'));
    const ov = await openModal(respondOk(items), JSON.stringify({ cards: basic(50) }));
    assert.equal(rowsOf(ov).length, 50);
    assert.equal(ov.querySelectorAll('.ankibridge-pick').length, 50);
    assert.equal([...ov.querySelectorAll('.ankibridge-pick')].filter(x => x.checked).length, 20);
    assert.equal([...ov.querySelectorAll('.ankibridge-pick')].filter(x => x.disabled).length, 15);
    const dots = [...ov.querySelectorAll('.ankibridge-row .ankibridge-dot')];
    assert.equal(dots.filter(d => d.className.includes('exact')).length, 15);
    assert.equal(dots.filter(d => d.className.includes('similar')).length, 15);
    assert.equal(dots.filter(d => d.className.includes('new')).length, 20);
  });

  /* --- 1.6.0 : aperçu mis en forme --- */
  const FMT = JSON.stringify({ cards: [
    { type: 'basic', front: '**Gras** et Na^+^', back: 'Liste :\n- un\n- deux' },
    { type: 'cloze', text: 'L’eau : {{c1::H~2~O::formule}}', extra: '' },
    { type: 'basic', front: '<img src=x onerror=alert(1)> **<script>alert(2)</script>**', back: '`<b>`' }
  ] });
  const items3 = Array.from({ length: 3 }, () => anItem('new'));
  await ta('aperçu : mis en forme à côté du texte modifiable, mis à jour à la frappe', async () => {
    const ov = await openModal(respondOk(items3), FMT);
    const row = rowsOf(ov)[0];
    const fields = row.querySelectorAll('.ankibridge-field');
    assert.equal(fields.length, 2, 'question et réponse ont chacune leur aperçu');
    assert.ok(fields[0].querySelector('textarea') && fields[0].querySelector('.ankibridge-preview'), 'texte et aperçu côte à côte');
    const body0 = fields[0].querySelector('.ankibridge-previewbody');
    assert.equal(body0.querySelector('b').textContent, 'Gras');
    assert.equal(body0.querySelector('sup').textContent, '+');
    assert.equal(fields[1].querySelectorAll('.ankibridge-previewbody ul li').length, 2);
    assert.equal(row.querySelector('.ankibridge-title').textContent, '1. [Basique] Gras et Na+', 'titre sans marqueurs');
    const area = fields[0].querySelector('textarea');
    area.value = '*nouveau* texte'; area.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(body0.querySelector('i').textContent, 'nouveau');
    assert.equal(body0.querySelectorAll('b').length, 0, 'aperçu reconstruit');
    const cloze = rowsOf(ov)[1].querySelector('.ankibridge-cloze');
    assert.ok(cloze, 'trou affiché dans l’aperçu');
    assert.equal(cloze.querySelector('sub').textContent, '2');
    assert.match(cloze.textContent, /indice : formule/);
  });
  await ta('aperçu : contenu hostile affiché comme du texte, jamais interprété', async () => {
    const ov = await openModal(respondOk(items3), FMT);
    assert.equal(ov.querySelectorAll('img').length, 0, 'aucune image créée');
    assert.equal(ov.querySelectorAll('script').length, 0, 'aucun script créé');
    const preview = rowsOf(ov)[2].querySelector('.ankibridge-previewbody');
    assert.match(preview.textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(preview.querySelector('b').textContent, '<script>alert(2)</script>');
  });

  await ta('remplacement : un simple changement de mise en forme n’est pas annoncé', async () => {
    const cardsJson = JSON.stringify({ cards: [{ type: 'basic', front: '**Q1**', back: '- R1' }, { type: 'basic', front: 'Q2', back: '**Nouvelle** réponse' }] });
    const dups = [{ ...DUP_OK, front: 'Q1', back: 'R1' }, { ...DUP_OK, id: 4243, front: 'Q2', back: 'Ancienne réponse' }];
    const ov = await openModal(respondOk(dups.map(d => anItem('exact', { duplicates: [d], replaceable: true }))), cardsJson);
    const rows = rowsOf(ov);
    assert.equal(rows[0].querySelector('.ankibridge-replacebox-input'), null, 'mise en forme seule : rien proposé');
    assert.equal(rows[1].querySelector('.ankibridge-replacebox-input').disabled, false, 'vrai changement de texte : remplacement proposé');
  });

  /* --- 1.6.0 : éditeur visuel (WYSIWYG) et trous en cases --- */
  const HOLES = JSON.stringify({ cards: [
    { type: 'cloze', text: 'Le **processus** DHCP suit {{c1::**Discover → Offer → Request → ACK**}}.\n- appelé {{c2::DORA::acronyme}}', extra: 'Explication.' },
    { type: 'basic', front: 'Q', back: 'Réponse :\n- un\n- **deux**' }
  ] });
  const items2 = [anItem('new'), anItem('new')];
  const editorsOf = row => row.querySelectorAll('.ankibridge-richedit');
  // Sélection simulée : repères insérés comme le fait Chrome (positions = indices d'enfants).
  const fakeSelection = (container, from, to) => ({
    rangeCount: 1, isCollapsed: false, removeAllRanges() {},
    getRangeAt: () => ({ startContainer: container, endContainer: container, startOffset: from, endOffset: to,
      cloneRange() { return { toStart: true, collapse(t) { this.toStart = t; },
        insertNode(n) { const i = this.toStart ? from : to; container.children.splice(i, 0, n); n.parent = container; } }; } })
  });
  await ta('éditeur : chaque champ s’édite mis en forme, sans syntaxe visible', async () => {
    const ov = await openModal(respondOk(items2), HOLES);
    const [cloze, basic] = rowsOf(ov);
    const ed = editorsOf(cloze)[0];
    assert.equal(ed.getAttribute('contenteditable'), 'true');
    assert.equal(ed.querySelector('b').textContent, 'processus', 'gras affiché en gras');
    assert.ok(!/\{\{|\}\}|\*\*/.test(ed.textContent), 'aucune syntaxe visible : ' + ed.textContent);
    assert.deepEqual(cloze.querySelectorAll('.ankibridge-holeinput').map(x => x.value), ['Discover → Offer → Request → ACK', 'DORA']);
    assert.ok(cloze.querySelectorAll('.ankibridge-holeinput')[0].classList.contains('bold'));
    assert.equal(cloze.querySelectorAll('.ankibridge-hole')[0].getAttribute('contenteditable'), 'false', 'trou protégé');
    assert.match(ed.textContent, /indice : acronyme/);
    assert.equal(editorsOf(basic)[1].querySelectorAll('ul li').length, 2, 'liste affichée en liste');
    assert.equal(basic.querySelector('.ankibridge-holeadd'), null, 'carte basique : pas de bouton « trou »');
    assert.ok(cloze.querySelector('.ankibridge-holeadd'));
    assert.deepEqual(basic.querySelectorAll('.ankibridge-toolbar')[0].querySelectorAll('.ankibridge-tool').map(b => b.getAttribute('data-cmd')),
      ['bold', 'italic', 'superscript', 'subscript', 'insertUnorderedList', 'insertOrderedList', 'removeFormat']);
    assert.ok(cloze.querySelectorAll('.ankibridge-field').every(f => f.hidden), 'texte brut masqué par défaut');
    assert.equal(cloze.querySelector('.ankibridge-title').textContent, '1. [Texte à trous] Le processus DHCP suit [Discover → Offer → Request → ACK]. appelé [DORA]');
  });
  await ta('éditeur : une modification à la main devient le texte de la carte', async () => {
    const ov = await openModal(respondOk(items2), HOLES);
    const basic = rowsOf(ov)[1];
    const ed = editorsOf(basic)[1];
    // Ce que Chrome produit après : texte, Entrée, Entrée, liste, « Fin » en italique.
    ed.replaceChildren(h('div', {}, 'Réponse ', h('b', {}, 'claire')), h('div', {}, h('br')), h('ul', {}, h('li', {}, 'un'), h('li', {}, h('sup', {}, '2'))), h('div', {}, h('i', {}, 'Fin')));
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    const area = basic.querySelectorAll('textarea')[1];
    assert.equal(area.value, 'Réponse **claire**\n\n- un\n- ^2^\n*Fin*');
    assert.match(ov.querySelector('.ankibridge-msg').textContent, /relancer la comparaison/, 'comparaison à relancer');
  });
  await ta('éditeur : barre d’outils (gras, listes…) et collage en texte simple', async () => {
    const hh = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, HOLES))] }, respondOk(items2));
    const calls = [];
    hh.ctx.document.execCommand = (cmd, _ui, value) => { calls.push([cmd, value]); return true; };
    await new Promise(r => setTimeout(r, 700));
    hh.root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    const row = hh.root.querySelectorAll('.ankibridge-row')[1];
    row.querySelectorAll('.ankibridge-tool')[0].onclick();
    assert.deepEqual(plain(calls), [['styleWithCSS', false], ['bold', null]]);
    calls.length = 0;
    editorsOf(row)[0].dispatchEvent({ type: 'paste', clipboardData: { getData: () => 'texte <b>collé</b>' } });
    assert.deepEqual(plain(calls), [['insertText', 'texte <b>collé</b>']], 'collé en texte simple, jamais en HTML');
  });
  await ta('trous : modifier la réponse met à jour la carte ; réponse invalide refusée', async () => {
    const ov = await openModal(respondOk(items2), HOLES);
    const row = rowsOf(ov)[0];
    const input = row.querySelectorAll('.ankibridge-holeinput')[0];
    const area = row.querySelectorAll('textarea')[0];
    input.value = 'DORA'; input.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(area.value, 'Le **processus** DHCP suit {{c1::**DORA**}}.\n- appelé {{c2::DORA::acronyme}}', 'gras et indice conservés');
    assert.match(ov.querySelector('.ankibridge-msg').textContent, /relancer la comparaison/);
    input.value = 'a}}b'; input.dispatchEvent(new Event('input', { bubbles: true }));
    assert.ok(input.classList.contains('invalid'));
    assert.match(row.querySelector('.ankibridge-holemsg').textContent, /ni « \}\} »/);
    assert.equal(area.value, 'Le **processus** DHCP suit {{c1::**DORA**}}.\n- appelé {{c2::DORA::acronyme}}', 'carte inchangée');
  });
  await ta('trous : la pastille change le numéro de carte (même carte ou nouvelle)', async () => {
    const cardsJson = JSON.stringify({ cards: [{ type: 'cloze', text: 'Une adresse {{c2::IPv4}} par DHCP : {{c1::DORA}}.', extra: '' }] });
    const ov = await openModal(respondOk([anItem('new')]), cardsJson);
    const row = rowsOf(ov)[0];
    const area = row.querySelectorAll('textarea')[0];
    const pills = () => row.querySelectorAll('.ankibridge-holenum');
    assert.deepEqual(pills().map(p => p.textContent), ['2', '1']);
    assert.equal(pills()[0].tagName, 'BUTTON', 'pastille cliquable');
    pills()[0].onclick();
    const items = () => row.querySelectorAll('.ankibridge-holemenuitem').map(b => b.textContent);
    assert.deepEqual(items(), ['Carte 1', 'Carte 2 (actuelle)'], 'déjà seul sur la dernière carte : pas de « nouvelle carte » inutile');
    assert.equal(pills()[0].getAttribute('aria-expanded'), 'true');
    assert.match(row.querySelector('.ankibridge-holemenuhint').textContent, /Même numéro = trous cachés ensemble/);
    row.querySelectorAll('.ankibridge-holemenuitem')[0].onclick();
    assert.equal(area.value, 'Une adresse {{c1::IPv4}} par DHCP : {{c1::DORA}}.', 'même carte : même numéro');
    assert.match(row.querySelector('.ankibridge-holemsg').textContent, /carte n° 1 : caché en même temps que 1 autre trou/);
    assert.equal(row.querySelector('.ankibridge-holemenu'), null, 'menu refermé');
    assert.deepEqual(pills().map(p => p.textContent), ['1', '1']);
    pills()[1].onclick();
    assert.deepEqual(items(), ['Carte 1 (actuelle)', 'Nouvelle carte (n° 2)']);
    row.querySelectorAll('.ankibridge-holemenuitem')[1].onclick();
    assert.equal(area.value, 'Une adresse {{c1::IPv4}} par DHCP : {{c2::DORA}}.', 'nouvelle carte');
    assert.match(row.querySelector('.ankibridge-holemsg').textContent, /seul sur la carte n° 2/);
    pills()[0].onclick(); pills()[0].onclick();
    assert.equal(row.querySelector('.ankibridge-holemenu'), null, 'second clic : menu refermé');
    assert.match(ov.querySelector('.ankibridge-msg').textContent, /relancer la comparaison/, 'carte modifiée : comparaison à relancer');
  });
  await ta('trous : × retire le trou (texte gardé) ; une sélection devient un trou', async () => {
    const hh = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, HOLES))] }, respondOk(items2));
    await new Promise(r => setTimeout(r, 700));
    hh.root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 900));
    const row = hh.root.querySelectorAll('.ankibridge-row')[0];
    const area = row.querySelectorAll('textarea')[0];
    row.querySelectorAll('.ankibridge-holeremove')[1].onclick();
    assert.equal(area.value, 'Le **processus** DHCP suit {{c1::**Discover → Offer → Request → ACK**}}.\n- appelé DORA');
    const ed = editorsOf(row)[0];
    const boldAt = ed.children.findIndex(c => c.tagName === 'B');
    hh.ctx.window.selection = fakeSelection(ed, boldAt, boldAt + 1);
    row.querySelector('.ankibridge-holeadd').onclick();
    assert.equal(area.value, 'Le {{c2::**processus**}} DHCP suit {{c1::**Discover → Offer → Request → ACK**}}.\n- appelé DORA');
    assert.match(row.querySelector('.ankibridge-holemsg').textContent, /carte n° 2/);
    assert.ok(!/|/.test(area.value + ed.textContent), 'repères retirés');
    const chipAt = ed.children.findIndex(c => c.classList && c.classList.contains('ankibridge-hole'));
    hh.ctx.window.selection = fakeSelection(ed, chipAt, chipAt + 1);
    row.querySelector('.ankibridge-holeadd').onclick();
    assert.match(row.querySelector('.ankibridge-holemsg').textContent, /trou existant/);
    hh.ctx.window.selection = null;
    row.querySelector('.ankibridge-holeadd').onclick();
    assert.match(row.querySelector('.ankibridge-holemsg').textContent, /Sélectionne d’abord/);
  });
  await ta('éditeur : « Texte brut » montre le texte exact, le retour redessine l’éditeur', async () => {
    const ov = await openModal(respondOk(items2), HOLES);
    const row = rowsOf(ov)[0];
    const toggle = row.querySelectorAll('.ankibridge-rawtoggle')[0];
    toggle.onclick();
    assert.equal(row.querySelectorAll('.ankibridge-rich')[0].hidden, true);
    assert.equal(row.querySelectorAll('.ankibridge-field')[0].hidden, false);
    assert.equal(toggle.textContent, 'Éditeur visuel');
    const area = row.querySelectorAll('textarea')[0];
    assert.ok(parseInt(area.style.height, 10) >= 120, 'zone de texte assez grande : ' + area.style.height);
    area.value = 'Nouveau {{c1::texte}} en **gras**'; area.dispatchEvent(new Event('input', { bubbles: true }));
    toggle.onclick();
    assert.deepEqual(row.querySelectorAll('.ankibridge-holeinput').map(x => x.value), ['texte']);
    assert.equal(editorsOf(row)[0].querySelector('b').textContent, 'gras');
  });
  await ta('trous : contenu hostile reste du texte', async () => {
    const cardsJson = JSON.stringify({ cards: [{ type: 'cloze', text: 'A {{c1::<img src=x onerror=alert(1)>}} <script>alert(2)</script>', extra: '<b>x</b>' }] });
    const ov = await openModal(respondOk([anItem('new')]), cardsJson);
    assert.equal(ov.querySelectorAll('img').length + ov.querySelectorAll('script').length, 0);
    assert.equal(ov.querySelectorAll('.ankibridge-richedit b').length, 0, 'balise écrite par ChatGPT jamais interprétée');
    assert.equal(ov.querySelector('.ankibridge-holeinput').value, '<img src=x onerror=alert(1)>');
  });

  await ta('mise en page : réglages fixes en haut, seule la liste des cartes défile', async () => {
    const ov = await openModal(respondOk(items2), HOLES);
    const top = ov.querySelector('.ankibridge-top'), main = ov.querySelector('.ankibridge-main');
    for (const sel of ['.ankibridge-deckinput', '.ankibridge-review', '.ankibridge-selectnew', '.ankibridge-selectnone', '.ankibridge-count', '.ankibridge-legend']) {
      assert.ok(top.querySelector(sel), sel + ' dans la partie fixe');
      assert.equal(main.querySelector(sel), null, sel + ' hors de la zone qui défile');
    }
    assert.equal(main.querySelectorAll('.ankibridge-row').length, 2, 'les cartes défilent');
    const order = ov.querySelector('.ankibridge-dialog').children.map(c => c.className);
    assert.deepEqual(order.slice(0, 4), ['ankibridge-head', 'ankibridge-top', 'ankibridge-main', 'ankibridge-foot']);
    const css = fs.readFileSync(EXT('content.css'), 'utf8');
    assert.match(css, /\.ankibridge-main\{flex:1 1 auto;min-height:0;[^}]*overflow:auto/);
    assert.match(css, /\.ankibridge-top\{flex:none;position:relative;z-index:3/);
  });

  /* --- 1.6.0 : retour visuel des boutons --- */
  await ta('retour visuel : « Relancer la comparaison » montre l’action en cours puis se rétablit', async () => {
    let release = null;
    const respond = msg => msg.type === 'ANALYZE' && release === false
      ? new Promise(r => { release = () => r(respondOk(items2)(msg)); })
      : respondOk(items2)(msg);
    const ov = await openModal(respond, HOLES);
    const btn = ov.querySelector('.ankibridge-review');
    assert.equal(btn.textContent, 'Relancer la comparaison');
    release = false;
    btn.onclick();
    assert.ok(btn.classList.contains('is-busy'), 'état « en cours »');
    assert.equal(btn.textContent, 'Comparaison…');
    assert.equal(btn.getAttribute('aria-busy'), 'true');
    assert.equal(btn.disabled, true);
    await new Promise(r => setTimeout(r, 50));
    release();
    await new Promise(r => setTimeout(r, 450));
    assert.ok(!btn.classList.contains('is-busy'));
    assert.equal(btn.textContent, 'Relancer la comparaison', 'libellé rétabli');
    assert.equal(btn.disabled, false);
  });
  await ta('retour visuel : visible au moins un instant même si Anki répond tout de suite', async () => {
    const ov = await openModal(respondOk(items2), HOLES);
    const btn = ov.querySelector('.ankibridge-review');
    btn.onclick();
    await new Promise(r => setTimeout(r, 60));
    assert.ok(btn.classList.contains('is-busy'), 'encore visible après 60 ms');
    assert.equal(ov.querySelector('.ankibridge-msg').textContent, '2 nouvelles', 'le résultat, lui, est déjà affiché');
    await new Promise(r => setTimeout(r, 400));
    assert.ok(!btn.classList.contains('is-busy'));
  });
  await ta('retour visuel : import « en cours », puis « Import terminé »', async () => {
    let release;
    const respond = msg => msg.type === 'IMPORT' ? new Promise(r => { release = () => r(respondOk(items2)(msg)); }) : respondOk(items2)(msg);
    const ov = await openModal(respond, HOLES);
    const save = ov.querySelector('.ankibridge-action');
    save.onclick();
    await new Promise(r => setTimeout(r, 30));
    assert.ok(save.classList.contains('is-busy'));
    assert.equal(save.textContent, 'Import en cours…');
    release();
    await new Promise(r => setTimeout(r, 60));
    assert.ok(!save.classList.contains('is-busy'));
    assert.equal(save.textContent, 'Import terminé');
    assert.equal(save.disabled, true, 'jamais de second import par erreur');
  });
  await ta('CSS : survol, enfoncement, désactivé et roue « en cours »', () => {
    const css = fs.readFileSync(EXT('content.css'), 'utf8');
    assert.match(css, /\.ankibridge-dialog button:not\(:disabled\):active\{transform:/);
    assert.match(css, /\.ankibridge-review:hover:not\(:disabled\)\{background:/);
    assert.match(css, /\.ankibridge-review:disabled[^{]*\{opacity:\.55/);
    assert.match(css, /button\.is-busy::before\{[^}]*animation:ankibridge-spin/);
    assert.match(css, /@keyframes ankibridge-spin/);
    assert.match(css, /prefers-reduced-motion:reduce/);
  });

  /* --- 1.6.0 : champ paquet et création --- */
  const deckServer = (decks, log, n = 13) => msg => {
    log.push(msg);
    if (msg.type === 'DECKS') return { ok: true, value: decks.slice() };
    if (msg.type === 'CREATE_DECK') { decks.push(msg.deck); return { ok: true, value: { deck: msg.deck, created: true } }; }
    if (msg.type === 'ANALYZE') return { ok: true, value: { items: Array.from({ length: n }, () => anItem('new')), totalExisting: 0, scanned: 0, partial: false, scope: msg.deck } };
    if (msg.type === 'IMPORT') return { ok: true, value: { added: msg.cards.length, skipped: 0, errors: [], total: msg.cards.length } };
    return { ok: false, error: 'unexpected ' + msg.type };
  };
  const createOption = root => root.querySelector('.ankibridge-deckcreate');
  const panelOf = ov => ov.querySelector('.ankibridge-newdeck');
  const openCreate = (ov, name) => { pickerOptions(ov, name); createOption(ov).click(); };
  const typeName = (ov, name) => { const x = ov.querySelector('.ankibridge-newdeckname'); x.value = name; x.dispatchEvent(new Event('input', { bubbles: true })); };
  await ta('champ paquet : Échap ou un clic ailleurs réaffichent le paquet choisi', async () => {
    const ov = await openModal(deckServer(['Cours', 'Par défaut'], []));
    const input = ov.querySelector('.ankibridge-deckinput');
    input.dispatchEvent(new Event('focus'));
    assert.equal(ov.querySelector('.ankibridge-decklist').hidden, false, 'liste ouverte au clic');
    assert.equal(ov.querySelectorAll('.ankibridge-deckoption').length, 2, 'tous les paquets proposés');
    input.value = 'zzz'; input.dispatchEvent(new Event('input', { bubbles: true }));
    assert.match(ov.querySelector('.ankibridge-deckempty').textContent, /Aucun paquet ne contient « zzz »/);
    input.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(input.value, 'Cours', 'Échap rétablit le paquet choisi');
    input.value = 'Nouv'; input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('blur'));
    await new Promise(r => setTimeout(r, 250));
    assert.equal(input.value, 'Cours', 'un clic ailleurs rétablit le paquet choisi');
    assert.equal(ov.querySelector('.ankibridge-decklist').hidden, true);
  });
  await ta('création : formulaire sous le champ, explication avant toute écriture', async () => {
    const log = [];
    const ov = await openModal(deckServer(['Cours', 'Par défaut'], log));
    assert.equal(panelOf(ov).hidden, true);
    openCreate(ov, 'Cardio::Cours 3');
    assert.equal(panelOf(ov).hidden, false, 'formulaire ouvert');
    assert.match(ov.querySelector('.ankibridge-newdeckinfo').textContent, /« Cardio › Cours 3 » sera créé dans Anki ; le paquet parent « Cardio » n’existe pas encore et sera créé aussi/);
    assert.equal(ov.querySelector('.ankibridge-newdeckok').disabled, false);
    typeName(ov, '');
    assert.equal(ov.querySelector('.ankibridge-newdeckok').disabled, true, 'rien à créer sans nom');
    typeName(ov, 'Cours "3"');
    assert.match(ov.querySelector('.ankibridge-newdeckinfo').textContent, /guillemets/);
    assert.equal(ov.querySelector('.ankibridge-newdeckok').disabled, true);
    assert.ok(!log.some(m => m.type === 'CREATE_DECK'), 'rien n’est créé sans clic sur « Créer le paquet »');
  });
  await ta('création : dernière option de la liste, ouvre le formulaire prérempli', async () => {
    const ov = await openModal(deckServer(['Cours', 'Par défaut'], []));
    pickerOptions(ov, 'cours');
    assert.equal(createOption(ov), null, 'paquet existant (casse ignorée) : rien à créer');
    pickerOptions(ov, 'Cardio::Cours 3');
    const list = ov.querySelector('.ankibridge-decklist');
    assert.equal(list.children[list.children.length - 1], createOption(ov), 'en dernière option');
    assert.equal(createOption(ov).textContent, '+ Créer le paquet « Cardio › Cours 3 »');
    assert.equal(createOption(ov).getAttribute('role'), 'option');
    createOption(ov).click();
    assert.equal(panelOf(ov).hidden, false);
    assert.equal(ov.querySelector('.ankibridge-newdeckname').value, 'Cardio::Cours 3');
    assert.equal(ov.querySelector('.ankibridge-deckinput').value, 'Cours', 'le champ réaffiche le paquet choisi');
  });
  await ta('recherche : le nom complet « Parent::Enfant » (ou « › ») trouve le paquet existant', async () => {
    const ov = await openModal(deckServer(['Cours', 'Test Cartes vers Anki::1.6.0'], []));
    for (const q of ['Test Cartes vers Anki::1.6.0', 'test cartes vers anki › 1.6.0']) {
      const opts = pickerOptions(ov, q);
      assert.equal(opts.length, 1, q);
      assert.equal(opts[0].getAttribute('data-value'), 'Test Cartes vers Anki::1.6.0');
      assert.equal(createOption(ov), null, 'paquet existant : pas de création');
    }
  });
  await ta('création : nom invalide expliqué dans la liste, aucune option de création', async () => {
    const ov = await openModal(deckServer(['Cours'], []));
    for (const [query, why] of [['Cours "3"', /guillemets/], ['A::', /niveau/], ['x'.repeat(151), /trop long/]]) {
      pickerOptions(ov, query);
      assert.equal(createOption(ov), null, query);
      assert.match(ov.querySelector('.ankibridge-deckinvalid').textContent, why);
    }
  });
  await ta('création : Annuler n’écrit rien', async () => {
    const log = [];
    const ov = await openModal(deckServer(['Cours'], log));
    openCreate(ov, 'Nouveau');
    ov.querySelector('.ankibridge-newdeckcancel').onclick();
    assert.equal(panelOf(ov).hidden, true);
    assert.ok(!log.some(m => m.type === 'CREATE_DECK'));
    assert.equal(ov.querySelector('.ankibridge-deckinput').value, 'Cours');
  });
  await ta('création confirmée : liste rechargée, paquet sélectionné, comparaison relancée', async () => {
    const log = [];
    const ov = await openModal(deckServer(['Cours', 'Cardio'], log));
    openCreate(ov, 'Cardio :: Cours 3');
    assert.match(ov.querySelector('.ankibridge-newdeckinfo').textContent, /rangé dans le paquet existant « Cardio »/);
    ov.querySelector('.ankibridge-newdeckok').onclick();
    await new Promise(r => setTimeout(r, 900));
    const created = log.filter(m => m.type === 'CREATE_DECK');
    assert.equal(created.length, 1);
    assert.equal(created[0].deck, 'Cardio::Cours 3', 'nom nettoyé transmis');
    assert.equal(log.filter(m => m.type === 'DECKS').length, 2, 'liste rechargée');
    assert.equal(ov.querySelector('.ankibridge-deckinput').value, 'Cardio › Cours 3');
    const analyses = log.filter(m => m.type === 'ANALYZE');
    assert.equal(analyses[analyses.length - 1].deck, 'Cardio::Cours 3');
    assert.equal(panelOf(ov).hidden, true, 'formulaire refermé');
    assert.equal(ov.querySelector('.ankibridge-action').disabled, false);
  });
  await ta('création : paquet déjà existant → simplement choisi, rien de créé', async () => {
    const log = [];
    const ov = await openModal(deckServer(['Cours', 'Autre'], log));
    openCreate(ov, 'Nouveau');
    typeName(ov, 'autre');
    assert.equal(ov.querySelector('.ankibridge-newdeckok').textContent, 'Choisir ce paquet');
    ov.querySelector('.ankibridge-newdeckok').onclick();
    await new Promise(r => setTimeout(r, 600));
    assert.ok(!log.some(m => m.type === 'CREATE_DECK'));
    assert.equal(ov.querySelector('.ankibridge-deckinput').value, 'Autre');
  });
  await ta('création refusée par Anki : erreur dans le formulaire, paquet courant conservé', async () => {
    const log = [];
    const respond = msg => msg.type === 'CREATE_DECK' ? { ok: false, error: 'Anki indisponible' } : deckServer(['Cours'], log)(msg);
    const ov = await openModal(respond);
    openCreate(ov, 'Nouveau');
    ov.querySelector('.ankibridge-newdeckok').onclick();
    await new Promise(r => setTimeout(r, 200));
    assert.match(ov.querySelector('.ankibridge-newdeckinfo').textContent, /Création impossible : Anki indisponible/);
    assert.equal(panelOf(ov).hidden, false, 'formulaire laissé ouvert pour corriger');
    assert.equal(ov.querySelector('.ankibridge-deckinput').value, 'Cours');
  });
  await ta('création au clavier : Entrée dans la liste ouvre le formulaire, Entrée crée', async () => {
    const log = [];
    const ov = await openModal(deckServer(['Cours'], log));
    const input = ov.querySelector('.ankibridge-deckinput');
    input.value = 'Nouveau'; input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent({ type: 'keydown', key: 'Enter' });
    assert.equal(panelOf(ov).hidden, false);
    assert.ok(!log.some(m => m.type === 'CREATE_DECK'), 'rien n’est créé à la première Entrée');
    ov.querySelector('.ankibridge-newdeckname').dispatchEvent({ type: 'keydown', key: 'Enter' });
    await new Promise(r => setTimeout(r, 600));
    assert.equal(log.filter(m => m.type === 'CREATE_DECK').length, 1);
  });

  /* --- 1.6.0 : mode sombre --- */
  await ta('thème : automatique suit le système (en direct), clair / sombre imposés et mémorisés', async () => {
    const hh = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk([]));
    const mq = { matches: true, listeners: [], addEventListener(_t, f) { this.listeners.push(f); }, removeEventListener() {} };
    hh.ctx.window.matchMedia = () => mq;
    await new Promise(r => setTimeout(r, 700));
    hh.root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 400));
    const ov = hh.root.querySelector('.ankibridge-overlay');
    const btn = ov.querySelector('.ankibridge-themebtn');
    assert.equal(btn.textContent, 'Thème : automatique');
    assert.ok(ov.classList.contains('ankibridge-dark'), 'système sombre → fenêtre sombre');
    mq.matches = false; mq.listeners.forEach(f => f());
    assert.ok(!ov.classList.contains('ankibridge-dark'), 'le changement du système est suivi');
    btn.onclick();
    assert.equal(btn.textContent, 'Thème : clair'); assert.equal(hh.storage.theme, 'light');
    btn.onclick();
    assert.equal(btn.textContent, 'Thème : sombre'); assert.ok(ov.classList.contains('ankibridge-dark')); assert.equal(hh.storage.theme, 'dark');
    btn.onclick();
    assert.equal(hh.storage.theme, 'auto');
  });
  await ta('thème : réglage « clair » respecté même si le système est sombre', async () => {
    const hh = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))], storage: { theme: 'light' } }, respondOk([]));
    hh.ctx.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    await new Promise(r => setTimeout(r, 700));
    hh.root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 400));
    const ov = hh.root.querySelector('.ankibridge-overlay');
    assert.ok(!ov.classList.contains('ankibridge-dark'));
    assert.equal(ov.querySelector('.ankibridge-themebtn').textContent, 'Thème : clair');
  });
  await ta('CSS sombre : fond et textes lisibles (contraste ≥ 4,5)', () => {
    const css = fs.readFileSync(EXT('content.css'), 'utf8');
    const dark = css.split('Mode sombre')[1] || '';
    const lum = hex => { const c = [0, 1, 2].map(i => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const bg = (dark.match(/\.ankibridge-dark \.ankibridge-dialog\{background:(#[0-9a-f]{6});color:(#[0-9a-f]{6})/) || []);
    assert.ok(bg[1], 'fond sombre de la fenêtre défini');
    for (const sel of ['ankibridge-msg', 'ankibridge-richedit', 'ankibridge-holemsg.bad', 'ankibridge-newdeckinfo.bad']) {
      const m = dark.match(new RegExp('\\.' + sel.replace('.', '\\.') + '[,{][^}]*?color:(#[0-9a-f]{6})'));
      assert.ok(m, 'couleur sombre manquante pour ' + sel);
      assert.ok(ratio(m[1], bg[1]) >= 4.5, `${sel} : contraste ${ratio(m[1], bg[1]).toFixed(2)}`);
    }
  });

}

/* ------------------------------------------------------------------ *
 * 6. Localisation des doublons et REMPLACEMENT SÛR (AnkiConnect simulé) *
 * ------------------------------------------------------------------ */
function startMockAnki2() {
  const state = {
    decks: ['Par défaut', 'Médecine (TEST)', 'Médecine (TEST)::Cardiologie', 'Autre spécialité'],
    models: ['Basique', 'Basique (carte inversée optionnelle)', 'Texte à trous'],
    notes: new Map(), nextNote: 900, nextCard: 7000, actions: [], writes: []
  };
  const fieldNames = m => /trou/i.test(m) ? ['Texte', 'Verso Extra'] : ['Recto', 'Verso'];
  const add = (model, values, deck, opts = {}) => {
    const id = ++state.nextNote, card = ++state.nextCard;
    const names = fieldNames(model); const fields = {};
    names.forEach((n, i) => { fields[n] = { value: String(values[i] ?? ''), order: i }; });
    state.notes.set(id, { noteId: id, modelName: model, fields, tags: opts.tags || ['chatgpt'],
      mod: opts.mod ?? 1700000000, cards: [card], deck });
    return id;
  };
  const fieldValue = v => String(typeof v === 'object' && v !== null ? v.value : (v ?? ''));
  const firstField = n => fieldValue(n.fields?.[fieldNames(n.modelName)[0]]);
  const findNotes = q => {
    let rest = String(q).trim(); let deck = null;
    const dm = rest.match(/^deck:"([^"]+)"\s*/);
    if (dm) { deck = dm[1]; rest = rest.slice(dm[0].length); }
    const nm = rest.match(/^nid:([\d,]+)$/);
    if (nm) { const ids = nm[1].split(',').map(Number); return [...state.notes.keys()].filter(id => ids.includes(id)); }
    let ids = [...state.notes.keys()];
    if (deck) ids = ids.filter(id => { const d = state.notes.get(id).deck; return d === deck || d.startsWith(deck + '::'); });
    const tm = rest.match(/^"([\s\S]+)"$/);
    if (tm) {
      // Comme le vrai Anki (vérifié) : un « : » non échappé lance une recherche par
      // champ (« champ:texte ») et ne trouve rien ici ; « \: », « \* », « \_ », « \" »
      // désignent le caractère lui-même.
      if (/(^|[^\\]):/.test(tm[1])) return [];
      const needle = tm[1].replace(/\\(.)/g, '$1').toLowerCase();
      ids = ids.filter(id => Object.values(state.notes.get(id).fields).some(f => fieldValue(f).toLowerCase().includes(needle)));
    }
    return ids;
  };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      let out = { result: null, error: null };
      try {
        const p = JSON.parse(body || '{}'); const prm = p.params || {};
        state.actions.push(p.action);
        switch (p.action) {
          case 'version': out.result = 6; break;
          case 'requestPermission': out.result = { permission: 'granted', requireApiKey: false }; break;
          case 'deckNames': out.result = state.decks.slice(); break;
          case 'modelNames': out.result = state.models.slice(); break;
          case 'modelFieldNames': out.result = fieldNames(prm.modelName); break;
          case 'findNotes': out.result = findNotes(prm.query); break;
          case 'notesInfo': out.result = (prm.notes || []).map(id => state.notes.get(id)).filter(Boolean); break;
          case 'cardsInfo':
            out.result = (prm.cards || []).map(cid => {
              const n = [...state.notes.values()].find(x => x.cards.includes(cid));
              return n ? { cardId: cid, note: n.noteId, deckName: n.deck, modelName: n.modelName } : null;
            }).filter(Boolean);
            break;
          case 'canAddNotes':
            out.result = (prm.notes || []).map(n => ![...state.notes.values()]
              .some(x => firstField(x).toLowerCase() === firstField(n).toLowerCase()));
            break;
          case 'addNote': out.result = ++state.nextNote; break;
          case 'multi': out.result = (prm.actions || []).map(a => {
            state.actions.push('multi:' + a.action);
            return a.action === 'addNote' ? { result: ++state.nextNote, error: null } : { result: null, error: 'unsupported action ' + a.action };
          }); break;
          case 'updateNoteFields': {
            const id = prm.note?.id; const n = state.notes.get(id);
            if (!n) { out.error = 'note introuvable'; break; }
            state.writes.push({ id, fields: { ...(prm.note.fields || {}) }, tags: prm.note.tags });
            for (const [k, v] of Object.entries(prm.note.fields || {})) if (n.fields[k]) n.fields[k].value = v;
            n.mod += 1;
            out.result = null; break;
          }
          default: out.error = 'unsupported action ' + p.action;
        }
      } catch (e) { out.error = String(e); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port, add })));
}

async function replaceTests() {
  const { server, state, port, add } = await startMockAnki2();
  const { ctx, listeners, storage } = bgContext({ fetchImpl: onlyMock(port) });
  storage.ankiPort = port;
  // Fixtures : une note par cas de test, jamais partagée entre tests.
  const nBasic = add('Basique', ['Question A', 'Réponse A'], 'Médecine (TEST)::Cardiologie');
  const nInverse = add('Basique (carte inversée optionnelle)', ['Question inversée', 'Réponse X'], 'Par défaut');
  const nCloze = add('Texte à trous', ['Le {{c1::cœur}} pompe.', ''], 'Par défaut');
  const nDup1 = add('Basique', ['Question B', 'Réponse B'], 'Par défaut');
  const nDup2 = add('Basique', ['Question B', 'Réponse B bis'], 'Autre spécialité');
  const nNoop = add('Basique', ['Question noop', 'Réponse noop'], 'Par défaut');
  const nDeck = add('Basique', ['Question deck', 'Réponse deck'], 'Médecine (TEST)');
  const nTags = add('Basique', ['Question tags', 'Réponse tags'], 'Par défaut');
  const fieldNames = m => /trou/i.test(m) ? ["Texte", "Verso Extra"] : ["Recto", "Verso"];
  // NB : ne jamais appeler cette fonction « valueOf » — le nom serait résolu sur
  // Object.prototype.valueOf du contexte global et lèverait une TypeError silencieuse.
  const fieldValue = v => String(typeof v === 'object' && v !== null ? v.value : (v ?? ''));
  const snap = id => ({ mod: state.notes.get(id).mod, second: fieldValue(state.notes.get(id).fields[fieldNames(state.notes.get(id).modelName)[1]]) });
  const base = (id, model, deck, type, first, second) => {
    const s = snap(id);
    return { noteId: id, model, deck, type, fingerprint: first, originalSecond: s.second, mod: s.mod, first, second };
  };

  await ta('ANALYZE : doublon localisé (autre paquet) avec identifiant, paquet et modèle', async () => {
    const r = await send(listeners, { type: 'ANALYZE', deck: 'Médecine (TEST)', cards: [{ type: 'basic', front: 'Question A', back: 'Réponse A' }] });
    assert.equal(r.ok, true, JSON.stringify(r));
    const item = r.value.items[0];
    assert.equal(item.kind, 'exact');
    assert.equal(item.duplicates.length, 1);
    assert.equal(item.duplicates[0].id, nBasic);
    assert.equal(item.duplicates[0].deck, 'Médecine (TEST)::Cardiologie', 'paquet réel via cardsInfo');
    assert.equal(item.duplicates[0].model, 'Basique');
    assert.equal(item.duplicates[0].certain, true);
    assert.equal(item.duplicates[0].compatible, true);
    assert.equal(item.replaceable, true);
    assert.equal(item.duplicates[0].mod, 1700000000, 'instantané mod transmis');
  });
  await ta('ANALYZE : plusieurs notes identiques -> ambigu, remplacement bloqué, toutes listées', async () => {
    const r = await send(listeners, { type: 'ANALYZE', deck: 'Par défaut', cards: [{ type: 'basic', front: 'Question B', back: 'Réponse B' }] });
    const item = r.value.items[0];
    assert.equal(item.kind, 'exact');
    assert.equal(item.duplicates.length, 2);
    assert.equal(item.replaceable, false);
    assert.equal(item.blocked, 'ambigu');
    assert.deepEqual(item.duplicates.map(d => d.id).sort(), [nDup1, nDup2].sort());
  });
  await ta('ANALYZE : modèle différent (carte inversée) -> incompatible, remplacement refusé', async () => {
    const r = await send(listeners, { type: 'ANALYZE', deck: 'Par défaut', cards: [{ type: 'basic', front: 'Question inversée', back: 'Réponse X' }] });
    const item = r.value.items[0];
    assert.equal(item.kind, 'exact');
    assert.equal(item.duplicates.length, 1);
    assert.equal(item.duplicates[0].compatible, false);
    assert.equal(item.replaceable, false);
    assert.equal(item.blocked, 'incompatible');
    void nInverse;
  });
  await ta('ANALYZE : ressemblance lexicale -> jamais remplaçable', async () => {
    const r = await send(listeners, { type: 'ANALYZE', deck: 'Par défaut', cards: [{ type: 'basic', front: 'Question A du cœur humain', back: 'Réponse' }] });
    const item = r.value.items[0];
    assert.equal(item.replaceable, false, 'une ressemblance ne permet jamais un remplacement');
    assert.ok(['similar', 'new'].includes(item.kind));
    if (item.kind === 'similar') assert.ok(item.duplicates.every(d => d.certain === false));
  });
  await ta('ANALYZE : 50 doublons tous localisés (limite couvrant un lot complet)', async () => {
    for (let i = 0; i < 50; i++) add('Basique', ['Lot Q' + i, 'Lot R' + i], 'Par défaut');
    const cards = Array.from({ length: 50 }, (_, i) => ({ type: 'basic', front: 'Lot Q' + i, back: 'Lot R' + i }));
    const r = await send(listeners, { type: 'ANALYZE', deck: 'Par défaut', cards });
    assert.equal(r.value.items.length, 50);
    assert.equal(r.value.items.filter(i => i.kind === 'exact' && i.duplicates.length === 1).length, 50, 'les 50 sont localisés');
    assert.equal(r.value.items.filter(i => i.blocked === 'limite').length, 0);
  });

  await ta('REPLACE : succès -> updateNoteFields, identifiant/paquet/tags conservés', async () => {
    const before = state.writes.length;
    const r = await send(listeners, { type: 'REPLACE', replacements: [base(nBasic, 'Basique', 'Médecine (TEST)::Cardiologie', 'basic', 'Question A', 'Réponse A corrigée')] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.value.updated, 1);
    assert.equal(r.value.failed.length, 0);
    assert.equal(state.writes.length, before + 1);
    assert.deepEqual(state.writes[before].fields, { Verso: 'Réponse A corrigée' }, 'seul le champ modifié est écrit');
    assert.equal(state.writes[before].tags, undefined, 'aucun tag transmis');
    const note = state.notes.get(nBasic);
    assert.equal(note.noteId, nBasic, 'identifiant de note inchangé');
    assert.equal(note.deck, 'Médecine (TEST)::Cardiologie', 'paquet inchangé');
    assert.deepEqual(note.tags, ['chatgpt'], 'tags préservés');
    assert.equal(note.cards.length, 1, 'carte (donc planning) conservée');
    assert.ok(!state.actions.includes('deleteNotes') && !state.actions.includes('deleteDecks') && !state.actions.includes('changeDeck'));
  });
  await ta('REPLACE : annulation côté interface -> aucune écriture (test interface ci-dessus)', async () => {
    assert.ok(state.actions.includes('updateNoteFields'));
    assert.ok(!state.actions.includes('deleteNotes'));
  });
  await ta('REPLACE : note modifiée dans Anki depuis l’analyse -> refus', async () => {
    const before = state.writes.length;
    const item = base(nNoop, 'Basique', 'Par défaut', 'basic', 'Question noop', 'Réponse noop changée');
    item.mod = item.mod + 99; // instantané périmé
    const r = await send(listeners, { type: 'REPLACE', replacements: [item] });
    assert.equal(r.value.updated, 0);
    assert.match(r.value.failed[0].reason, /modifiée dans Anki/);
    assert.equal(state.writes.length, before, 'aucune écriture');
  });
  await ta('REPLACE : second champ modifié depuis l’analyse -> refus', async () => {
    const before = state.writes.length;
    const item = base(nNoop, 'Basique', 'Par défaut', 'basic', 'Question noop', 'Réponse noop changée');
    item.originalSecond = 'Valeur qui n’existe plus';
    const r = await send(listeners, { type: 'REPLACE', replacements: [item] });
    assert.equal(r.value.updated, 0);
    assert.match(r.value.failed[0].reason, /second champ a changé/);
    assert.equal(state.writes.length, before);
  });
  await ta('REPLACE : modèle incompatible -> refus', async () => {
    const before = state.writes.length;
    const item = base(nInverse, 'Basique (carte inversée optionnelle)', 'Par défaut', 'basic', 'Question inversée', 'Réponse X modifiée');
    item.model = 'Basique'; // l'interface prétend « Basique », la note est « carte inversée »
    const r = await send(listeners, { type: 'REPLACE', replacements: [item] });
    assert.equal(r.value.updated, 0);
    assert.match(r.value.failed[0].reason, /Modèle différent/);
    assert.equal(state.writes.length, before);
  });
  await ta('REPLACE : plusieurs candidats -> refus (jamais d’arbitrage automatique)', async () => {
    const before = state.writes.length;
    const item = base(nDup1, 'Basique', 'Par défaut', 'basic', 'Question B', 'Réponse B corrigée');
    const r = await send(listeners, { type: 'REPLACE', replacements: [item] });
    assert.equal(r.value.updated, 0, 'deux notes identiques : aucune écriture');
    assert.match(r.value.failed[0].reason, /Plusieurs notes identiques/);
    assert.equal(state.writes.length, before);
    assert.equal(state.notes.get(nDup1).fields.Verso.value, 'Réponse B', 'note 1 intacte');
    assert.equal(state.notes.get(nDup2).fields.Verso.value, 'Réponse B bis', 'note 2 intacte');
  });
  await ta('REPLACE : texte à trous dont les indices changent -> refus (planning préservé)', async () => {
    const before = state.writes.length;
    const item = base(nCloze, 'Texte à trous', 'Par défaut', 'cloze', 'Le {{c1::cœur}} pompe.', '');
    item.first = 'Le {{c1::cœur}} et {{c2::les poumons}} pompent.';
    const r = await send(listeners, { type: 'REPLACE', replacements: [item] });
    assert.equal(r.value.updated, 0);
    assert.match(r.value.failed[0].reason, /textes à trous/);
    assert.equal(state.writes.length, before);
  });
  await ta('REPLACE : texte à trous à indices inchangés -> autorisé', async () => {
    const before = state.writes.length;
    const item = base(nCloze, 'Texte à trous', 'Par défaut', 'cloze', 'Le {{c1::cœur}} pompe.', '');
    item.first = 'Le {{c1::cœur}} propulse le sang.';
    const r = await send(listeners, { type: 'REPLACE', replacements: [item] });
    assert.equal(r.value.updated, 1, JSON.stringify(r.value));
    assert.deepEqual(state.writes[before].fields, { Texte: 'Le {{c1::cœur}} propulse le sang.' });
  });
  await ta('REPLACE : note déplacée dans un autre paquet -> refus', async () => {
    const before = state.writes.length;
    const item = base(nDeck, 'Basique', 'Par défaut', 'basic', 'Question deck', 'Réponse deck corrigée');
    const r = await send(listeners, { type: 'REPLACE', replacements: [item] });
    assert.equal(r.value.updated, 0);
    assert.match(r.value.failed[0].reason, /déplacée/);
    assert.equal(state.writes.length, before);
  });
  await ta('REPLACE : aucune modification de tags ni de paquet acceptée', async () => {
    const before = state.writes.length;
    const item = base(nTags, 'Basique', 'Par défaut', 'basic', 'Question tags', 'Réponse tags corrigée');
    item.tags = ['pirate'];
    const r = await send(listeners, { type: 'REPLACE', replacements: [item] });
    assert.equal(r.value.updated, 0);
    assert.match(r.value.failed[0].reason, /non autorisées/);
    assert.equal(state.writes.length, before);
    assert.deepEqual(state.notes.get(nTags).tags, ['chatgpt']);
  });
  await ta('REPLACE : sans changement de champ -> ignoré, aucune écriture', async () => {
    const before = state.writes.length;
    const item = base(nNoop, 'Basique', 'Par défaut', 'basic', 'Question noop', 'Réponse noop');
    const r = await send(listeners, { type: 'REPLACE', replacements: [item] });
    assert.equal(r.value.updated, 0);
    assert.equal(r.value.skipped, 1);
    assert.match(r.value.skippedDetails[0].reason, /Aucun champ ne diffère/);
    assert.equal(state.writes.length, before);
  });
  await ta('REPLACE : données invalides -> refus sans écriture', async () => {
    const before = state.writes.length;
    const r = await send(listeners, { type: 'REPLACE', replacements: [{ noteId: 'x' }, { noteId: 1, model: '', fingerprint: '' }] });
    assert.equal(r.value.updated, 0);
    assert.equal(r.value.failed.length, 2);
    assert.equal(state.writes.length, before);
    const empty = await send(listeners, { type: 'REPLACE', replacements: [] });
    assert.equal(empty.ok, false);
  });
  await ta('SÉCURITÉ : REPLACE depuis une origine non autorisée rejeté', async () => {
    const before = state.writes.length;
    const r = await send(listeners, { type: 'REPLACE', replacements: [base(nBasic, 'Basique', 'Médecine (TEST)::Cardiologie', 'basic', 'Question A', 'Pirate')] },
      { id: 'test-extension-id', url: 'https://evil.example.com/' });
    assert.equal(r.ok, false);
    assert.match(r.error, /Origine non autorisée/);
    assert.equal(state.writes.length, before);
  });
  await ta('SÉCURITÉ : aucune action destructive n’a jamais été appelée', async () => {
    for (const a of state.actions) {
      assert.ok(!['deleteNotes', 'deleteDecks', 'changeDeck', 'removeNotes', 'deleteCards', 'deleteModels', 'removeEmptyNotes'].includes(a), 'action destructive : ' + a);
    }
  });
  /* --- 1.6.0 : localisation vérifiée sur un vrai Anki --- */
  await ta('recherche Anki : « : », « * », « _ » et « " » échappés, recherche de paquet inchangée', async () => {
    assert.equal(ctx.quotedText('Question : a*b_c "x" \\'), '"Question \\: a\\*b\\_c \\"x\\" \\\\"');
    assert.equal(ctx.quotedQuery('Cardio::Cours 3'), '"Cardio::Cours 3"');
  });
  await ta('doublon localisé malgré « : » et un trou {{c1::…}} mis en forme', async () => {
    const nColon = add('Basique', ['<b>Ion</b> majoritaire : Na<sup>+</sup> ?', 'r'], 'Par défaut');
    const nCloze = add('Texte à trous', ['L’eau : {{c1::H<sub>2</sub>O::formule}}', ''], 'Par défaut');
    const r = await send(listeners, { type: 'ANALYZE', deck: 'Par défaut', cards: [
      { type: 'basic', front: '**Ion** majoritaire : Na^+^ ?', back: 'r' },
      { type: 'cloze', text: 'L’eau : {{c1::H~2~O::formule}}', extra: '' }] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(plain(r.value.items.map(i => i.kind)), ['exact', 'exact']);
    assert.deepEqual(plain(r.value.items.map(i => i.duplicates.map(d => d.id))), [[nColon], [nCloze]], 'les deux doublons sont localisés');
    assert.equal(r.value.items[0].replaceable, true);
  });
  /* --- régression review PR #2 : sûreté du remplacement --- */
  await ta('P1 : plus de 60 candidats -> unicité non prouvable, remplacement refusé', async () => {
    // 61 notes partagent le même premier champ : une tranche de 60 ne doit JAMAIS
    // permettre de conclure à une note unique.
    const ids = [];
    for (let i = 0; i < 61; i++) ids.push(add('Basique', ['Question foule', 'Réponse ' + i], 'Par défaut'));
    const writesBefore = state.writes.length;
    const r = await send(listeners, { type: 'REPLACE', replacements: [{
      noteId: ids[0], model: 'Basique', deck: 'Par défaut', type: 'basic',
      fingerprint: 'Question foule', originalSecond: 'Réponse 0', mod: state.notes.get(ids[0]).mod,
      first: 'Question foule', second: 'Réponse modifiée' }] });
    assert.equal(r.value.updated, 0);
    assert.equal(r.value.failed.length, 1);
    assert.match(r.value.failed[0].reason, /Trop de notes|unicité/i);
    assert.equal(state.writes.length, writesBefore, 'aucune écriture ne doit avoir lieu');
  });
  await ta('P2 : premier champ de plus de 240 caractères -> remplacement légitime accepté', async () => {
    const longFirst = 'Question ' + 'x'.repeat(300);
    const id = add('Basique', [longFirst, 'Réponse longue'], 'Par défaut');
    const r = await send(listeners, { type: 'REPLACE', replacements: [{
      noteId: id, model: 'Basique', deck: 'Par défaut', type: 'basic',
      fingerprint: longFirst, originalSecond: 'Réponse longue', mod: state.notes.get(id).mod,
      first: longFirst, second: 'Réponse longue modifiée' }] });
    assert.equal(r.value.updated, 1, JSON.stringify(r.value));
    assert.equal(fieldValue(state.notes.get(id).fields.Verso), 'Réponse longue modifiée');
  });
  await ta('P2 : second champ de plus de 4000 caractères -> remplacement légitime accepté', async () => {
    const longSecond = 'y'.repeat(4500);
    const id = add('Basique', ['Question verso long', longSecond], 'Par défaut');
    const r = await send(listeners, { type: 'REPLACE', replacements: [{
      noteId: id, model: 'Basique', deck: 'Par défaut', type: 'basic',
      fingerprint: 'Question verso long', originalSecond: longSecond, mod: state.notes.get(id).mod,
      first: 'Question verso long', second: longSecond + ' révisé' }] });
    assert.equal(r.value.updated, 1, JSON.stringify(r.value));
  });
  await ta('P2 : note multi-paquets [A, B] devenue [A, C] -> remplacement refusé', async () => {
    const id = add('Basique', ['Question multi', 'Réponse multi'], 'Médecine (TEST)');
    const r = await send(listeners, { type: 'REPLACE', replacements: [{
      noteId: id, model: 'Basique', deck: 'Médecine (TEST)',
      decks: ['Médecine (TEST)', 'Autre spécialité'], type: 'basic',
      fingerprint: 'Question multi', originalSecond: 'Réponse multi', mod: state.notes.get(id).mod,
      first: 'Question multi', second: 'Réponse multi modifiée' }] });
    assert.equal(r.value.updated, 0);
    assert.match(r.value.failed[0].reason, /déplacée/);
  });
  await ta('P2 : cloze {{c1}} répété comparé au même indice unique -> remplacement accepté', async () => {
    const text = 'Le {{c1::cœur}} et le {{c1::poumon}}.';
    const id = add('Texte à trous', [text, ''], 'Par défaut');
    const r = await send(listeners, { type: 'REPLACE', replacements: [{
      noteId: id, model: 'Texte à trous', deck: 'Par défaut', type: 'cloze',
      fingerprint: text, originalSecond: '', mod: state.notes.get(id).mod,
      first: 'Le {{c1::cœur}} et le {{c1::poumon}} fonctionnent.', second: '' }] });
    assert.equal(r.value.updated, 1, JSON.stringify(r.value));
  });
  await ta('P2 : unicité revérifiée sans cache juste avant écriture', async () => {
    const id = add('Basique', ['Question cache', 'Réponse cache'], 'Par défaut');
    const first = await send(listeners, { type: 'ANALYZE', deck: 'Par défaut', cards: [{ type: 'basic', front: 'Question cache', back: 'Réponse cache' }] });
    assert.equal(first.value.items[0].replaceable, true, 'cas initial : remplaçable');
    // Une seconde note identique apparaît APRÈS l'analyse : le cache ne doit pas
    // masquer l'ambiguïté nouvelle.
    add('Basique', ['Question cache', 'Réponse cache bis'], 'Par défaut');
    const r = await send(listeners, { type: 'REPLACE', replacements: [{
      noteId: id, model: 'Basique', deck: 'Par défaut', type: 'basic',
      fingerprint: 'Question cache', originalSecond: 'Réponse cache', mod: state.notes.get(id).mod,
      first: 'Question cache', second: 'Réponse cache modifiée' }] });
    assert.equal(r.value.updated, 0, 'le cache ne doit pas masquer la note apparue entre-temps');
    assert.match(r.value.failed[0].reason, /Plusieurs notes identiques/);
  });
  await new Promise(r => server.close(r));
}

/* ------------------------------------------------------------------ *
 * 5. Cohérence manifeste / code                                      *
 * ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ *
 * Harnais du popup : on analyse le VRAI popup.html pour que les tests *
 * portent sur la structure réellement livrée, pas sur une copie.      *
 * ------------------------------------------------------------------ */
const VOID_TAGS = new Set(['meta','input','br','img','link','hr','source','area','base','col','embed','param','track','wbr']);
function parseAttrs(src) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
  }
  return out;
}
function parseHTML(src) {
  // Le contenu de <style> et <script> contient des « > » : on le neutralise
  // avant de tokeniser, sinon il serait pris pour des balises.
  const clean = String(src)
    .replace(/<style[\s\S]*?<\/style>/gi, '<style></style>')
    .replace(/<script[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<!--[\s\S]*?-->/g, '');
  const root = new El('#root');
  const stack = [root];
  const re = /<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^>]*?)?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(clean))) {
    if (m[1]) {
      const tag = m[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) { if (stack[i].tagName === tag) { stack.length = i; break; } }
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrs = parseAttrs(m[3] || '');
      const el = new El(tag, attrs);
      stack[stack.length - 1].append(el);
      if (!VOID_TAGS.has(tag) && m[4] !== '/') stack.push(el);
    } else if (m[5] !== undefined) {
      const t = m[5].trim();
      if (t) stack[stack.length - 1].append(t);
    }
  }
  return root;
}
// Texte visible : le contenu d'un bloc replié est masqué, mais son RÉSUMÉ reste
// affiché dans un navigateur — on le traverse donc.
function visibleText(node) {
  let out = '';
  const walk = n => {
    if (n.tagName === '#TEXT') { out += (n._text || '') + ' '; return; }
    if (n.tagName === 'DETAILS') {
      for (const c of n.children) if (c.tagName === 'SUMMARY') walk(c);
      return;
    }
    for (const c of n.children) walk(c);
  };
  for (const c of node.children) walk(c);
  return out;
}
function popupHarness(respond, opts = {}) {
  const doc = parseHTML(fs.readFileSync(EXT('popup.html'), 'utf8'));
  // Comme dans un vrai navigateur : la valeur d'un <select> vient de son option
  // sélectionnée (ou de la première). Le shim ne le fait pas tout seul.
  for (const sel of doc.querySelectorAll('select')) {
    const options = sel.querySelectorAll('option');
    const chosen = options.find(o => o.hasAttribute('selected')) || options[0];
    sel.value = chosen ? (chosen.getAttribute('value') || '') : '';
  }
  const sent = [];
  const tabMessages = [];
  const ctx = {
    console, setTimeout, clearTimeout, Date, JSON, Promise, Number, Set, String, Math, RegExp, Error,
    document: {
      getElementById: id => doc.querySelector('[id="' + id + '"]'),
      querySelector: s => doc.querySelector(s),
      querySelectorAll: s => doc.querySelectorAll(s),
      createElement: tag => new El(tag),
      createTextNode: t => new El('#text', {}, t),
      addEventListener: () => {},
      documentElement: new El('html')
    },
    confirm: () => (opts.confirm === undefined ? true : opts.confirm),
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => { sent.push(msg); const r = respond(msg); if (r && typeof r.then === 'function') r.then(cb); else cb(r); }
      },
      tabs: {
        query: async () => (opts.tabs === undefined ? [{ id: 7 }] : opts.tabs),
        sendMessage: (tabId, msg, cb) => {
          tabMessages.push({ tabId, msg });
          const r = opts.tabReply === undefined ? { ok: true } : opts.tabReply;
          if (r && typeof r.then === 'function') r.then(cb); else cb(r);
        }
      },
      storage: { local: fakeStorage(Object.assign(opts.store || {}, { deck: opts.savedDeck === undefined ? 'Cours' : opts.savedDeck })) }
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of POPUP_SCRIPTS()) load(ctx, f);
  const $ = id => doc.querySelector('[id="' + id + '"]');
  return { ctx, doc, sent, tabMessages, $ };
}
const popupOk = (decks = ['Cours', 'Par défaut']) => msg => {
  if (msg.type === 'PORT_INFO') return { ok: true, value: { port: 8766, manual: false } };
  if (msg.type === 'CONNECT') return { ok: true, value: true };
  if (msg.type === 'DECKS') return { ok: true, value: decks };
  if (msg.type === 'ANALYZE') return { ok: true, value: { items: [{ kind: 'new', duplicates: [] }], totalExisting: 0, scanned: 0, partial: false, scope: 'Cours' } };
  if (msg.type === 'IMPORT') return { ok: true, value: { added: 1, skipped: 0, errors: [], total: 1 } };
  return { ok: false, error: 'action inattendue ' + msg.type };
};
const settle = () => new Promise(r => setTimeout(r, 60));

async function popupTests() {
  await ta('popup : la vue normale n’expose aucun réglage technique', async () => {
    const { doc, $ } = popupHarness(popupOk());
    await settle();
    assert.equal($('settings').open, false, 'le bloc réglages doit être replié');
    assert.equal($('fallback').open, false, 'le bloc de secours doit être replié');
    for (const id of ['ankiPort', 'savePort', 'autoPort', 'json', 'review', 'import', 'deck']) {
      const d = $(id).closest('details');
      assert.ok(d, `${id} doit vivre dans un bloc replié`);
      assert.equal(d.open, false, `${id} ne doit pas être visible au chargement`);
    }
    const visible = visibleText($('settings').parentElement);
    // Les résumés des blocs repliés restent visibles : ils ne doivent pas
    // contenir de jargon technique.
    assert.match(visible, /Réglages et dépannage/, 'le résumé des réglages reste visible');
    assert.match(visible, /Import manuel \(secours\)/, 'le résumé du secours reste visible');
    for (const mot of ['webBindPort', 'Port AnkiConnect', 'quota', 'JSON', '8765', '8766']) {
      assert.ok(!visible.includes(mot), `« ${mot} » ne doit pas apparaître dans la vue normale`);
    }
  });
  await ta('popup : une seule action principale, sélecteur compact 10/20/30/50', async () => {
    const { doc, $ } = popupHarness(popupOk());
    await settle();
    assert.equal(doc.querySelectorAll('button.primary').length, 1, 'une seule action principale');
    assert.equal($('composePrompt').textContent, 'Préparer dans ChatGPT');
    assert.deepEqual($('cardCount').querySelectorAll('option').map(o => o.getAttribute('value')), ['10', '20', '30', '50', '100']);
    assert.equal($('cardCount').value, '20', '20 cartes par défaut');
    assert.equal(doc.querySelectorAll('.hint').length, 1, 'une seule ligne d’aide');
    // Le libellé de l'action ne doit pas être répété (titre + bouton).
    const vtxt = visibleText(doc.querySelector('main'));
    assert.equal((vtxt.match(/Préparer dans ChatGPT/g) || []).length, 1, 'une seule occurrence visible de l’action');
  });
  await ta('popup : état de connexion séparé du message d’action', async () => {
    const { $ } = popupHarness(popupOk());
    await settle();
    assert.match($('connState').textContent, /Anki connecté/, 'connexion affichée');
    assert.equal($('retry').hidden, true, 'pas de bouton de reprise quand tout va bien');
    // Un échec de préparation de prompt ne doit PAS écraser l'état de connexion.
    const { $: $2 } = popupHarness(popupOk(), { tabs: [] });
    await settle();
    $2('composePrompt').onclick();
    await settle();
    assert.match($2('connState').textContent, /Anki connecté/, 'l’état de connexion reste intact');
    assert.match($2('status').textContent, /chatgpt\.com/, 'le message d’action explique quoi faire');
  });
  await ta('popup : Anki indisponible -> état court, reprise visible, action principale utilisable', async () => {
    const respond = msg => msg.type === 'CONNECT' ? { ok: false, error: 'AnkiConnect injoignable' } : popupOk()(msg);
    const { $ } = popupHarness(respond);
    await settle();
    assert.equal($('connState').textContent, 'Anki non détecté');
    assert.equal($('retry').hidden, false, 'le bouton Réessayer doit apparaître');
    assert.match($('status').textContent, /Ouvre Anki/);
    assert.equal($('composePrompt').disabled, false, 'préparer le prompt ne dépend pas d’Anki');
    assert.equal($('deck').value, '', 'pas de paquet obsolète conservé');
  });
  await ta('popup : le port reste réglable après dépliage (PORT_INFO / SET_PORT / CLEAR_PORT)', async () => {
    const { $, sent } = popupHarness(popupOk());
    await settle();
    assert.equal($('ankiPort').value, '8766', 'port courant chargé');
    $('settings').open = true;
    $('ankiPort').value = '9123';
    $('savePort').onclick();
    await settle();
    const setPort = sent.find(m => m.type === 'SET_PORT');
    assert.ok(setPort, 'SET_PORT doit être envoyé');
    assert.equal(setPort.port, 9123);
    $('autoPort').onclick();
    await settle();
    assert.ok(sent.some(m => m.type === 'CLEAR_PORT'), 'CLEAR_PORT doit être envoyé');
  });
  await ta('popup : le port invalide est refusé sans rien envoyer', async () => {
    const { $, sent } = popupHarness(popupOk());
    await settle();
    const before = sent.length;
    $('settings').open = true;
    $('ankiPort').value = 'abc';
    $('savePort').onclick();
    await settle();
    assert.equal(sent.length, before, 'aucun message envoyé pour un port invalide');
    assert.match($('status').textContent, /port entier/);
  });
  await ta('popup : préparer le prompt envoie la demande au bon onglet', async () => {
    const { $, tabMessages } = popupHarness(popupOk());
    await settle();
    $('composePrompt').onclick();
    await settle();
    assert.equal(tabMessages.length, 1, 'un seul message à l’onglet');
    assert.equal(tabMessages[0].tabId, 7);
    assert.equal(tabMessages[0].msg.type, 'ANKI_INSERT_PROMPT');
    assert.match(tabMessages[0].msg.prompt, /20 flashcards/, '20 cartes par défaut');
    assert.match($('status').textContent, /Ajouter à Anki/, 'confirmation affichée');
    $('cardCount').value = '50';
    $('composePrompt').onclick();
    await settle();
    assert.match(tabMessages[1].msg.prompt, /50 flashcards/);
  });
  await ta('popup : le secours JSON reste complet et fonctionnel', async () => {
    const { $, sent } = popupHarness(popupOk(), { confirm: true });
    await settle();
    $('fallback').open = true;
    $('sample').onclick();
    assert.match($('json').value, /"cards"/, 'l’exemple remplit la zone');
    $('review').onclick();
    await settle();
    assert.ok(sent.some(m => m.type === 'ANALYZE'), 'ANALYZE doit être envoyé');
    assert.equal($('analysis').querySelectorAll('.preview-item').length, 1, 'aperçu construit');
    assert.equal($('import').disabled, false, 'import réactivé après vérification');
    $('import').onclick();
    await settle();
    const imp = sent.find(m => m.type === 'IMPORT');
    assert.ok(imp, 'IMPORT doit être envoyé');
    assert.equal(imp.cards.length, 1, 'une carte sélectionnée');
  });
  await ta('popup : une reconnexion réussie efface le message d’erreur', async () => {
    let injoignable = true;
    const respond = msg => {
      if (msg.type === 'CONNECT' && injoignable) return { ok: false, error: 'injoignable' };
      return popupOk()(msg);
    };
    const { $ } = popupHarness(respond);
    await settle();
    assert.equal($('connState').textContent, 'Anki non détecté');
    assert.match($('status').textContent, /Ouvre Anki/, 'erreur affichée au premier essai');
    injoignable = false;
    $('retry').onclick();
    await settle();
    assert.match($('connState').textContent, /Anki connecté/, 'reconnexion détectée');
    assert.equal($('status').textContent, '', 'le message d’erreur doit disparaître après une reconnexion');
    assert.equal($('retry').hidden, true, 'plus de bouton de reprise');
  });
  await ta('popup : une reconnexion réussie ne détruit pas un message d’action', async () => {
    const { $ } = popupHarness(popupOk());
    await settle();
    $('composePrompt').onclick();
    await settle();
    const message = $('status').textContent;
    assert.match(message, /Ajouter à Anki/, 'compte rendu de l’action affiché');
    $('refresh').onclick();
    await settle();
    assert.equal($('status').textContent, message, 'le message d’action doit être conservé');
  });
  await ta('popup : une réponse de connexion tardive n’efface pas le message d’action', async () => {
    let release;
    const pending = new Promise(r => { release = r; });
    const respond = msg => {
      if (msg.type === 'CONNECT' || msg.type === 'DECKS') return pending.then(() => popupOk()(msg));
      return popupOk()(msg);
    };
    const { $ } = popupHarness(respond);
    await settle();
    $('composePrompt').onclick();            // action pendant que la connexion est en vol
    await settle();
    assert.match($('status').textContent, /Ajouter à Anki/, 'message d’action affiché');
    release();                               // la connexion aboutit APRÈS coup
    await settle();
    assert.match($('status').textContent, /Ajouter à Anki/, 'la réponse tardive ne doit pas effacer le message');
    assert.match($('connState').textContent, /Anki connecté/, 'l’état de connexion est bien mis à jour');
  });
  await ta('popup : une reprise tardive ne détruit pas le compte rendu d’import', async () => {
    let release;
    const pending = new Promise(r => { release = r; });
    let armer = false;
    const respond = msg => {
      if (armer && (msg.type === 'CONNECT' || msg.type === 'DECKS')) return pending.then(() => popupOk()(msg));
      return popupOk()(msg);
    };
    const { $ } = popupHarness(respond);
    await settle();
    $('fallback').open = true;
    $('sample').onclick();
    $('review').onclick();
    await settle();
    assert.equal($('import').disabled, false, 'import réactivé');
    armer = true;
    $('import').onclick();
    await settle();
    const compte = $('status').textContent;
    assert.match(compte, /ajoutée/, 'compte rendu d’import affiché');
    $('refresh').onclick();                  // une reprise de connexion arrive après
    await settle();
    release();
    await settle();
    assert.equal($('status').textContent, compte, 'le compte rendu d’import est conservé');
  });
  await ta('popup : le port affiché suit une nouvelle détection automatique', async () => {
    let port = 8765;
    const respond = msg => msg.type === 'PORT_INFO' ? { ok: true, value: { port, manual: false } } : popupOk()(msg);
    const { $ } = popupHarness(respond);
    await settle();
    assert.equal($('ankiPort').value, '8765', 'port initial affiché');
    port = 8766;                             // AnkiConnect re-détecté ailleurs
    $('retry').onclick();
    await settle();
    assert.equal($('ankiPort').value, '8766', 'le panneau doit refléter le nouveau port');
  });
  await ta('popup : un port fixé manuellement n’est pas écrasé', async () => {
    const respond = msg => msg.type === 'PORT_INFO' ? { ok: true, value: { port: 9123, manual: true } } : popupOk()(msg);
    const { $ } = popupHarness(respond);
    await settle();
    assert.equal($('ankiPort').value, '9123');
    $('refresh').onclick();
    await settle();
    assert.equal($('ankiPort').value, '9123', 'le port manuel reste affiché');
  });
  await ta('popup : le détail technique reste confiné au bloc de dépannage', async () => {
    let injoignable = true;
    const respond = msg => {
      if (msg.type === 'CONNECT' && injoignable) return { ok: false, error: 'AnkiConnect injoignable sur 127.0.0.1:8766' };
      return popupOk()(msg);
    };
    const { $ } = popupHarness(respond);
    await settle();
    assert.match($('status').textContent, /Ouvre Anki/, 'message court et actionnable');
    assert.ok(!$('status').textContent.includes('127.0.0.1'), 'aucun détail technique dans la vue normale');
    assert.match($('techDetail').textContent, /127\.0\.0\.1:8766/, 'détail technique disponible');
    assert.equal($('techDetail').closest('details').open, false, 'confiné dans un bloc replié');
    assert.equal($('techDetail').getAttribute('role'), 'status');
    injoignable = false;
    $('retry').onclick();
    await settle();
    assert.equal($('techDetail').textContent, '', 'le détail est effacé après un succès');
    assert.equal($('status').textContent, '', 'plus de message d’erreur');
  });
  await ta('popup : les couleurs de retour respectent le contraste en thème sombre', async () => {
    const css = fs.readFileSync(EXT('popup.html'), 'utf8');
    const dark = css.split('@media (prefers-color-scheme:dark)')[1] || '';
    const lum = hex => {
      const c = [0, 1, 2].map(i => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255)
        .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const fond = '#161a20';
    for (const nom of ['ok', 'error']) {
      const m = dark.match(new RegExp('\\.feedback\\.' + nom + '\\{color:(#[0-9a-fA-F]{6})\\}'));
      assert.ok(m, `couleur sombre manquante pour .feedback.${nom}`);
      const r = ratio(m[1], fond);
      assert.ok(r >= 4.5, `contraste ${nom} insuffisant : ${r.toFixed(2)}:1 (attendu ≥ 4.5 sur ${fond})`);
    }
  });
  await ta('popup : le prompt est générique et n’impose aucune discipline', async () => {
    for (const n of [10, 20, 30, 50, 100]) {
      const { $, tabMessages } = popupHarness(popupOk());
      await settle();
      $('cardCount').value = String(n);
      $('composePrompt').onclick();
      await settle();
      const prompt = tabMessages[0].msg.prompt;
      assert.match(prompt, new RegExp(n + ' flashcards'), n + ' cartes demandées');
      assert.ok(!/m[ée]decine|m[ée]dical|clinique|examen|insuline|pancr[ée]as/i.test(prompt),
        'le prompt ne doit supposer aucune discipline (' + n + ')');
      assert.match(prompt, /cours, des notes, du document ou du contenu/, 'sources acceptées');
      assert.match(prompt, /demande-moi de te le fournir/, 'contenu exigé avant génération');
      assert.match(prompt, /quel que soit le sujet/, 'aucune restriction de sujet');
      assert.match(prompt, /Respecte strictement les faits, chiffres, unités, noms et références/, 'faits du document');
      assert.match(prompt, /N’invente aucune information/, 'contrainte de non-invention');
      assert.match(prompt, /n’ajoute aucune connaissance absente/, 'aucun apport externe');
      assert.match(prompt, /une connaissance par carte/, 'une connaissance par carte');
      assert.match(prompt, /Évite les doublons/, 'anti-doublons');
      assert.match(prompt, /un seul bloc de code JSON valide, sans texte avant ou après/, 'réponse unique');
      assert.match(prompt, /"tags":\["revision"\]/, 'tag générique par défaut');
      assert.ok(!/"tags":\["medecine"\]/.test(prompt), 'aucun tag propre à une discipline');
      for (const cle of ['cards', 'type', 'basic', 'cloze', 'front', 'back', 'text', 'extra', 'tags']) {
        assert.ok(prompt.includes('"' + cle + '"'), 'clé JSON attendue : ' + cle);
      }
    }
  });
  await ta('popup : le prompt décrit la mise en forme autorisée, sans lien ni HTML', async () => {
    const { $, tabMessages } = popupHarness(popupOk());
    await settle();
    $('composePrompt').onclick();
    await settle();
    const prompt = tabMessages[0].msg.prompt;
    for (const piece of ['**gras**', '*italique*', '`code`', '« - »', '« 1. »', '^texte^', '~texte~', '\\n dans le JSON']) {
      assert.ok(prompt.includes(piece), 'mise en forme non annoncée : ' + piece);
    }
    assert.match(prompt, /Aucun lien, aucune image, aucune balise HTML/);
    assert.match(prompt, /jamais à cheval sur ses accolades/);
    assert.ok(!/Na\^|Ca\^|H~2~O/.test(prompt), 'exemples neutres, sans discipline');
  });
  await ta('popup : le prompt demande des réponses structurées et des trous courts', async () => {
    const { $, tabMessages } = popupHarness(popupOk());
    await settle();
    $('composePrompt').onclick();
    await settle();
    const prompt = tabMessages[0].msg.prompt;
    assert.match(prompt, /ne réduis pas une explication à une phrase/);
    assert.match(prompt, /explication structurée sur plusieurs lignes/);
    assert.match(prompt, /le trou \{\{c1::…\}\} ne contient que le terme ou la courte expression à retenir, sans mise en forme autour/);
    assert.match(prompt, /les explications vont dans "extra"/);
    // L'exemple du prompt est du JSON valide dont la réponse devient une vraie liste dans Anki.
    const example = JSON.parse(prompt.match(/Structure attendue : (\{.*?\]\})\./)[1]);
    assert.equal(cardsContext().toCards(example).length, 2);
    assert.equal(sharedContext().toAnkiHtml(example.cards[0].back), 'Réponse essentielle en une phrase.<br><br><b>Explication</b> :<ul><li>premier point</li><li>second point</li></ul>');
  });
  await ta('popup : apparence automatique / clair / sombre, mémorisée et partagée', async () => {
    const store = { theme: 'dark' };
    const { $, ctx } = popupHarness(popupOk(), { store });
    await settle();
    assert.equal(ctx.document.documentElement.getAttribute('data-theme'), 'dark', 'réglage mémorisé appliqué');
    assert.equal($('theme').value, 'dark');
    assert.deepEqual($('theme').querySelectorAll('option').map(o => o.getAttribute('value')), ['auto', 'light', 'dark']);
    assert.ok($('theme').closest('details'), 'réglage rangé dans « Réglages et dépannage »');
    $('theme').value = 'auto'; $('theme').dispatchEvent(new Event('change'));
    await settle();
    assert.equal(ctx.document.documentElement.getAttribute('data-theme'), null, 'automatique : suit le système');
    assert.equal(store.theme, 'auto');
    const css = fs.readFileSync(EXT('popup.html'), 'utf8');
    assert.match(css, /:root\[data-theme="dark"\] \.feedback\.ok\{color:#86efac\}/, 'sombre imposé');
    assert.match(css, /:root:not\(\[data-theme="light"\]\) \.feedback\.ok\{color:#86efac\}/, 'automatique, sauf clair imposé');
  });
  await ta('popup : l’exemple de secours est neutre et accepté par le parseur', async () => {
    const { $ } = popupHarness(popupOk());
    await settle();
    $('sample').onclick();
    const exemple = $('json').value;
    assert.ok(!/m[ée]decine|m[ée]dical|insuline|pancr[ée]as|cellules/i.test(exemple), 'exemple sans contenu médical');
    const cards = JSON.parse(exemple).cards;
    assert.equal(cards.length, 2);
    assert.equal(cards[0].type, 'basic');
    assert.equal(cards[1].type, 'cloze');
    for (const c of cards) assert.ok(c.tags.includes('revision'), 'chaque exemple porte un tag générique');
    assert.equal(cardsContext().toCards(exemple).length, 2, 'les exemples doivent passer le parseur de l’extension');
  });
  await ta('popup : un sujet inventé passe sans restriction', async () => {
    const exemple = JSON.stringify({ cards: [
      { type: 'basic', front: 'Que produit l’organe fictif Numa ?', back: 'De l’Oria.', tags: ['revision'] },
      { type: 'cloze', text: 'Le Numa produit de l’{{c1::Oria}}.', extra: '', tags: ['revision'] }
    ] });
    assert.equal(cardsContext().toCards(exemple).length, 2, 'un sujet inventé doit être accepté');
    const { $, tabMessages } = popupHarness(popupOk());
    await settle();
    $('composePrompt').onclick();
    await settle();
    assert.ok(!/m[ée]decine|m[ée]dical/i.test(tabMessages[0].msg.prompt), 'le prompt reste neutre');
  });
  await ta('popup : les zones de retour sont annoncées aux lecteurs d’écran', async () => {
    const { $ } = popupHarness(popupOk());
    await settle();
    assert.equal($('connState').getAttribute('role'), 'status');
    assert.equal($('connState').getAttribute('aria-live'), 'polite');
    assert.equal($('status').getAttribute('role'), 'status');
    assert.equal($('status').getAttribute('aria-live'), 'polite');
    assert.ok($('connDot').getAttribute('class').includes('dot'), 'point d’état décoratif');
    assert.equal($('connDot').getAttribute('aria-hidden'), null);
  });
  await ta('popup : largeur compacte et absence de défilement dans la vue normale', async () => {
    const html = fs.readFileSync(EXT('popup.html'), 'utf8');
    const w = Number((html.match(/body\{[^}]*width:(\d+)px/) || [])[1]);
    assert.ok(w >= 320 && w <= 360, `largeur attendue entre 320 et 360 px, obtenu ${w}`);
    // La vue normale ne doit contenir aucune zone défilante : les seules règles
    // `overflow:auto` doivent viser l'aperçu du mode de secours, qui est replié.
    const head = html.split('<body>')[0];
    for (const rule of (head.match(/[^{}]+\{[^}]*overflow:\s*auto[^}]*\}/g) || [])) {
      assert.ok(/#analysis/.test(rule), `zone défilante hors du secours replié : ${rule.trim().slice(0, 60)}`);
    }
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html), 'aucun émoji dans l’interface');
  });
}

/* ------------------------------------------------------------------ *
 * 8. Mise en forme des cartes (shared.js)                            *
 * ------------------------------------------------------------------ */
// Ancienne conversion (1.5.0), gardée ici comme référence de compatibilité.
const legacyHtml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll('\n', '<br>');
// Les balises produites sont bien imbriquées et ne traversent jamais un {{c1::…}}.
function wellNested(html) {
  const stack = [];
  const re = /<(\/?)([a-z]+)[^>]*>|\{\{c\d+::|\}\}/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('{{')) stack.push('cloze');
    else if (m[0] === '}}') { if (stack.pop() !== 'cloze') return false; }
    else if (m[2] === 'br') continue;
    else if (!m[1]) stack.push(m[2]);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}
// Empreinte visuelle d'un rendu : chaque caractère avec l'ensemble trié de ses styles.
function signature(node, styles = []) {
  if (node.tagName === '#TEXT') return [...(node._text || '')].map(c => c + '{' + [...styles].sort().join(',') + '}').join('');
  const tag = node.tagName.toLowerCase();
  if (tag === 'br') return '|';
  const next = ['b', 'i', 'sup', 'sub', 'code'].includes(tag) && !styles.includes(tag) ? styles.concat(tag) : styles;
  const inner = (node._text ? [...node._text].map(c => c + '{' + [...next].sort().join(',') + '}').join('') : '') + node.children.map(c => signature(c, next)).join('');
  return tag === 'li' ? '[li:' + inner + ']' : tag === 'ul' || tag === 'ol' ? `<${tag}${node.getAttribute('start') || ''}>` + inner + `</${tag}>` : inner;
}
function formatTests() {
  const S = sharedContext();
  const H = S.toAnkiHtml;
  t('format : texte sans mise en forme identique à la 1.5 (échappement + <br>)', () => {
    for (const x of ['Question simple ?', 'a < b & c > d "cité"', 'ligne 1\nligne 2\n\nligne 4', "l'apostrophe", '<script>alert(1)</script>', '', '5 - 3 = 2', 'x * y', '2^10 et 3^5', '~5 mg ou ~10 mg', 'Le {{c1::cœur}} pompe.', '{{c1::Parent::indice}}', '-5 °C', '1.5 g/L']) {
      assert.equal(H(x), legacyHtml(x), JSON.stringify(x));
      assert.equal(S.hasFormatting(x), false, JSON.stringify(x));
    }
  });
  t('format : gras, italique, code', () => {
    assert.equal(H('**gras** et *italique* et `code`'), '<b>gras</b> et <i>italique</i> et <code>code</code>');
    assert.equal(H('*a **b** c*'), '<i>a <b>b</b> c</i>');
    assert.equal(H('`**pas de gras**`'), '<code>**pas de gras**</code>', 'rien n’est interprété dans du code');
    assert.equal(H('** pas gras **'), '** pas gras **', 'espaces intérieurs : texte brut');
    assert.equal(H('**non fermé'), '**non fermé');
  });
  t('format : exposant et indice (Na^+^, Ca^2+^, H~2~O)', () => {
    assert.equal(H('Na^+^'), 'Na<sup>+</sup>');
    assert.equal(H('Ca^2+^ et 10^-3^ M'), 'Ca<sup>2+</sup> et 10<sup>-3</sup> M');
    assert.equal(H('H~2~O et CO~2~'), 'H<sub>2</sub>O et CO<sub>2</sub>');
    assert.equal(H('~~barré~~'), '~~barré~~', 'pas de barré');
    assert.equal(H('x^a b^'), 'x^a b^', 'pas d’espace dans un exposant');
  });
  t('format : listes « - » et « 1. », retours à la ligne', () => {
    assert.equal(H('Causes :\n- une\n- deux\nFin'), 'Causes :<ul><li>une</li><li>deux</li></ul>Fin');
    assert.equal(H('1. un\n2. **deux**'), '<ol><li>un</li><li><b>deux</b></li></ol>');
    assert.equal(H('3. trois\n4. quatre'), '<ol start="3"><li>trois</li><li>quatre</li></ol>');
    assert.equal(H('Titre\n\n- a\n\nSuite'), 'Titre<ul><li>a</li></ul>Suite', 'lignes vides collées à la liste retirées');
    assert.equal(H('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>');
  });
  t('format : réponse longue en plusieurs paragraphes, listes et étapes', () => {
    const back = 'Le mécanisme se déroule en trois temps.\n\n**Étapes** :\n1. Détection du signal\n2. *Amplification* par une cascade\n3. Réponse de la cellule\n\n**À retenir** :\n- le signal est **transitoire**\n- les ions Ca^2+^ servent de relais\n\nSource : cours, partie 2.';
    assert.equal(H(back), 'Le mécanisme se déroule en trois temps.<br><br><b>Étapes</b> :<ol><li>Détection du signal</li><li><i>Amplification</i> par une cascade</li><li>Réponse de la cellule</li></ol>' +
      '<b>À retenir</b> :<ul><li>le signal est <b>transitoire</b></li><li>les ions Ca<sup>2+</sup> servent de relais</li></ul>Source : cours, partie 2.');
    assert.ok(wellNested(H(back)));
  });
  t('format : ni lien, ni image, ni HTML brut', () => {
    assert.equal(H('[lien](https://exemple.test)'), '[lien](https://exemple.test)');
    assert.equal(H('![img](x.png)'), '![img](x.png)');
    assert.equal(H('**<img src=x onerror=alert(1)>**'), '<b>&lt;img src=x onerror=alert(1)&gt;</b>');
    assert.equal(H('`<b>`'), '<code>&lt;b&gt;</code>');
    assert.equal(H('^<i>^'), '<sup>&lt;i&gt;</sup>');
    for (const x of ['<a href="javascript:alert(1)">x</a>', '**<script>**', '- <iframe>', '<svg onload=alert(1)>']) {
      assert.ok(!/<(a|img|script|iframe|svg)\b/i.test(H(x)), x);
    }
  });
  t('format : marqueurs {{c1::…}} intacts, y compris avec * ou ^', () => {
    assert.equal(H('{{c1::Na^+^}} entre'), '{{c1::Na<sup>+</sup>}} entre');
    assert.equal(H('**{{c1::cœur}}** pompe'), '<b>{{c1::cœur}}</b> pompe');
    assert.equal(H('{{c1::a*b}} et c*d'), '{{c1::a*b}} et c*d', 'l’italique ne traverse pas le trou');
    assert.equal(H('**{{c1::a** b}}'), '**{{c1::a** b}}', 'le gras ne coupe pas le trou');
    assert.equal(H('{{c1::Ca^2+^::ion **divalent**}}'), '{{c1::Ca<sup>2+</sup>::ion **divalent**}}', 'indice laissé tel quel');
    assert.equal(H('{{c1::a {{c2::*b*}} c}}'), '{{c1::a {{c2::<i>b</i>}} c}}', 'trous imbriqués');
    assert.equal(H('- {{c1::un\n- deux}}'), '<ul><li>{{c1::un<br>- deux}}</li></ul>', 'un retour à la ligne dans un trou ne crée pas de liste');
    assert.equal(H('{{c1::non fermé *a*'), '{{c1::non fermé <i>a</i>');
  });
  t('format : 2000 textes aléatoires -> balises bien imbriquées, trous intacts', () => {
    let seed = 42;
    const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const bits = ['**', '*', '^', '~', '`', 'a', 'Na', '+', '2', ' ', '\n', '- ', '1. ', '::', '<', '&', '"'];
    const part = k => Array.from({ length: k }, () => bits[rnd(bits.length)]).join('');
    for (let n = 0; n < 2000; n++) {
      let text = '';
      for (let k = rnd(6); k >= 0; k--) {
        text += part(rnd(5));
        if (rnd(2)) text += '{{c' + (1 + rnd(3)) + '::' + part(1 + rnd(4)).replaceAll('::', ':') + (rnd(3) ? '' : '::' + part(rnd(3)).replaceAll('::', '')) + '}}';
      }
      const html = H(text);
      assert.ok(wellNested(html), 'imbrication invalide : ' + JSON.stringify(text) + ' -> ' + html);
      const braces = x => x.replace(/[^{}]/g, '');
      assert.equal(braces(html), braces(text), 'accolades modifiées : ' + JSON.stringify(text));
      const clozes = x => (x.match(/\{\{c\d+::/g) || []).join('');
      assert.equal(clozes(html), clozes(text), 'marqueur de trou modifié : ' + JSON.stringify(text));
      assert.ok(!/<(?!\/?(b|i|code|sup|sub|ul|ol|li|br)\b)/.test(html), 'balise inattendue : ' + html);
    }
  });
  t('format : texte brut pour les comparaisons (marqueurs retirés, trous gardés)', () => {
    assert.equal(S.stripMarkdown('**Na^+^** et H~2~O'), 'Na+ et H2O');
    assert.equal(S.stripMarkdown('Causes :\n- une\n1. deux'), 'Causes :\nune\ndeux');
    assert.equal(S.stripMarkdown('{{c1::Ca^2+^::ion}}'), '{{c1::Ca2+::ion}}');
    // Le texte d'Anki (HTML retiré) et la carte Markdown donnent la même base.
    const card = '**Ion** Na^+^, H~2~O\n- un\n- deux';
    assert.equal(S.htmlToText(H(card)).replace(/\s+/g, ' ').trim(), S.stripMarkdown(card).replace(/\s+/g, ' ').trim());
  });
  t('similarité : la mise en forme est ignorée', () => {
    const ctx = { console }; ctx.globalThis = ctx; vm.createContext(ctx);
    load(ctx, 'shared.js'); load(ctx, 'similarity.js');
    const Sim = ctx.AnkiSimilarity;
    assert.equal(Sim.normalize('**Rôle** de H~2~O et Na^+^ ?'), Sim.normalize('Rôle de H2O et Na+ ?'));
    assert.equal(Sim.normalize('- un\n- deux'), Sim.normalize('un deux'));
    // Note Anki lue par AnkiSearch (balises retirées) contre la même carte en Markdown.
    const existing = [{ id: 1, fields: [{ text: 'Rôle de H2O et Na+ dans la cellule ?' }, { text: 'r' }] }];
    const [r] = Sim.analyze([{ type: 'basic', front: 'Rôle de H~2~O et **Na^+^** dans la cellule ?', back: 'x' }], existing, [true]);
    assert.equal(r.kind, 'similar');
    assert.equal(r.matches[0].score, 1);
  });
  t('aperçu : DOM sûr (createElement / textContent), jamais de HTML interprété', () => {
    const doc = { createElement: tag => new El(tag), createTextNode: x => new El('#text', {}, x) };
    const box = new El('div');
    S.renderInto(box, '**Na^+^** et `<img src=x onerror=alert(1)>`\n- {{c1::H~2~O::eau}}\n- *b*', doc);
    assert.equal(box.querySelectorAll('img').length, 0, 'aucune image créée');
    assert.equal(box.querySelector('b sup').textContent, '+');
    assert.equal(box.querySelector('code').textContent, '<img src=x onerror=alert(1)>');
    assert.equal(box.querySelectorAll('ul li').length, 2);
    assert.equal(box.querySelector('.ankibridge-cloze sub').textContent, '2');
    assert.match(box.querySelector('.ankibridge-clozehint').textContent, /indice : eau/);
    assert.equal(box.querySelector('li i').textContent, 'b');
    S.renderInto(box, 'texte\nsimple', doc);
    assert.equal(box.querySelectorAll('br').length, 1, 'le contenu précédent est remplacé');
  });
  t('trous : positions exactes dans la source (2000 textes aléatoires)', () => {
    let seed = 7;
    const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const bits = ['**', '*', '^', '~', '`', 'mot', ' ', '\n', '- ', '1. ', ':', '+', '2'];
    const part = k => Array.from({ length: k }, () => bits[rnd(bits.length)]).join('');
    for (let n = 0; n < 2000; n++) {
      let text = '';
      for (let k = rnd(5); k >= 0; k--) { text += part(rnd(5)); if (rnd(2)) text += '{{c' + (1 + rnd(3)) + '::' + part(1 + rnd(3)).replaceAll(':', '') + (rnd(3) ? '' : '::ind') + '}}'; }
      const walk = nodes => nodes.forEach(x => {
        if (x.t === 'text' || x.t === 'code') assert.equal(text.slice(x.o, x.o + x.v.length), x.v, JSON.stringify(text));
        if (x.t === 'cloze') assert.ok(text.startsWith(x.prefix, x.start) && text.slice(x.end - 2, x.end) === '}}', JSON.stringify(text));
        if (x.c) walk(x.c);
      });
      S.parseFormatting(text).forEach(b => (b.t === 'lines' ? b.lines : b.items).forEach(walk));
      for (const c of S.clozesOf(text)) assert.equal(text.slice(c.cStart, c.cEnd), c.content);
    }
  });
  t('trous : réponse modifiée à sa place, mise en forme englobante conservée', () => {
    const text = 'DHCP : {{c1::**Discover → ACK**}}.\n- ion {{c2::Na^+^::cation}}';
    assert.deepEqual(plain(S.clozesOf(text).map(c => [c.n, c.content, c.hint])), [[1, '**Discover → ACK**', null], [2, 'Na^+^', 'cation']]);
    assert.deepEqual(plain(S.splitAnswer('**Discover → ACK**')), { value: 'Discover → ACK', wrap: '**' });
    assert.deepEqual(plain(S.splitAnswer('**a** et **b**')), { value: '**a** et **b**', wrap: '' }, 'pas un seul gras englobant');
    assert.equal(S.setClozeAnswer(text, 0, 'DORA', '**').text, 'DHCP : {{c1::**DORA**}}.\n- ion {{c2::Na^+^::cation}}');
    assert.equal(S.setClozeAnswer(text, 1, 'K^+^').text, 'DHCP : {{c1::**Discover → ACK**}}.\n- ion {{c2::K^+^::cation}}', 'indice conservé');
    for (const bad of ['', '   ', 'a}}b', 'a{{b', 'a::b', 'a\nb']) assert.equal(S.setClozeAnswer(text, 0, bad).ok, false, JSON.stringify(bad));
    assert.equal(S.setClozeAnswer(text, 5, 'x').ok, false, 'trou inexistant');
    assert.equal(S.setClozeNumber(text, 1, 1).text, 'DHCP : {{c1::**Discover → ACK**}}.\n- ion {{c1::Na^+^::cation}}', 'numéro changé, contenu et indice intacts');
    assert.equal(S.setClozeNumber(text, 0, 12).text.startsWith('DHCP : {{c12::**Discover'), true);
    for (const bad of [0, -1, 1.5, 'x', 1000]) assert.equal(S.setClozeNumber(text, 0, bad).ok, false, String(bad));
    assert.equal(S.setClozeNumber(text, 7, 1).ok, false, 'trou inexistant');
    assert.equal(S.removeCloze(text, 0).text, 'DHCP : **Discover → ACK**.\n- ion {{c2::Na^+^::cation}}', 'le texte reste, sans marqueur');
  });
  t('trous : une sélection devient un trou, jamais au prix d’une mise en forme cassée', () => {
    const text = 'Le **processus DHCP** suit {{c1::DORA}} en `code` et Na^+^.';
    const at = w => [text.indexOf(w), text.indexOf(w) + w.length];
    let r = S.addCloze(text, ...at('suit'));
    assert.equal(r.text, 'Le **processus DHCP** suit {{c1::DORA}} en `code` et Na^+^.'.replace('suit', '{{c2::suit}}'));
    assert.equal(r.n, 2, 'numéro suivant : une nouvelle carte');
    r = S.addCloze(text, ...at('DHCP'));
    assert.equal(r.text, 'Le **processus {{c2::DHCP}}** suit {{c1::DORA}} en `code` et Na^+^.', 'dans un gras : accepté');
    r = S.addCloze(text, text.indexOf(' suit') - 1, text.indexOf(' suit') + 5);
    assert.equal(r.ok, false, 'à cheval sur la fin du gras'); assert.match(r.error, /coupe une mise en forme/);
    assert.match(S.addCloze(text, ...at('DORA')).error, /trou existant/);
    assert.equal(S.addCloze(text, ...at('code')).ok, false, 'dans du code : refusé');
    assert.match(S.addCloze('a\nb', 0, 3).error, /une seule ligne/);
    assert.match(S.addCloze(text, 5, 5).error, /Sélectionne/);
    assert.equal(S.addCloze(text, text.indexOf('suit') - 1, text.indexOf('suit') + 5).text.includes('{{c2::suit}}'), true, 'espaces de bord retirés');
    assert.equal(S.readableTitle('Le {{c1::**DORA**::4 étapes}} et {{c2::Na^+^}}'), 'Le [DORA] et [Na+]');
  });
  t('éditeur → texte : aller-retour sans perte sur 2000 textes aléatoires', () => {
    const doc = { createElement: tag => new El(tag), createTextNode: x => new El('#text', {}, x) };
    let seed = 99;
    const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const bits = ['**', '*', '^', '~', '`', 'mot', 'Na', '+', '2', ' ', '\n', '\n\n', '- ', '1. ', ':', '<', '&', '"'];
    for (let n = 0; n < 2000; n++) {
      const text = Array.from({ length: 1 + rnd(12) }, () => bits[rnd(bits.length)]).join('').replace(/^\s+|\s+$/g, '');
      const box = new El('div');
      S.renderInto(box, text, doc);
      const back = S.domToMarkdown(box);
      // Rendu identique caractère par caractère (styles, sauts, listes) ; l'ordre
      // d'imbrication de deux styles (<b><sup> ou <sup><b>) n'a pas d'effet visible.
      const look = md => { const b = new El('div'); S.renderInto(b, md, doc); return signature(b); };
      assert.equal(look(back), look(text), 'aller-retour : ' + JSON.stringify(text) + ' -> ' + JSON.stringify(back));
    }
  });
  t('éditeur → texte : ce que produit Chrome (div, br, listes, styles imbriqués, collage)', () => {
    const md = (...kids) => S.domToMarkdown(h('div', { contenteditable: 'true' }, ...kids));
    assert.equal(md('Ligne 1', h('div', {}, 'Ligne 2'), h('div', {}, h('br')), h('div', {}, 'Ligne 4')), 'Ligne 1\nLigne 2\n\nLigne 4');
    assert.equal(md(h('b', {}, 'gras ', h('i', {}, 'et italique')), ' fin'), '**gras *et italique*** fin', 'styles imbriqués');
    assert.equal(md(h('b', {}, 'a', h('b', {}, 'b'))), '**ab**', 'gras imbriqué : un seul gras');
    assert.equal(md(h('b', {}, ' espace ')), ' **espace** ', 'espaces sortis des marqueurs');
    assert.equal(md(h('ol', { start: '3' }, h('li', {}, 'trois'), h('li', {}, h('div', {}, 'quatre')))), '3. trois\n4. quatre');
    assert.equal(md('Na', h('sup', {}, '+'), ' et H', h('sub', {}, '2'), 'O'), 'Na^+^ et H~2~O');
    assert.equal(md(h('span', { style: 'color:red' }, 'rouge'), h('a', { href: 'x' }, 'lien'), h('img', { src: 'x' })), 'rougelien', 'styles, liens et images ignorés');
    assert.equal(md(h('span', { class: 'ankibridge-hole', 'data-src': '{{c1::**DORA**::indice}}' }, h('input'), '×')), '{{c1::**DORA**::indice}}', 'trou recopié tel quel');
    assert.equal(md('a', h('br')), 'a', 'bouche-trou final ignoré');
    assert.equal(md('Na', h('sup', {}, '+ et plus')), 'Na^+^ ^et^ ^plus^', 'exposant avec espaces : jamais de ^ visible dans Anki');
    assert.equal(H(md('Na', h('sup', {}, '+ et plus'))), 'Na<sup>+</sup> <sup>et</sup> <sup>plus</sup>');
  });
  t('paquet : validation du nom à créer', () => {
    const ok = x => S.validateDeckName(x);
    assert.equal(ok('Cardio::Cours 3').name, 'Cardio::Cours 3');
    assert.equal(ok('  Cardio :: Cours   3 ').name, 'Cardio::Cours 3');
    assert.equal(ok('Cardio › Cours 3').name, 'Cardio::Cours 3', '« › » affiché accepté comme « :: »');
    assert.equal(ok('x'.repeat(150)).ok, true);
    for (const bad of ['', '  ', '::', 'A::', '::B', 'A::::B', 'x'.repeat(151), 'Cours "3"', 'Cours « 3 »', 'Cours “3”', 'a\u0007b']) {
      assert.equal(ok(bad).ok, false, JSON.stringify(bad));
      assert.ok(ok(bad).error, 'message attendu pour ' + JSON.stringify(bad));
    }
    assert.equal(S.sameDeck('Cours', 'cours'), true);
  });
}

function manifestTests() {
  const mf = JSON.parse(fs.readFileSync(EXT('manifest.json'), 'utf8'));
  t('manifeste MV3', () => assert.equal(mf.manifest_version, 3));
  // La version exacte est vérifiée à la publication (tag vX.Y.Z = manifeste) : ici, seulement le format.
  t('version au format X.Y.Z', () => assert.match(mf.version, /^\d+\.\d+\.\d+$/));
  t('permission d’hôte limitée à la boucle locale, tous ports', () => assert.deepEqual(mf.host_permissions, ['http://127.0.0.1/*']));
  t('permissions minimales (storage seul)', () => assert.deepEqual(mf.permissions, ['storage']));
  t('aucune permission large', () => assert.ok(!JSON.stringify(mf).includes('<all_urls>')));
  t('content scripts limités à chatgpt.com / chat.openai.com', () => assert.deepEqual(mf.content_scripts[0].matches, ['https://chatgpt.com/*', 'https://chat.openai.com/*']));
  t('aucune URL distante dans les sources', () => {
    const files = fs.readdirSync(EXT('')).filter(f => /\.(js|html|css|json)$/.test(f));
    for (const f of files) {
      const src = fs.readFileSync(EXT(f), 'utf8');
      const hosts = (src.match(/https?:\/\/[a-zA-Z0-9._-]+/g) || []);
      for (const hurl of hosts) assert.ok(/127\.0\.0\.1|chatgpt\.com|chat\.openai\.com|www\.w3\.org/.test(hurl), `${f}: URL distante ${hurl}`);
    }
  });
  t('le runner refuse de signaler un succès sur une suite incomplète', () => {
    // Garde anti-« succès trompeur » : un échec, une section manquante ou des
    // tests non exécutés doivent produire un code de sortie non nul.
    assert.equal(runnerVerdict({ fail: 0, ranSections: 5, expectedSections: 5, declared: 10, executed: 10 }).code, 0);
    assert.equal(runnerVerdict({ fail: 1, ranSections: 5, expectedSections: 5, declared: 10, executed: 10 }).code, 1);
    assert.equal(runnerVerdict({ fail: 0, ranSections: 4, expectedSections: 5, declared: 10, executed: 10 }).code, 4, 'section manquante');
    assert.equal(runnerVerdict({ fail: 0, ranSections: 5, expectedSections: 5, declared: 10, executed: 7 }).code, 4, 'tests non exécutés');
  });
  t('P2 : sonde des ports dans l’ordre standard, 8765 puis 8766', () => {
    const src = fs.readFileSync(EXT('background.js'), 'utf8');
    assert.match(src, /const PROBE_PORTS = \[8765, 8766\]/,
      'l’ordre standard doit être respecté ; la vérification de version écarte un port occupé');
  });
  t('review PR #3 : une seule règle .ankibridge-card, sans bordure ni marge héritées', () => {
    // Une règle héritée plus bas dans la feuille écrasait la remise à zéro et
    // rajoutait bordure, padding et marge sur chaque ligne de carte.
    const css = fs.readFileSync(EXT('content.css'), 'utf8');
    const rules = (css.match(/^\.ankibridge-card\s*\{[^}]*\}/gm) || []);
    assert.equal(rules.length, 1, 'une seule règle .ankibridge-card attendue');
    assert.match(rules[0], /border:0/);
    assert.match(rules[0], /padding:0/);
    assert.match(rules[0], /margin:0/);
  });
  t('aucune formulation centrée sur une discipline dans l’extension', () => {
    // L'extension sert toutes les matières : plus aucune formulation visible ne
    // doit supposer la médecine.
    const files = fs.readdirSync(EXT('')).filter(f => /\.(js|html)$/.test(f));
    for (const f of files) {
      const src = fs.readFileSync(EXT(f), 'utf8');
      assert.ok(!/m[ée]decin|m[ée]dic|medical|clinique/i.test(src), `${f}: formulation liée à une discipline`);
    }
  });
  t('aucune information de configuration personnelle dans les sources', () => {
    // Règle volontairement GÉNÉRIQUE : elle ne nomme ni outil, ni agent, ni fichier
    // d'un environnement particulier. Un chemin de compte, une adresse électronique
    // ou un secret n'ont rien à faire dans un dépôt public.
    const files = fs.readdirSync(EXT('')).filter(f => /\.(js|html|css|json)$/.test(f));
    for (const f of files) {
      const src = fs.readFileSync(EXT(f), 'utf8');
      assert.ok(!/\/Users\/[A-Za-z0-9._-]|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|sk-[A-Za-z0-9]{10,}|BEGIN [A-Z ]*PRIVATE KEY/.test(src),
        `${f}: chemin de compte, adresse électronique ou secret`);
    }
  });
  t('chargement : shared.js en premier partout (page, popup, service worker)', () => {
    const page = CONTENT_SCRIPTS();
    assert.deepEqual(page, ['shared.js', 'cards.js', 'picker.js', 'rich.js', 'review.js', 'content.js']);
    assert.equal(POPUP_SCRIPTS()[0], 'shared.js');
    assert.equal(BACKGROUND_SCRIPTS()[0], 'shared.js');
    for (const f of [...page, ...POPUP_SCRIPTS(), ...BACKGROUND_SCRIPTS()]) assert.ok(fs.existsSync(EXT(f)), f + ' manquant');
  });
  t('content.js découpé : détection d’un côté, fenêtre de vérification de l’autre', () => {
    const content = fs.readFileSync(EXT('content.js'), 'utf8');
    assert.ok(!/function showModal|function createDeckPicker|function askConfirm/.test(content), 'la fenêtre ne vit plus dans content.js');
    assert.match(fs.readFileSync(EXT('review.js'), 'utf8'), /async function showModal/);
    assert.match(fs.readFileSync(EXT('picker.js'), 'utf8'), /function createDeckPicker/);
    for (const f of ['content.js', 'picker.js', 'rich.js', 'review.js']) {
      const lines = fs.readFileSync(EXT(f), 'utf8').split('\n').length;
      assert.ok(lines < 520, `${f} : ${lines} lignes`);
    }
  });
  t('fonctions communes définies une seule fois (shared.js)', () => {
    for (const f of ['content.js', 'picker.js', 'rich.js', 'review.js', 'popup.js', 'background.js', 'search.js']) {
      const src = fs.readFileSync(EXT(f), 'utf8');
      assert.ok(!/(const|function)\s+(normText|deckLabel)\b\s*[=(]/.test(src), `${f} redéfinit normText ou deckLabel`);
      assert.ok(!/replaceAll\('&', '&amp;'\)|replace\(\/&amp;\/gi/.test(src), `${f} réimplémente l’échappement HTML`);
    }
  });
  t('aucun innerHTML ni insertion de HTML brut dans l’extension', () => {
    for (const f of fs.readdirSync(EXT('')).filter(x => /\.js$/.test(x))) {
      const src = fs.readFileSync(EXT(f), 'utf8');
      assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/.test(src), `${f} : insertion de HTML brut`);
    }
  });
  t('écritures Anki limitées : addNote (via multi), updateNoteFields, createDeck', () => {
    const src = fs.readFileSync(EXT('background.js'), 'utf8');
    const actions = [...src.matchAll(/anki\('([a-zA-Z]+)'/g)].map(m => m[1]).concat([...src.matchAll(/action: '([a-zA-Z]+)'/g)].map(m => m[1]));
    for (const a of actions) assert.ok(!/^(delete|remove|change|set|forget|suspend|clear)/i.test(a), 'action destructive : ' + a);
    assert.ok(!/addNotes'/.test(src), 'addNotes (échec en bloc) non utilisé');
  });
  t('aucune clé API / télémétrie dans les sources', () => {
    const files = fs.readdirSync(EXT('')).filter(f => /\.(js|html|json)$/.test(f));
    for (const f of files) {
      const src = fs.readFileSync(EXT(f), 'utf8');
      assert.ok(!/sk-[A-Za-z0-9]{10,}|api[_-]?key\s*[:=]\s*['"][^'"]+|gtag|mixpanel|sentry|telemetry/i.test(src), `${f}: motif sensible`);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Verdict du runner : logique pure, donc testable. Un échec, une      *
 * section manquante ou des tests non exécutés donnent un code non nul. *
 * ------------------------------------------------------------------ */
function runnerVerdict({ fail, ranSections, expectedSections, declared, executed }) {
  if (ranSections !== expectedSections) return { code: 4, reason: `sections exécutées : ${ranSections}/${expectedSections}` };
  if (declared !== executed) return { code: 4, reason: `tests exécutés : ${executed}/${declared}` };
  return { code: fail ? 1 : 0, reason: fail ? `${fail} test(s) en échec` : 'ok' };
}

const EXPECTED_SECTIONS = 8;
const SUITE_TIMEOUT_MS = Number(process.env.SUITE_TIMEOUT_MS || 120000);
let ranSections = 0;
let suiteDone = false;
const watchdog = setTimeout(() => {
  if (suiteDone) return;
  console.error(`\nERREUR : la suite n'a pas terminé en ${Math.round(SUITE_TIMEOUT_MS / 1000)} s (section en cours : ${ranSections}).`);
  process.exit(2);
}, SUITE_TIMEOUT_MS);
// Une promesse rejetée ou une exception hors test ne doit jamais finir en code 0.
process.on('unhandledRejection', e => { console.error('\nERREUR : promesse rejetée non gérée :', e); process.exit(3); });
process.on('uncaughtException', e => { console.error('\nERREUR : exception non capturée :', e); process.exit(3); });

(async () => {
  console.log('=== 1. Analyse JSON (cards.js) ==='); parserTests(); ranSections++;
  console.log('\n=== 2. Port AnkiConnect ==='); await portTests(); ranSections++;
  console.log('\n=== 3. Intégration AnkiConnect simulé ==='); await integrationTests(); ranSections++;
  console.log('\n=== 4. content.js : bouton et modale ==='); await contentTests(); ranSections++;
  console.log('\n=== 5. Manifeste et hygiène des sources ==='); manifestTests(); ranSections++;
  console.log('\n=== 6. Localisation et remplacement sûr ==='); await replaceTests(); ranSections++;
  console.log('\n=== 7. Popup : interface compacte ==='); await popupTests(); ranSections++;
  console.log('\n=== 8. Mise en forme des cartes (shared.js) ==='); formatTests(); ranSections++;
  const verdict = runnerVerdict({ fail, ranSections, expectedSections: EXPECTED_SECTIONS, declared, executed: pass + fail });
  console.log(`\nRésultat : ${pass} réussis, ${fail} échoués` + (verdict.code ? ` — ${verdict.reason}` : ''));
  suiteDone = true; clearTimeout(watchdog);
  process.exit(verdict.code);
})();
