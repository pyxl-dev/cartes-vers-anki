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
      storage: { local: {
        get: async keys => {
          if (keys == null) return { ...storage };
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {}; for (const k of list) if (k in storage) out[k] = storage[k];
          return out;
        },
        set: async obj => { Object.assign(storage, obj); },
        remove: async keys => { for (const k of (Array.isArray(keys) ? keys : [keys])) delete storage[k]; }
      } }
    },
    importScripts: () => {}
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  load(ctx, 'search.js'); load(ctx, 'similarity.js'); load(ctx, 'background.js');
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
function startMockAnki() {
  const state = { decks: ['Par défaut', 'Cours'], models: ['Basique', 'Basic', 'Cloze', 'Texte à trous'], notes: new Map(), nextId: 5000, actions: [] };
  const fp = n => {
    const f = n.fields || {};
    const key = /(clo|trou)/i.test(n.modelName || '') ? 'cloze' : 'basic';
    return key + ':' + String(Object.values(f)[0] ?? '').toLowerCase();
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
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
          case 'modelFieldNames': out.result = /(clo|trou)/i.test(prm.modelName) ? ['Text', 'Back Extra'] : ['Front', 'Back']; break;
          case 'canAddNotes': { const seen = new Set(); out.result = (prm.notes || []).map(n => { const k = fp(n); if (state.notes.has(k) || seen.has(k)) return false; seen.add(k); return true; }); break; }
          case 'addNote': { const k = fp(prm.note); if (state.notes.has(k)) { out.result = null; break; } const id = ++state.nextId; state.notes.set(k, id); out.result = id; break; }
          case 'findNotes': { const q = String(prm.query || ''); out.result = q.includes('"Cours"') ? [...state.notes.values()] : []; break; }
          case 'notesInfo': out.result = (prm.notes || []).map(id => ({ noteId: id, modelName: 'Basique', tags: ['chatgpt'], fields: { Front: { value: 'Note ' + id, order: 0 }, Back: { value: 'r', order: 1 } } })); break;
          default: out.error = 'unsupported action ' + p.action;
        }
      } catch (e) { out.error = String(e); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

const SENDER = { id: 'test-extension-id', url: 'https://chatgpt.com/' };
function send(listeners, message, sender = SENDER) {
  return new Promise(resolve => { const r = v => resolve(v); listeners[0](message, sender, r); });
}

async function integrationTests() {
  const { server, state, port } = await startMockAnki();
  const { ctx, listeners, storage } = bgContext({ fetchImpl: globalThis.fetch });
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
    const m = sel.match(/^([a-zA-Z#][a-zA-Z0-9-]*)?((?:[.#][\w-]+)*)((?:\[[^\]]+\])*)$/);
    if (!m) return false;
    const [, tag, classes, attrs] = m;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
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

function contentHarness({ assistantBody, userBody, legacy, savedDeck = 'Cours' }, respond) {
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
    console, setTimeout, clearTimeout, Date, JSON, Promise, document: doc,
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() {} },
    // display piloté par l'attribut data-display des fixtures (grille / flex / bloc)
    getComputedStyle: node => ({ display: (node && node._attrs && node._attrs['data-display']) || 'block' }),
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    HTMLElement: class {}, HTMLTextAreaElement: class {},
    chrome: {
      runtime: {
        lastError: null,
        // respond peut renvoyer une promesse : nécessaire pour tester les courses
        sendMessage: (msg, cb) => { const r = respond(msg); if (r && typeof r.then === 'function') r.then(cb); else cb(r); },
        onMessage: { addListener: fn => listeners.push(fn) }
      },
      storage: { local: { get: async () => ({ deck: savedDeck }), set: async () => {} } }
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  load(ctx, 'cards.js');
  load(ctx, 'content.js');
  return { ctx, root, body, listeners, observers, documentListeners };
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
    assert.match(titles[10], /^11\. \[Texte à trous\] Le \{\{c1::GLOOP\}\}/);
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
    assert.match(rowsOf(ov)[1].querySelector('.ankibridge-notice').textContent, /Doublon exact/);
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
      const needle = tm[1].replace(/\\"/g, '"').toLowerCase();
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
  const { ctx, listeners, storage } = bgContext({ fetchImpl: globalThis.fetch });
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
function manifestTests() {
  const mf = JSON.parse(fs.readFileSync(EXT('manifest.json'), 'utf8'));
  t('manifeste MV3', () => assert.equal(mf.manifest_version, 3));
  t('version 1.4.2', () => assert.equal(mf.version, '1.4.2'));
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

const EXPECTED_SECTIONS = 6;
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
  const verdict = runnerVerdict({ fail, ranSections, expectedSections: EXPECTED_SECTIONS, declared, executed: pass + fail });
  console.log(`\nRésultat : ${pass} réussis, ${fail} échoués` + (verdict.code ? ` — ${verdict.reason}` : ''));
  suiteDone = true; clearTimeout(watchdog);
  process.exit(verdict.code);
})();
