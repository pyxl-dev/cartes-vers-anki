# Cartes vers Anki

Extension navigateur (Manifest V3) qui transforme les cartes générées par ChatGPT.com en notes dans **Anki Desktop**, sans copier-coller de JSON, avec contrôle des doublons avant import.

**Entièrement local :** l'extension ne parle qu'à `AnkiConnect` sur la boucle locale (`127.0.0.1`). Aucun serveur distant, aucune clé d'API, aucun compte, aucune télémétrie, aucun quota imposé par l'extension.

---

## Prérequis

1. **Anki Desktop** — <https://apps.ankiweb.net/>
2. **AnkiConnect** (greffon Anki) — dans Anki : `Outils → Greffons → Obtenir des greffons`, code **`2055492159`**, puis quitter et relancer Anki.
3. Un navigateur Chromium : **Brave**, **Chrome** ou **Edge**.

## Installation

1. Télécharger ce dépôt (bouton *Code → Download ZIP*) et le décompresser dans un dossier **permanent**. Ne plus déplacer le dossier `extension/` ensuite.
2. Ouvrir `brave://extensions` (ou `chrome://extensions`).
3. Activer **Mode développeur**.
4. Cliquer **Charger l'extension non empaquetée** et choisir le sous-dossier **`extension/`** (celui qui contient `manifest.json`).
5. Épingler l'extension **Cartes vers Anki**, cliquer sur son icône : la liste des paquets Anki doit apparaître.

## Utilisation

1. **Anki ouvert**, puis ouvrir ChatGPT.com.
2. Joindre ou coller le cours, et demander les cartes sous forme d'**un seul bloc de code JSON** (voir le schéma ci-dessous).
3. Un bouton **« Ajouter N cartes à Anki »** apparaît automatiquement sous la réponse.
4. Cliquer dessus : la fenêtre de vérification liste les cartes, permet de les corriger et de choisir le paquet.
5. Cliquer **« Comparer aux cartes existantes »** : les doublons exacts sont décochés, les formulations proches sont signalées « à vérifier ».
6. Cliquer **« Importer dans Anki »**. Les cartes déjà présentes ne sont jamais réimportées.

**Mode de secours (indépendant du bouton).** Si le bouton d'import n'apparaît pas (par exemple après un changement d'interface de ChatGPT), copier le bloc JSON, ouvrir l'icône de l'extension, coller le JSON dans la zone de texte, puis **1. Vérifier les doublons** → **2. Importer la sélection**. Ce mode fonctionne même quand la détection automatique est cassée.

Le bouton **« Préparer dans ChatGPT »** insère un prompt prêt à l'emploi dans le champ de saisie de ChatGPT (il ne l'envoie pas : le message est relu avant envoi).

## Schéma JSON reconnu

L'extension accepte un objet JSON, un tableau nu, ou un bloc clôturé par ```` ``` ```` / ```` ```json ````.

```json
{
  "cards": [
    { "type": "basic", "front": "Question", "back": "Réponse", "tags": ["medecine"] },
    { "type": "cloze", "text": "Le {{c1::terme}} est ...", "extra": "Précisions", "tags": ["medecine"] }
  ]
}
```

Règles appliquées carte par carte :

| Champ | Règle |
|---|---|
| `type` | facultatif — `"basic"` (défaut) ou `"cloze"`. Sans `type`, une carte contenant `{{c1::` est traitée comme cloze. |
| `front` (ou `question`) | requis pour une carte basic — non vide, 8000 caractères max |
| `back` (ou `answer`) | requis pour une carte basic — non vide, 8000 caractères max |
| `text` | requis pour une carte cloze — doit contenir au moins un `{{c1::…}}` |
| `extra` (ou `back`) | facultatif pour une carte cloze |
| `tags` | facultatif — 8 tags conservés au maximum |

Autres contraintes :

