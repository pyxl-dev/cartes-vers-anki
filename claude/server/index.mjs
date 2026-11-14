#!/usr/bin/env node
/* Serveur MCP « Cartes vers Anki » pour Claude Desktop (stdio).
   Rien ne doit être écrit sur stdout en dehors du protocole MCP : les journaux vont sur stderr. */
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import * as A from './anki.mjs';

console.log = console.info = console.warn = console.debug = (...a) => console.error(...a);

const VERSION = '0.1.0';

const INSTRUCTIONS = `Cartes vers Anki relie cette conversation à Anki Desktop sur l'ordinateur de l'utilisateur (via le greffon AnkiConnect).
Déroulé pour créer des cartes :
1. Rédige les cartes à partir du contenu fourni, sans inventer de fait absent du cours. Une connaissance par carte.
2. Montre-les à l'utilisateur dans la conversation sous une forme lisible (pas en JSON), numérotées.
3. Demande dans quel paquet les ranger (list_decks pour proposer les paquets existants).
4. Appelle check_cards et présente le résultat : cartes déjà présentes (exact, ne seront pas ajoutées) et formulations proches (similar, à faire trancher par l'utilisateur).
5. N'appelle add_cards qu'après l'accord explicite de l'utilisateur, avec les seules cartes qu'il a gardées.
Mise en forme permise dans les cartes, et seulement celle-ci : **gras**, *italique*, \`code\`, listes avec « - » ou « 1. » (une ligne par élément), exposant ^texte^, indice ~texte~. Pas de HTML, pas de lien, pas d'image.
Carte « basic » : front = question précise, back = l'essentiel en une phrase puis, si le cours le justifie, une explication structurée.
Carte « cloze » : text contient {{c1::terme}} (le trou ne contient que le terme à retenir), extra pour les précisions ; {{c2::…}} pour un second trou révisé séparément.
Ces outils n'effacent et ne modifient jamais une note existante. Si Anki ne répond pas, explique à l'utilisateur d'ouvrir Anki Desktop.`;

const card = z.object({
  type: z.enum(['basic', 'cloze']).describe('basic : question/réponse. cloze : texte à trous.'),
  front: z.string().optional().describe('basic : la question.'),
  back: z.string().optional().describe('basic : la réponse.'),
  text: z.string().optional().describe('cloze : la phrase avec {{c1::…}}.'),
  extra: z.string().optional().describe('cloze : précisions affichées au verso.'),
  tags: z.array(z.string()).max(8).optional().describe('1 ou 2 mots-clés du thème.')
});
const cards = z.array(card).min(1).max(100);

const server = new McpServer({name: 'cartes-vers-anki', version: VERSION}, {instructions: INSTRUCTIONS});

function reply(fn) {
  return async (args) => {
    try {
      const data = await fn(args || {});
      return {content: [{type: 'text', text: JSON.stringify(data, null, 2)}]};
    } catch (e) {
      const msg = e instanceof A.AnkiError ? e.message : `Erreur inattendue : ${e?.message || e}`;
      return {isError: true, content: [{type: 'text', text: msg}]};
    }
  };
}

server.registerTool('anki_status', {
  title: 'Vérifier la connexion à Anki',
  description: 'Vérifie qu’Anki Desktop est ouvert et que AnkiConnect répond. À appeler en cas de doute ou d’erreur de connexion.',
  annotations: {readOnlyHint: true, openWorldHint: false}
}, reply(async () => {
  const {port, version} = await A.resolvePort();
  const decks = await A.anki('deckNames');
  return {connected: true, port, ankiconnect_version: version, decks: decks.length};
}));

server.registerTool('list_decks', {
  title: 'Lister les paquets Anki',
  description: 'Liste les paquets Anki de l’utilisateur avec leur nombre de notes.',
  annotations: {readOnlyHint: true, openWorldHint: false}
}, reply(() => A.listDecks()));

server.registerTool('check_cards', {
  title: 'Vérifier les doublons',
  description: 'Lecture seule. Compare des cartes à la collection avant ajout. status "exact" : déjà dans Anki (même recto), ne sera pas ajoutée. "similar" : formulation proche d’une note du paquet, à faire juger par l’utilisateur. "new" : rien de proche.',
  inputSchema: {deck: z.string().min(1).describe('Nom exact du paquet visé (sous-paquet : "Parent::Enfant").'), cards},
  annotations: {readOnlyHint: true, openWorldHint: false}
}, reply(({deck, cards}) => A.checkCards(deck, cards)));

server.registerTool('add_cards', {
  title: 'Ajouter les cartes à Anki',
  description: 'Ajoute des cartes dans un paquet Anki. Seulement après accord explicite de l’utilisateur sur les cartes et le paquet. Les doublons exacts sont ignorés. Chaque carte reçoit l’étiquette "claude".',
  inputSchema: {
    deck: z.string().min(1).describe('Nom du paquet.'),
    cards,
    create_deck_if_missing: z.boolean().optional().describe('Créer le paquet s’il n’existe pas (seulement si l’utilisateur l’a demandé).')
  },
  annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false}
}, reply(({deck, cards, create_deck_if_missing}) => A.addCards(deck, cards, !!create_deck_if_missing)));

server.registerTool('create_deck', {
  title: 'Créer un paquet',
  description: 'Crée un paquet Anki (ou sous-paquet avec "Parent::Enfant"). Ne recrée jamais un paquet existant.',
  inputSchema: {name: z.string().min(1)},
  annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false}
}, reply(({name}) => A.createDeck(name)));

server.registerTool('search_notes', {
  title: 'Chercher dans Anki',
  description: 'Lecture seule. Cherche des notes existantes par paquet et/ou texte, pour savoir ce qui est déjà couvert avant de créer des cartes.',
  inputSchema: {
    deck: z.string().optional().describe('Paquet où chercher (sous-paquets inclus).'),
    text: z.string().optional().describe('Texte à chercher dans les champs.'),
    limit: z.number().int().min(1).max(50).optional()
  },
  annotations: {readOnlyHint: true, openWorldHint: false}
}, reply(args => A.searchNotes(args)));

server.registerPrompt('cartes_depuis_cours', {
  title: 'Créer des cartes Anki depuis un cours',
  description: 'Transforme le cours joint ou collé en cartes Anki, vérifiées puis ajoutées après ton accord.',
  argsSchema: {nombre: z.string().optional().describe('Nombre de cartes (20 par défaut).')}
}, ({nombre}) => {
  const n = /^\d{1,3}$/.test(String(nombre || '').trim()) ? Number(nombre) : 20;
  return {messages: [{role: 'user', content: {type: 'text', text:
`À partir du cours, des notes ou du document que je fournis dans cette conversation, crée ${n} cartes Anki pour mes révisions. Si je n'ai encore rien fourni, demande-le-moi d'abord.

Une connaissance par carte, question précise et non ambiguë, priorité aux notions importantes. Respecte strictement les faits, chiffres, unités et noms du cours ; n'invente rien. Choisis carte classique ou texte à trous selon ce qui convient.

Montre-moi les cartes numérotées, demande-moi dans quel paquet Anki les ranger, vérifie les doublons avec check_cards, puis attends mon accord avant de les ajouter.`}}]};
});

await server.connect(new StdioServerTransport());
console.error(`cartes-vers-anki ${VERSION} prêt`);
