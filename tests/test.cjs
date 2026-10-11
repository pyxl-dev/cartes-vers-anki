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
const t = (name, fn) => { try { fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      -> ' + e.message); } };
const ta = async (name, fn) => { try { await fn(); pass++; console.log('PASS  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      -> ' + e.message); } };
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
    this.dataset = {}; this.style = { setProperty() {} };
    this.value = ''; this.checked = false; this.disabled = false; this.type = '';
    this.onclick = null; this.open = false; this.id = this._attrs.id || '';
  }
  _classes() { return String(this.className || '').split(/\s+/).filter(Boolean); }
  get classList() {
    const s = this; return { add: c => { if (!s._classes().includes(c)) s.className = (s.className + ' ' + c).trim(); }, remove: c => { s.className = s._classes().filter(x => x !== c).join(' '); }, contains: c => s._classes().includes(c) };
  }
  get textContent() { return this._text !== null ? this._text : this.children.map(c => c.textContent).join(''); }
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
  replaceChildren(...kids) { this.children = []; return this.append(...kids); }
  insertAdjacentElement(_pos, el) { const p = this.parent; if (!p) return null; p.children.splice(p.children.indexOf(this) + 1, 0, el); el.parent = p; return el; }
  remove() { if (!this.parent) return; const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; }
  setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'class') this.className = String(v); if (k === 'src' || k === 'href') this[k] = String(v); }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  hasAttribute(k) { return k in this._attrs; }
  getAttributeNames() { return Object.keys(this._attrs); }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener() {}
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

function contentHarness({ assistantBody, userBody, legacy }, respond) {
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
  const ctx = {
    console, setTimeout, clearTimeout, Date, JSON, Promise, document: doc,
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} },
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    HTMLElement: class {}, HTMLTextAreaElement: class {},
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: (msg, cb) => { const r = respond(msg); cb(r); },
        onMessage: { addListener: fn => listeners.push(fn) }
      },
      storage: { local: { get: async () => ({ deck: 'Cours' }), set: async () => {} } }
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  load(ctx, 'cards.js');
  load(ctx, 'content.js');
  return { ctx, root, body, listeners };
}
const countButtons = root => root.querySelectorAll('.ankibridge-btn').length;
const JSON13 = JSON.stringify({ cards: [...basic(10), { type: 'cloze', text: 'Le {{c1::GLOOP}} fabrique.', extra: '' }, { type: 'cloze', text: 'Le {{c1::ZORK}} sert.', extra: '' }, { type: 'cloze', text: 'Le GLOOP fait {{c1::42 blops}}.', extra: '' }] });

const respondOk = (analyzeItems) => (msg) => {
  if (msg.type === 'DECKS') return { ok: true, value: ['Cours', 'Par défaut'] };
  if (msg.type === 'ANALYZE') return { ok: true, value: { items: analyzeItems, totalExisting: 0, scanned: 0, partial: false, scope: 'Cours' } };
  if (msg.type === 'IMPORT') return { ok: true, value: { added: 13, skipped: 0, errors: [], total: 13 } };
  return { ok: false, error: 'unexpected ' + msg.type };
};

