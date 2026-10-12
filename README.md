# Cartes vers Anki

Extension navigateur (Manifest V3) qui transforme les cartes générées par ChatGPT.com en notes dans **Anki Desktop**, sans copier-coller de JSON, avec contrôle des doublons avant import.

**Entièrement local :** l'extension ne parle qu'à `AnkiConnect` sur la boucle locale (`127.0.0.1`). Aucun serveur distant, aucune clé d'API, aucun compte, aucune télémétrie, aucun quota imposé par l'extension.

---

## Prérequis

1. **Anki Desktop** — <https://apps.ankiweb.net/>
2. **AnkiConnect** (greffon Anki) — dans Anki : `Outils → Greffons → Obtenir des greffons`, code **`2055492159`**, puis quitter et relancer Anki.
3. Un navigateur Chromium : **Brave**, **Chrome** ou **Edge**.

## Installation rapide sur macOS (kit bêta)

Pour une installation sans Terminal, le dossier **`macos/`** contient deux
fichiers à double-cliquer :

1. **`Installer Cartes vers Anki.command`** — à lancer **une fois**. Il
   télécharge une copie permanente de l'extension dans
   `~/Applications/Cartes vers Anki Beta`, affiche les trois clics à faire dans
   Brave, et pose un raccourci **Mettre à jour Cartes vers Anki** sur le Bureau.
2. **`Mettre à jour Cartes vers Anki.command`** — à relancer ensuite pour
   récupérer les nouvelles versions, sans rien retaper.

Le kit ne touche ni à Anki, ni aux cartes, ni à l'historique de révision, et ne
parle jamais à AnkiConnect : il ne fait que télécharger le dépôt officiel.
La mise à jour se limite à `git fetch` puis `git merge --ff-only` — jamais de
remise à zéro, jamais d'écrasement, jamais de changement de branche.

Détails, dépannage et avertissement macOS : **[macos/LISEZ-MOI.md](macos/LISEZ-MOI.md)**.

> **Fichiers téléchargés en ZIP.** Une archive *Code → Download ZIP* ne conserve
> pas le droit d'exécution : le double-clic ouvre alors le fichier dans un
> éditeur de texte au lieu de le lancer. Le geste à faire, une seule fois :
> **clic droit sur le fichier → *Ouvrir avec* → Terminal**. La suite s'enchaîne
> normalement, et le raccourci du Bureau fonctionne ensuite par double-clic.
> Un `git clone` conserve ce droit : dans ce cas le double-clic suffit
> directement.
>
> **Premier lancement.** macOS peut afficher un avertissement de développeur non
> identifié : clic droit sur le fichier → **Ouvrir** → **Ouvrir**. Aucun mot de
> passe n'est demandé, aucun `sudo`, aucune protection désactivée.

## Installation manuelle

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
5. La **comparaison se lance automatiquement** à l'ouverture (sur le dernier paquet utilisé) : les doublons exacts sont décochés, les formulations proches sont signalées « à vérifier ».
6. Changer de paquet dans la liste **relance la comparaison automatiquement** ; les conclusions du paquet précédent sont abandonnées et les cartes remises à l'état initial. Le bouton **« Relancer la comparaison »** reste disponible en secours.
7. Cliquer **« Importer dans Anki »**. Les cartes déjà présentes ne sont jamais réimportées.

Le paquet de destination se **recherche** : taper tout ou partie du nom (la casse, les accents et les ligatures sont ignorés — `coeur` trouve `cœur`). Les résultats sont affichés par niveaux (`Cardiologie › Item 221 › Sous-item`) alors que la valeur transmise reste le nom complet Anki `Parent::Enfant`. Un paquet parent et ses sous-paquets se choisissent dans la même liste, et l'analyse porte sur le paquet choisi **et ses sous-paquets**. Le sélecteur se pilote au clavier (flèches puis Entrée) ; taper ne relance pas la comparaison, seule une **sélection** le fait.

**Sélection des cartes.** Chaque carte se coche ou se décoche individuellement ; deux boutons font **« Tout sélectionner (cartes nouvelles) »** et **« Tout désélectionner »**, et un compteur indique en permanence le nombre de cartes retenues. Après analyse, seules les cartes nouvelles sont cochées : les doublons exacts sont décochés et non réimportables, les formulations proches sont décochées par précaution mais restent réactivables en connaissance de cause.

## Doublons localisés et remplacement

Pour chaque doublon exact, l'extension indique **où la note est rangée** : identifiant, paquet réel (y compris dans une autre spécialité, résolu via `cardsInfo`), modèle et contenu. S'il existe **plusieurs** notes identiques, elles sont toutes listées et aucun remplacement n'est proposé — l'extension ne choisit jamais à votre place.

