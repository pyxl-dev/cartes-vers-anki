/* Accès à Anki Desktop via AnkiConnect, en local uniquement (127.0.0.1).
   Reprend les règles de l'extension (extension/background.js) : mêmes types de
   notes, même conversion de mise en forme, mêmes contrôles de doublons.
   Aucune action qui supprime ou modifie une note existante n'est exposée. */
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Dans le paquet .mcpb, les modules partagés sont copiés dans server/lib par build.mjs.
// Dans le dépôt, on lit directement ceux de l'extension : une seule source de vérité.
const libDir = fs.existsSync(path.join(here, 'lib', 'shared.js')) ? path.join(here, 'lib') : path.join(here, '..', '..', 'extension');
for (const f of ['shared.js', 'search.js', 'similarity.js', 'cards.js']) require(path.join(libDir, f));
const {AnkiShared, AnkiSearch, AnkiSimilarity, AnkiCards} = globalThis;

const PROBE_PORTS = [8765, 8766];
const PROBE_TIMEOUT_MS = 1500;
const TIMEOUT_MS = 15000;
const SCAN_BATCH = 200;
const MAX_SIMILARITY_SCAN = 20000;
const MAX_LOCATE_CANDIDATES = 60;
export const TAG = 'claude';

export class AnkiError extends Error {}

function configuredPort() {
  const raw = String(process.env.ANKI_PORT ?? '').trim();
  if (!raw || raw.toLowerCase() === 'auto' || raw.includes('${')) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AnkiError(`Port AnkiConnect invalide dans les réglages : « ${raw} ».`);
  return port;
}

async function post(port, action, params, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({action, version: 6, params: params || {}}), signal: controller.signal
    });
    if (!res.ok) throw new AnkiError(`AnkiConnect a répondu HTTP ${res.status}.`);
    const body = await res.json();
    if (!body || typeof body !== 'object' || !('result' in body) || !('error' in body)) throw new AnkiError('Le service local ne répond pas comme AnkiConnect.');
    if (body.error) throw new AnkiError(String(body.error));
    return body.result;
  } finally { clearTimeout(timer); }
}

const NOT_RUNNING = 'Anki ne répond pas. Ouvre Anki Desktop (il doit rester ouvert pendant l’ajout) et vérifie que le greffon AnkiConnect est installé : dans Anki, Outils > Greffons > Obtenir des greffons, code 2055492159, puis redémarre Anki.';

let currentPort = null;
export async function resolvePort() {
  const fixed = configuredPort();
  const candidates = fixed ? [fixed] : (currentPort ? [currentPort, ...PROBE_PORTS.filter(p => p !== currentPort)] : PROBE_PORTS);
  for (const port of candidates) {
    try {
      const v = await post(port, 'version', {}, PROBE_TIMEOUT_MS);
      if (typeof v === 'number') { currentPort = port; return {port, version: v}; }
    } catch { /* port suivant */ }
  }
  currentPort = null;
  throw new AnkiError(fixed ? `${NOT_RUNNING} (port réglé : ${fixed})` : NOT_RUNNING);
}

export async function anki(action, params) {
  if (!currentPort) await resolvePort();
  try { return await post(currentPort, action, params, TIMEOUT_MS); }
  catch (e) {
    if (e instanceof AnkiError) throw e;
    currentPort = null; // Anki fermé entre-temps : on resonde une fois.
    await resolvePort();
    return post(currentPort, action, params, TIMEOUT_MS);
  }
}

const fieldHtml = t => AnkiShared.toAnkiHtml(t);
const normalizeField = t => AnkiShared.htmlToText(t).replace(/\s+/g, ' ').trim();
function quotedQuery(v) {
  const c = String(v ?? '').trim().replace(/[\r\n]/g, ' ').slice(0, 150);
  return '"' + c.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}