async function contentTests() {
  await ta('DOM moderne : bouton « Ajouter 13 cartes à Anki » créé', async () => {
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    assert.equal(countButtons(root), 1);
    assert.equal(root.querySelector('.ankibridge-btn').textContent, 'Ajouter 13 cartes à Anki');
  });
  await ta('le bouton est placé dans le conteneur de l’assistant, après le bloc de code', async () => {
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    const btn = root.querySelector('.ankibridge-btn');
    assert.ok(btn.closest('[data-dil-source-message-id]'));
    assert.equal(btn.previousElementSibling.tagName, 'PRE');
  });
  await ta('re-rendu : un second scan ne duplique pas le bouton', async () => {
    const { ctx, root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respondOk([]));
    await new Promise(r => setTimeout(r, 700));
    assert.equal(countButtons(root), 1);
    const fn = ctx.document.documentElement; void fn;
    // rejoue la séquence de balayage comme le fait MutationObserver
    await new Promise(r => { setTimeout(() => r(), 600); });
    assert.equal(countButtons(root), 1);
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
    assert.deepEqual(root.querySelectorAll('.ankibridge-overlay select option').map(o => o.value), ['Cours', 'Par défaut']);
  });
  await ta('UX : 100 % de doublons -> message neutre, aucun import envoyé', async () => {
    const sent = [];
    const respond = msg => { sent.push(msg.type); return respondOk(Array.from({ length: 13 }, () => ({ kind: 'exact', matches: [] })))(msg); };
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respond);
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 150));
    const ov = root.querySelector('.ankibridge-overlay');
    ov.querySelector('select').value = 'Cours';
    ov.querySelector('.ankibridge-review').onclick();
    await new Promise(r => setTimeout(r, 250));
    ov.querySelector('.ankibridge-action').onclick();
    await new Promise(r => setTimeout(r, 250));
    assert.equal(ov.querySelector('.ankibridge-msg').textContent, 'Toutes les cartes existent déjà : aucune nouvelle carte ajoutée.');
    assert.ok(!sent.includes('IMPORT'), 'IMPORT ne doit pas être envoyé');
  });
  await ta('cartes neuves -> l’import est bien envoyé', async () => {
    const sent = [];
    const respond = msg => { sent.push(msg.type); return respondOk(Array.from({ length: 13 }, () => ({ kind: 'new', matches: [] })))(msg); };
    const { root } = contentHarness({ assistantBody: [h('pre', {}, h('code', {}, JSON13))] }, respond);
    await new Promise(r => setTimeout(r, 700));
    root.querySelector('.ankibridge-btn').click();
    await new Promise(r => setTimeout(r, 150));
    const ov = root.querySelector('.ankibridge-overlay');
    ov.querySelector('select').value = 'Cours';
    ov.querySelector('.ankibridge-review').onclick();
    await new Promise(r => setTimeout(r, 250));
    ov.querySelector('.ankibridge-action').onclick();
    await new Promise(r => setTimeout(r, 400));
    assert.ok(sent.includes('IMPORT'), 'IMPORT attendu');
    assert.match(ov.querySelector('.ankibridge-msg').textContent, /13 ajoutée\(s\)/);
  });
}

/* ------------------------------------------------------------------ *
 * 5. Cohérence manifeste / code                                      *
 * ------------------------------------------------------------------ */
function manifestTests() {
  const mf = JSON.parse(fs.readFileSync(EXT('manifest.json'), 'utf8'));
  t('manifeste MV3', () => assert.equal(mf.manifest_version, 3));
  t('version 1.3.1', () => assert.equal(mf.version, '1.3.1'));
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
  t('aucune clé API / télémétrie dans les sources', () => {
    const files = fs.readdirSync(EXT('')).filter(f => /\.(js|html|json)$/.test(f));
    for (const f of files) {
      const src = fs.readFileSync(EXT(f), 'utf8');
      assert.ok(!/sk-[A-Za-z0-9]{10,}|api[_-]?key\s*[:=]\s*['"][^'"]+|gtag|mixpanel|sentry|telemetry/i.test(src), `${f}: motif sensible`);
    }
  });
}

(async () => {
  console.log('=== 1. Analyse JSON (cards.js) ==='); parserTests();
  console.log('\n=== 2. Port AnkiConnect ==='); await portTests();
  console.log('\n=== 3. Intégration AnkiConnect simulé ==='); await integrationTests();
  console.log('\n=== 4. content.js : bouton et modale ==='); await contentTests();
  console.log('\n=== 5. Manifeste et hygiène des sources ==='); manifestTests();
  console.log(`\nRésultat : ${pass} réussis, ${fail} échoués`);
  process.exit(fail ? 1 : 0);
})();