**Remplacer les notes existantes** est une action distincte de l'import, jamais automatique :

- proposée uniquement pour une note **certaine** (même premier champ, **même modèle**, match unique dans la collection) ; une ressemblance lexicale ne suffit jamais ;
- chaque remplacement est **sélectionné explicitement** (aucun par défaut), avec un aperçu avant → après des seuls champs qui changent ;
- une **confirmation** rappelle le nombre de notes, le paquet d'origine et le fait que le contenu actuel sera écrasé ; **Annuler n'écrit rien** ;
- l'écriture utilise `updateNoteFields` : l'**identifiant de note, le paquet, le planning de révision et les tags sont conservés**. Aucune suppression, aucun déplacement, aucune modification de tag ;
- la note est **relue juste avant l'écriture** : si le premier champ, le second champ, le modèle, le paquet ou l'horodatage `mod` ont changé depuis l'analyse, le remplacement est refusé ;
- pour un texte à trous, si le nombre d'indices `{{c1}}`/`{{c2}}` change, le remplacement est refusé (cela modifierait le nombre de cartes et donc le planning).

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

Changer de paquet relance la comparaison : un import ne peut jamais s'appuyer sur les conclusions d'un autre paquet ni sur une analyse devenue obsolète (résultat périmé ignoré, import désactivé tant que la comparaison en cours n'a pas abouti).

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
node tests/test.cjs          # extension : 115 tests
bash tests/mac-beta-setup.sh # kit macOS : 42 tests, dans un bac à sable jetable
```

115 tests hors navigateur, sans réseau externe :

- analyse du JSON : lots de 5 / 50 / 100 / 101 / 200 cartes, bloc ```` ```json ````, tableau nu, clé `notes`, cloze valide et invalide, accents, tags, HTML, contenu trop long ;
- port AnkiConnect : validation `1..65535`, identification d'un vrai AnkiConnect, refus d'un JSON étranger / d'une page HTML / d'un objet sans version, ordre de sondage 8765 → 8766, priorité du choix manuel, aucune écriture envoyée pendant la sonde ;
- import réel contre un **faux AnkiConnect** en boucle locale : ajout de 100 cartes, réimport → 0 ajoutée + 100 doublons, doublon interne au lot, cloze, refus au-delà de 100, paquet inconnu, contrôle d'origine des messages ;
- `content.js` avec un DOM simulé : bouton « Ajouter N cartes à Anki » créé dans le bon conteneur, jamais sur le message de l'utilisateur, pas de doublon de bouton après re-balayage, ancien DOM pris en charge, ouverture de la fenêtre, message neutre quand toutes les cartes existent déjà, import envoyé pour des cartes neuves ;
- cohérence du manifeste (version, permissions minimales, aucune URL distante, aucun motif de secret).

**Ce que les tests ne couvrent pas :** le site ChatGPT.com réel (le DOM du test est une reproduction), Anki lui-même (le serveur est simulé), et l'accessibilité avec un lecteur d'écran.

Le kit macOS est testé séparément, dans un bac à sable jetable : `HOME` temporaire, dépôt Git local, Bureau temporaire. Le vrai dossier personnel n'est jamais écrit et aucun raccourci réel n'est créé. Les cas couverts : première installation, réinstallation idempotente, mise à jour vers une nouvelle version, « déjà à jour », modifications locales refusées, origine étrangère refusée, mauvaise branche refusée, chemins contenant des espaces, absence de `git`, syntaxe et droit d'exécution, et absence de tout appel à Anki ou à AnkiConnect.

## Structure

```
extension/      extension chargeable (manifest.json à la racine de ce dossier)
  cards.js      analyse et validation du JSON des cartes
  content.js    détection du bloc JSON sur la page + fenêtre de vérification
  background.js appels AnkiConnect (service worker MV3), résolution du port
  search.js     lecture des notes existantes (contexte et recherche)
  similarity.js comparaison lexicale locale (formulations proches)
  popup.html/popup.js  interface : port, préparation du prompt, mode de secours
macos/          kit bêta : installer et mettre à jour par double-clic
  Installer Cartes vers Anki.command
  Mettre à jour Cartes vers Anki.command
  LISEZ-MOI.md  mode d'emploi et dépannage
tests/test.cjs  tests hors navigateur de l'extension
tests/mac-beta-setup.sh  tests du kit macOS (bac à sable jetable)
```

## Licence

MIT — voir [LICENSE](LICENSE).