function quotedText(v) {
  const c = String(v ?? '').trim().replace(/[\r\n]/g, ' ').slice(0, 150);
  return '"' + c.replace(/[\\"*_:]/g, '\\$&') + '"';
}
function orderedFields(info) {
  return Object.entries(info?.fields || {})
    .map(([name, v]) => ({name, order: Number(v?.order ?? 0), text: String(v?.value ?? '')}))
    .sort((a, b) => a.order - b.order);
}

async function findModel(type, available) {
  const patterns = type === 'cloze'
    ? [/^cloze$/i, /texte.*trou/i, /cloze/i]
    : [/^basic$/i, /^basique$/i, /^simple$/i, /basic/i, /basique/i];
  let model = null;
  for (const p of patterns) { model = available.find(x => p.test(x)); if (model) break; }
  if (!model) throw new AnkiError(type === 'cloze'
    ? 'Type de note « Texte à trous » (Cloze) introuvable dans Anki.'
    : 'Type de note « Basique » (Basic) introuvable dans Anki.');
  const fields = await anki('modelFieldNames', {modelName: model});
  if (!Array.isArray(fields) || fields.length < 2) throw new AnkiError(`Le type de note ${model} doit avoir au moins 2 champs.`);
  return {model, fields};
}

/* Cartes reçues de Claude → cartes normalisées. Une carte invalide est écartée
   avec sa raison, sans bloquer les autres. */
export function normalizeCards(cards) {
  if (!Array.isArray(cards) || !cards.length) throw new AnkiError('Aucune carte reçue.');
  if (cards.length > AnkiCards.MAX_CARDS) throw new AnkiError(`Maximum ${AnkiCards.MAX_CARDS} cartes par appel : découpe en plusieurs lots.`);
  const parsed = AnkiCards.parse(JSON.stringify({cards}));
  return parsed;
}

async function notesFor(deck, cards) {
  const models = await anki('modelNames');
  const map = {};
  for (const t of new Set(cards.map(c => c.type))) map[t] = await findModel(t, models);
  return cards.map(c => {
    const {model, fields} = map[c.type];
    const f = Object.fromEntries(fields.map(n => [n, '']));
    f[fields[0]] = fieldHtml(c.type === 'cloze' ? c.text : c.front);
    f[fields[1]] = fieldHtml(c.type === 'cloze' ? c.extra : c.back);
    const tags = [...new Set([TAG, ...c.tags].map(AnkiShared.normalizeTag).filter(Boolean))];
    return {deckName: deck, modelName: model, fields: f, tags,
      options: {allowDuplicate: false, duplicateScope: 'collection', duplicateScopeOptions: {checkAllModels: true}}};
  });
}

export async function listDecks() {
  const names = await anki('deckNames');
  const out = [];
  for (const name of names) {
    const ids = await anki('findNotes', {query: 'deck:' + quotedQuery(name)});
    out.push({name, notes: Array.isArray(ids) ? ids.length : 0});
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

async function deckNotes(deck) {
  const ids = await anki('findNotes', {query: 'deck:' + quotedQuery(deck)});
  const capped = ids.slice(0, MAX_SIMILARITY_SCAN);
  const notes = [];
  for (let i = 0; i < capped.length; i += SCAN_BATCH) {
    const info = await anki('notesInfo', {notes: capped.slice(i, i + SCAN_BATCH)});
    for (const item of info || []) notes.push(AnkiSearch.sanitizeResult(item));
  }
  return {notes, partial: ids.length > MAX_SIMILARITY_SCAN};
}

// Où se trouve un doublon exact (même premier champ) ? Rien d'heuristique ici.
async function locateExact(firstHtml) {
  const plain = normalizeField(firstHtml);
  const term = String(firstHtml).split(/<[^>]*>/).map(normalizeField).reduce((a, b) => b.length > a.length ? b : a, '') || plain;
  const ids = await anki('findNotes', {query: quotedText(term)});
  if (!ids.length || ids.length > MAX_LOCATE_CANDIDATES) return [];
  const infos = await anki('notesInfo', {notes: ids});
  const certain = infos.filter(i => normalizeField(orderedFields(i)[0]?.text || '') === plain);
  const cardIds = certain.flatMap(i => i.cards || []);
  const cards = cardIds.length ? await anki('cardsInfo', {cards: cardIds.slice(0, 200)}) : [];
  return certain.map(i => ({
    id: Number(i.noteId),
    deck: [...new Set(cards.filter(c => c.note === i.noteId).map(c => c.deckName))].join(', '),
    back: normalizeField(orderedFields(i)[1]?.text || '').slice(0, 200)
  }));
}

/* Vérification avant ajout, en lecture seule.
   exact   : Anki refusera la carte (même premier champ déjà dans la collection, ou répété dans le lot).
   similar : formulation proche d'une note du paquet (heuristique lexicale, à faire juger par l'utilisateur).
   new     : rien de proche trouvé. */
export async function checkCards(deck, rawCards) {
  const {cards, rejected} = normalizeCards(rawCards);
  const decks = await anki('deckNames');
  const deckExists = decks.includes(deck);
  // canAddNotes répond « non » pour un paquet absent : le contrôle de doublon porte
  // sur toute la collection, on le fait donc avec un paquet existant.
  const notes = cards.length ? await notesFor(deckExists ? deck : decks[0], cards) : [];
  const canAdd = notes.length ? await anki('canAddNotes', {notes}) : [];
  const index = deckExists ? await deckNotes(deck) : {notes: [], partial: false};
  const base = AnkiSimilarity.analyze(cards, index.notes, canAdd);
  const results = [];
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i];
    const r = {card: i + 1, status: base[i].kind, front: c.type === 'cloze' ? c.text : c.front};
    if (r.status === 'exact') {
      const located = canAdd[i] === false ? await locateExact(notes[i].fields[Object.keys(notes[i].fields)[0]]) : [];
      r.existing = located;
      if (canAdd[i] !== false) r.reason = 'répétée dans ce lot';
    } else if (r.status === 'similar') {
      r.similar = base[i].matches;
    }
    results.push(r);
  }
  const count = k => results.filter(r => r.status === k).length;
  return {
    deck, deck_exists: deckExists, similarity_scan_partial: index.partial,
    summary: {new: count('new'), similar: count('similar'), exact: count('exact'), invalid: rejected.length},
    cards: results,
    invalid: rejected
  };
}

/* Ajout groupé. Les doublons exacts sont toujours ignorés (Anki les refuse).
   Une erreur sur une carte n'empêche pas les autres. */
export async function addCards(deck, rawCards, createIfMissing) {
  const {cards, rejected} = normalizeCards(rawCards);
  let created = false;
  const decks = await anki('deckNames');
  let target = decks.find(d => AnkiShared.sameDeck(d, deck));
  if (!target) {
    if (!createIfMissing) throw new AnkiError(`Le paquet « ${deck} » n’existe pas. Demande à l’utilisateur s’il faut le créer, puis rappelle avec create_deck_if_missing.`);
    target = (await createDeck(deck)).deck;
    created = true;
  }
  const result = {deck: target, deck_created: created, added: [], skipped_duplicates: [], errors: rejected.map(r => `${r.reason}`)};
  if (!cards.length) return result;
  const notes = await notesFor(target, cards);
  const seen = new Set();
  const keep = [];
  notes.forEach((n, i) => {
    const key = normalizeField(Object.values(n.fields)[0]).toLowerCase();
    if (seen.has(key)) result.skipped_duplicates.push(i + 1); else { seen.add(key); keep.push(i); }
  });
  const canAdd = await anki('canAddNotes', {notes: keep.map(i => notes[i])});
  const toAdd = keep.filter((_, k) => canAdd[k]);
  keep.filter((_, k) => !canAdd[k]).forEach(i => result.skipped_duplicates.push(i + 1));
  if (toAdd.length) {
    const raw = await anki('multi', {actions: toAdd.map(i => ({action: 'addNote', version: 6, params: {note: notes[i]}}))});
    raw.forEach((entry, k) => {
      const i = toAdd[k];
      const isWrapped = entry && typeof entry === 'object' && 'error' in entry;
      const error = isWrapped ? entry.error : null;
      const id = isWrapped ? entry.result : entry;
      if (error || id == null) result.errors.push(`Carte ${i + 1} : ${error || 'refusée par Anki'}`);
      else result.added.push({card: i + 1, note_id: id});
    });
  }
  result.skipped_duplicates.sort((a, b) => a - b);
  return result;
}

export async function createDeck(rawName) {
  const check = AnkiShared.validateDeckName(rawName);
  if (!check.ok) throw new AnkiError(check.error);
  const decks = await anki('deckNames');
  const existing = decks.find(d => AnkiShared.sameDeck(d, check.name));
  if (existing) return {deck: existing, created: false};
  await anki('createDeck', {deck: check.name});
  const after = await anki('deckNames');
  const made = after.find(d => AnkiShared.sameDeck(d, check.name));
  if (!made) throw new AnkiError('Anki n’a pas confirmé la création du paquet.');
  return {deck: made, created: true};
}

export async function searchNotes({deck, text, limit = 20}) {
  const t = String(text ?? '').trim();
  if (!deck && t.length < 2) throw new AnkiError('Indique un paquet ou au moins 2 caractères à chercher.');
  if (deck) {
    const decks = await anki('deckNames');
    if (!decks.includes(deck)) throw new AnkiError(`Paquet « ${deck} » introuvable.`);
  }
  const query = ((deck ? 'deck:' + quotedQuery(deck) + ' ' : '') + (t ? quotedQuery(t) : '')).trim();
  const ids = await anki('findNotes', {query});
  const page = ids.slice(0, Math.min(Math.max(1, limit), 50));
  const info = page.length ? await anki('notesInfo', {notes: page}) : [];
  return {total: ids.length, shown: info.length, notes: info.map(AnkiSearch.sanitizeResult)};
}
