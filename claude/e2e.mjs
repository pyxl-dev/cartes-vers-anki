/* Parcours réel contre un Anki de TEST, jamais la collection de quelqu'un.
   Lancer un Anki jetable :  open -n -a Anki --args -b /chemin/jetable   (AnkiConnect copié dans addons21)
   puis :                    node e2e.mjs <port>
   Le serveur est lancé comme Claude Desktop le fait : sous-processus stdio. */
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const port = process.argv[2];
if (!/^\d+$/.test(port || '')) { console.error('usage : node e2e.mjs <port du Anki de test>'); process.exit(2); }
const serverDir = process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'server');

const transport = new StdioClientTransport({command: process.execPath, args: [path.join(serverDir, 'index.mjs')], env: {...process.env, ANKI_PORT: port}, stderr: 'pipe'});
const client = new Client({name: 'e2e', version: '1'});
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({name, arguments: args});
  const text = r.content[0].text;
  return {error: !!r.isError, text, data: r.isError ? null : JSON.parse(text)};
};
const run = Date.now();
const deck = `E2E::Cardio ${run}`;
const lot = [
  {type: 'basic', front: `Quel est le rôle du **nœud sinusal** (essai ${run}) ?`, back: 'Pacemaker physiologique du cœur.\n\n- fréquence 60 à 100 /min', tags: ['cardio']},
  {type: 'cloze', text: `Le potassium sérique normal (essai ${run}) est de {{c1::3,5 à 5}} mmol/L.`, extra: 'K^+^ ; hypokaliémie si < 3,5'},
  {type: 'basic', front: `Quel est le rôle du **nœud sinusal** (essai ${run}) ?`, back: 'Répétée dans le lot.'},
  {type: 'cloze', text: 'Pas de trou ici.'}
];
const steps = [];
const step = (n, v) => { steps.push(n); console.error('ok', n, v ?? ''); };

const {tools} = await client.listTools();
assert.deepEqual(tools.map(t => t.name).sort(), ['add_cards', 'anki_status', 'check_cards', 'create_deck', 'list_decks', 'search_notes']);
step('tools/list', tools.length);
const {prompts} = await client.listPrompts();
assert.equal(prompts[0].name, 'cartes_depuis_cours'); step('prompts/list');

const st = await call('anki_status'); assert.equal(st.data.connected, true); step('anki_status', st.data.port);

const refused = await call('add_cards', {deck, cards: lot.slice(0, 1)});
assert.equal(refused.error, true); assert.match(refused.text, /n’existe pas/); step('add_cards refuse un paquet absent');

const c1 = await call('check_cards', {deck, cards: lot});
assert.deepEqual(c1.data.summary, {new: 2, similar: 0, exact: 1, invalid: 1}); step('check_cards avant ajout', JSON.stringify(c1.data.summary));

const a1 = await call('add_cards', {deck, cards: lot, create_deck_if_missing: true});
assert.equal(a1.data.deck_created, true); assert.equal(a1.data.added.length, 2);
assert.deepEqual(a1.data.skipped_duplicates, [3]); assert.equal(a1.data.errors.length, 1); step('add_cards', JSON.stringify({added: a1.data.added.length, skipped: a1.data.skipped_duplicates, errors: a1.data.errors}));

const a2 = await call('add_cards', {deck, cards: lot.slice(0, 2)});
assert.equal(a2.data.added.length, 0); assert.deepEqual(a2.data.skipped_duplicates, [1, 2]); step('re-ajout ignoré (doublons exacts)');

const c2 = await call('check_cards', {deck, cards: [lot[0], {type: 'basic', front: `Rôle du nœud sinusal dans le cœur, essai ${run} ?`, back: 'x'}]});
assert.equal(c2.data.cards[0].status, 'exact'); assert.equal(c2.data.cards[0].existing[0].deck, deck);
assert.equal(c2.data.cards[1].status, 'similar'); step('check_cards après ajout : exact localisé + similar', c2.data.cards[1].similar[0].score);

const s = await call('search_notes', {deck, text: 'potassium'});
assert.equal(s.data.total, 1); assert.match(s.data.notes[0].fields[0].text, /3,5 à 5/); step('search_notes');

const raw = await call('search_notes', {deck});
const html = await fetch(`http://127.0.0.1:${port}`, {method: 'POST', body: JSON.stringify({action: 'notesInfo', version: 6, params: {notes: [a1.data.added[0].note_id]}})}).then(r => r.json());
assert.match(html.result[0].fields[Object.keys(html.result[0].fields)[0]].value, /<b>nœud sinusal<\/b>/);
assert.ok(html.result[0].tags.includes('claude') && html.result[0].tags.includes('cardio')); step('mise en forme et étiquettes dans Anki', raw.data.total);

const decks = await call('list_decks'); assert.ok(decks.data.some(d => d.name === deck && d.notes === 2)); step('list_decks');
const cd = await call('create_deck', {name: deck}); assert.equal(cd.data.created, false); step('create_deck ne recrée pas');

await client.close();
console.error(`\n${steps.length} étapes réussies`);