- **1 à 100 cartes par lot.** Au-delà, l'extension demande de découper la demande en lots.
- Le **paquet de destination doit exister** dans Anki (l'extension ne crée pas de paquet).
- Le type de note doit être **Basique / Basic** ou **Texte à trous / Cloze**. L'extension écrit dans les **deux premiers champs** du type de note : tester avec un type très personnalisé avant un usage réel.
- Une carte invalide est refusée avec son numéro, sans bloquer les autres.

### Prompt prêt à l'emploi

> À partir du cours ci-dessous, crée 20 cartes Anki de révision à long terme. Une seule connaissance testée par carte, question sans ambiguïté, réponse précise. N'invente aucune donnée absente du cours. Réponds uniquement par un bloc de code contenant du JSON valide, au format exact : `{"cards":[{"type":"basic","front":"Question","back":"Réponse","tags":["medecine"]},{"type":"cloze","text":"Le {{c1::métoprolol}} est …","extra":"Précision","tags":["medecine"]}]}`. Garde les marqueurs `{{c1::…}}` intacts.

## Doublons

Deux contrôles complémentaires, tous deux exécutés **avant** l'ajout :

- **Doublons exacts** — action `canAddNotes` d'AnkiConnect, portée **collection entière**, plus les répétitions internes au lot. Re-contrôle à l'insertion. Les cartes concernées sont décochées et jamais réimportées.
- **Formulations proches** — comparaison **lexicale locale** (pas d'IA) des questions et réponses dans le paquet choisi et ses sous-paquets, plafonnée à 20 000 notes. L'interface indique explicitement si l'analyse est partielle. Ces cartes sont décochées par précaution et signalées « à vérifier » : deux questions proches peuvent tester deux faits différents.

Aucune carte existante n'est jamais supprimée ni modifiée.

## Port d'AnkiConnect et dépannage

AnkiConnect écoute sur `127.0.0.1:8765` par défaut. Si le port est refusé ou répondu par un autre logiciel, l'extension **essaie automatiquement 8765 puis 8766**, et n'accepte qu'un service qui répond réellement au protocole AnkiConnect (JSON `{result, error}`, action `version`). Un port occupé par un autre logiciel est écarté sans lui envoyer la moindre écriture.

Pour utiliser un autre port :

1. Trouver un port libre : `lsof -nP -iTCP:8766 -sTCP:LISTEN` (aucune sortie = libre).
2. Dans Anki : `Outils → Greffons → AnkiConnect → Config`, régler `webBindPort`, puis **quitter et relancer Anki**.
3. Dans l'extension : saisir le **même port** dans « Port AnkiConnect » et cliquer **Enregistrer le port**. Le bouton **Détection auto** revient à la détection automatique.

Le champ de port reste prioritaire sur la détection automatique dès qu'une valeur y est enregistrée.

Autres points :

- **Anki doit être ouvert** pendant la vérification et l'import.
- Si l'extension refuse l'accès (origine non autorisée), garder Anki ouvert et relancer **Tester Anki / actualiser**.
- Garder `webBindAddress` sur `127.0.0.1` : ne jamais exposer AnkiConnect sur le réseau, et ne jamais régler `webCorsOriginList` à `["*"]`.

## Confidentialité

- L'extension n'envoie **aucune** donnée à un serveur tiers. Ses seules requêtes vont vers `http://127.0.0.1/*` (boucle locale).
- Le texte de vos cours est en revanche **transmis à ChatGPT**, comme n'importe quel message que vous lui envoyez : c'est le fonctionnement normal de ChatGPT.com, pas une action de cette extension.
- L'extension lit la conversation affichée dans l'onglet ChatGPT.com pour y détecter un bloc JSON. Elle ne lit aucune autre page : sa portée est limitée à `chatgpt.com` et `chat.openai.com`.
- Aucune télémétrie, aucun identifiant, aucune clé d'API.
- Éviter les données personnelles (notamment de santé) dans les prompts envoyés à ChatGPT.

## Limites connues

- **100 cartes maximum par import** (découper en lots au-delà).
- Le paquet de destination doit déjà exister ; l'extension ne crée ni paquet ni type de note.
- La détection automatique du bouton dépend de la structure HTML de ChatGPT.com. Elle est vérifiée sur le DOM courant (`[data-dil-source-message-id]` pour le message de l'assistant, `[data-user-message-bubble]` pour le message de l'utilisateur), avec l'ancien sélecteur `[data-message-author-role]` conservé en secours. Si le site change encore, le **mode de secours par collage** reste opérationnel.
- L'import se fait dans un navigateur de bureau (Brave/Chrome/Edge) ; AnkiConnect n'est pas joignable depuis un navigateur mobile.
- Les modèles Anki très personnalisés ne sont pas détectés automatiquement : l'extension utilise les deux premiers champs.

## Tests

```bash
node tests/test.cjs
```

65 tests hors navigateur, sans réseau externe :

- analyse du JSON : lots de 5 / 50 / 100 / 101 / 200 cartes, bloc ```` ```json ````, tableau nu, clé `notes`, cloze valide et invalide, accents, tags, HTML, contenu trop long ;
- port AnkiConnect : validation `1..65535`, identification d'un vrai AnkiConnect, refus d'un JSON étranger / d'une page HTML / d'un objet sans version, ordre de sondage 8765 → 8766, priorité du choix manuel, aucune écriture envoyée pendant la sonde ;
- import réel contre un **faux AnkiConnect** en boucle locale : ajout de 100 cartes, réimport → 0 ajoutée + 100 doublons, doublon interne au lot, cloze, refus au-delà de 100, paquet inconnu, contrôle d'origine des messages ;
- `content.js` avec un DOM simulé : bouton « Ajouter N cartes à Anki » créé dans le bon conteneur, jamais sur le message de l'utilisateur, pas de doublon de bouton après re-balayage, ancien DOM pris en charge, ouverture de la fenêtre, message neutre quand toutes les cartes existent déjà, import envoyé pour des cartes neuves ;
- cohérence du manifeste (version, permissions minimales, aucune URL distante, aucun motif de secret).

**Ce que les tests ne couvrent pas :** le site ChatGPT.com réel (le DOM du test est une reproduction), Anki lui-même (le serveur est simulé), et l'accessibilité avec un lecteur d'écran.

## Structure

```
extension/      extension chargeable (manifest.json à la racine de ce dossier)
  cards.js      analyse et validation du JSON des cartes
  content.js    détection du bloc JSON sur la page + fenêtre de vérification
  background.js appels AnkiConnect (service worker MV3), résolution du port
  search.js     lecture des notes existantes (contexte et recherche)
  similarity.js comparaison lexicale locale (formulations proches)
  popup.html/popup.js  interface : port, préparation du prompt, mode de secours
tests/test.cjs  tests hors navigateur
```

## Licence

MIT — voir [LICENSE](LICENSE).
