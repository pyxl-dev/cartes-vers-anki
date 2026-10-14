# Guide d'utilisation

[← Retour au README](../README.md)

- [Fenêtre de vérification](#fenêtre-de-vérification)
- [Choisir ou créer un paquet](#choisir-ou-créer-un-paquet)
- [Doublons](#doublons)
- [Mettre à jour une note existante](#mettre-à-jour-une-note-existante)
- [Format JSON des cartes](#format-json-des-cartes)
- [Mode de secours (popup)](#mode-de-secours-popup)
- [Port d'AnkiConnect et dépannage](#port-dankiconnect-et-dépannage)
- [Limites connues](#limites-connues)

## Fenêtre de vérification

Sous chaque réponse de ChatGPT contenant des cartes, un bouton **« Ajouter N cartes à Anki »** apparaît. Au-delà de 100 cartes, il y a un bouton par **lot de 100** (« Lot 2 : ajouter les cartes 101 à 200 »).

La lecture est **tolérante** :

- une carte mal formée est écartée seule, avec sa raison, sans bloquer le lot ;
- une réponse **coupée** par ChatGPT donne les cartes complètes (la dernière, incomplète, est ignorée) ;
- plusieurs blocs de code dans la même réponse sont **additionnés**.

Le haut de la fenêtre (paquet, sélection, légende) et le bas (message, bouton d'import) restent fixes : seule la liste défile.

### Statut des cartes

La comparaison se lance automatiquement à l'ouverture, sur le dernier paquet utilisé. Chaque ligne porte un point de statut, doublé d'une légende et d'un libellé accessible :

| Point | Statut | Effet |
|---|---|---|
| 🟢 | Nouvelle | Cochée pour l'import |
| 🟠 | Formulation similaire | Décochée par précaution, réactivable |
| 🔴 | Déjà présente | Case désactivée, jamais réimportable |

Pendant la comparaison, les points restent neutres et les cases désactivées. Si une carte est à la fois doublon et ressemblance, le doublon prime.

Chaque ligne a une **case à cocher toujours visible** ; cliquer le titre ou le chevron déplie le détail. Les boutons **« Tout sélectionner (cartes nouvelles) »** et **« Tout désélectionner »** agissent sur toute la liste, et un compteur indique le nombre de cartes retenues.

### Éditeur visuel

Chaque champ (question, réponse, texte à trous, précisions) se modifie mis en forme : **G**, *I*, x², x₂, listes à puces et numérotées, « Effacer ». Ctrl/Cmd+B et Ctrl/Cmd+I fonctionnent. Un collage arrive toujours en texte simple. Le lien **« Texte brut »** montre le texte exact envoyé à Anki.

### Textes à trous

Chaque trou est une **case** contenant la réponse, précédée du numéro de la carte qu'il produira.

| Action | Comment |
|---|---|
| Corriger une réponse | Modifier le texte dans la case |
| Retirer un trou (le texte reste) | **×** |
| Créer un trou (nouvelle carte) | Sélectionner un mot → **« Transformer la sélection en trou »**, ou **Ctrl+Maj+C** (Cmd+Maj+C sur Mac) |
| Trou sur la même carte que le précédent | **Ctrl+Maj+Alt+C** |
| Annuler / rétablir | **Ctrl+Z** / **Ctrl+Maj+Z** |

Une modification qui casserait un trou est refusée avec une explication.

### Import

**« Importer N cartes »** envoie les cartes cochées en un seul appel groupé. Une carte refusée par Anki n'empêche pas les autres et son numéro est indiqué. Un message court résume le résultat (« 12 nouvelles · 1 à vérifier · 7 déjà dans Anki »).

### Apparence

Le bouton « Thème » de la fenêtre et le réglage « Apparence » du popup proposent **automatique** (suit le système), **clair** ou **sombre**.

### Après une mise à jour de l'extension

Un onglet ChatGPT ouvert avant la mise à jour garde l'ancien script. L'extension affiche alors « L'extension vient d'être mise à jour : recharge la page ChatGPT ». Les cartes restent dans la conversation.

## Choisir ou créer un paquet

- **Recherche** : taper tout ou partie du nom. Casse, accents et ligatures sont ignorés (`coeur` trouve `cœur`). Les résultats s'affichent par niveaux (`Cardiologie › Item 221`), la valeur transmise reste `Parent::Enfant`.
- **Portée** : l'analyse porte sur le paquet choisi **et ses sous-paquets**.
- **Clavier** : flèches puis Entrée. Taper ne relance pas la comparaison, seule une sélection le fait. Échap ou un clic ailleurs réaffichent le paquet choisi.
- **Changer de paquet** relance la comparaison ; les conclusions du paquet précédent sont abandonnées.
- **Liste à jour** : un paquet créé ou renommé dans Anki apparaît dès qu'on rouvre la liste ou qu'on revient sur l'onglet (au plus un appel toutes les 2,5 s, jamais en tâche de fond). Si le paquet choisi a disparu, l'import est bloqué.

**Créer un paquet** : quand le nom tapé n'existe pas, la dernière option propose **« + Créer le paquet « X » »**. Un formulaire indique ce qui sera créé (y compris un parent manquant) ; rien n'est écrit avant le clic sur **« Créer le paquet »**.

- Sous-paquets : `Parent::Enfant` ou `Parent › Enfant`.
- Refusés : noms vides, de plus de 150 caractères ou contenant des guillemets.
- Seule l'action `createDeck` est utilisée. Un paquet existant (casse ignorée) est simplement choisi.

## Doublons

Deux contrôles, tous deux **avant** l'ajout :

- **Doublons exacts** — `canAddNotes` d'AnkiConnect sur **toute la collection**, plus les répétitions internes au lot, avec re-contrôle à l'insertion. Le contrôle porte sur le champ mis en forme, exactement celui qui sera écrit.
- **Formulations proches** — comparaison **lexicale locale** (pas d'IA) des questions et réponses dans le paquet choisi et ses sous-paquets, plafonnée à 20 000 notes. La mise en forme est ignorée (`H~2~O` ≈ `H<sub>2</sub>O`). L'interface signale une analyse partielle.

Pour chaque doublon exact, l'extension indique **où la note est rangée** : identifiant, paquet réel (même dans un autre paquet), modèle et contenu. S'il y a plusieurs notes identiques, toutes sont listées et aucun remplacement n'est proposé.

Un import ne peut jamais s'appuyer sur une analyse obsolète : résultat périmé ignoré, import désactivé tant que la comparaison n'a pas abouti.

## Mettre à jour une note existante

Action distincte de l'import, jamais automatique. Sous une carte déjà présente, la case **« Mettre à jour la note dans Anki avec cette version »** n'apparaît que s'il y a quelque chose à changer ; « Voir les changements » montre l'avant → après.

Garde-fous :

- proposée seulement pour une note **certaine** : même premier champ, même modèle, correspondance unique ;
- chaque mise à jour est cochée explicitement, puis confirmée ; **Annuler n'écrit rien** ;
- `updateNoteFields` conserve **l'identifiant, le paquet, le planning de révision et les tags** ;
- la note est relue juste avant l'écriture : si un champ, le modèle, le paquet ou `mod` a changé, c'est refusé ;
- pour un texte à trous, un changement du nombre d'indices `{{cN}}` est refusé (il modifierait le planning).

## Format JSON des cartes

Accepté : un objet JSON, un tableau nu, ou un bloc ```` ``` ```` / ```` ```json ````.

```json
{
  "cards": [
    { "type": "basic", "front": "Question", "back": "Réponse", "tags": ["medecine"] },
    { "type": "cloze", "text": "Le {{c1::terme}} est ...", "extra": "Précisions", "tags": ["medecine"] }
  ]
}
```

| Champ | Règle |
|---|---|
| `type` | `"basic"` (défaut) ou `"cloze"`. Sans `type`, une carte contenant `{{c1::` est un cloze. |
| `front` / `question` | requis (basic), 8000 caractères max |
| `back` / `answer` | requis (basic), 8000 caractères max |
| `text` | requis (cloze), au moins un `{{c1::…}}` |
| `extra` / `back` | facultatif (cloze) |
| `tags` | facultatif, 8 max ; espaces → `_`, `Parent::Enfant` et accents conservés |

Autres règles :

- **100 cartes par import** ; au-delà, découpage automatique en lots.
- Le type de note doit être **Basique / Basic** ou **Texte à trous / Cloze**. L'extension écrit dans les **deux premiers champs** : tester avant d'utiliser un type très personnalisé.

### Mise en forme

Converti en HTML Anki **après** échappement complet du texte :

| Écrire | Résultat |
|---|---|
| `**gras**`, `*italique*`, `` `code` `` | **gras**, *italique*, `code` |
| `Na^+^`, `x^2^` | exposant |
| `H~2~O` | indice |
| `- ` / `1. ` en début de ligne | liste à puces / numérotée |
| `\n` | retour à la ligne |

Ni lien, ni image, ni HTML brut (une balise reste du texte visible). Les marqueurs `{{c1::…}}` et `{{c1::…::indice}}` ne sont jamais coupés : une mise en forme peut être dans un trou, jamais à cheval sur ses accolades.

### Prompt prêt à l'emploi

Le bouton **« Préparer dans ChatGPT »** du popup insère un prompt générique dans le champ de saisie, sans l'envoyer. Version manuelle :

> À partir du cours ci-dessous, crée 20 cartes Anki de révision à long terme. Une seule connaissance testée par carte, question sans ambiguïté, réponse précise. N'invente aucune donnée absente du cours. Réponds uniquement par un bloc de code contenant du JSON valide, au format exact : `{"cards":[{"type":"basic","front":"Question","back":"Réponse","tags":["medecine"]},{"type":"cloze","text":"Le {{c1::métoprolol}} est …","extra":"Précision","tags":["medecine"]}]}`. Garde les marqueurs `{{c1::…}}` intacts. Mise en forme autorisée : `**gras**`, `*italique*`, `` `code` ``, listes « - » ou « 1. », exposant `^texte^` et indice `~texte~` ; aucun lien, aucune image, aucun HTML.

## Mode de secours (popup)

Si le bouton n'apparaît pas (par exemple après un changement d'interface de ChatGPT) : copier le bloc JSON, ouvrir l'icône de l'extension, le coller, puis **1. Vérifier les doublons** → **2. Importer la sélection**. Ce mode ne dépend pas de la détection automatique.

## Port d'AnkiConnect et dépannage

L'extension essaie automatiquement `127.0.0.1:8765` puis `8766`, et n'accepte qu'un service qui répond réellement au protocole AnkiConnect. Un port occupé par un autre logiciel est écarté sans lui envoyer la moindre écriture.

Pour un autre port :

1. Vérifier qu'il est libre : `lsof -nP -iTCP:8766 -sTCP:LISTEN` (aucune sortie = libre).
2. Dans Anki : `Outils → Greffons → AnkiConnect → Config`, régler `webBindPort`, puis quitter et relancer Anki.
3. Dans le popup : saisir le même port, **Enregistrer le port**. **Détection auto** revient au mode automatique.

Problèmes courants :

- **Anki doit être ouvert** pendant la vérification et l'import.
- Accès refusé (origine non autorisée) : garder Anki ouvert et cliquer **Tester Anki / actualiser**.
- Garder `webBindAddress` sur `127.0.0.1` ; ne jamais régler `webCorsOriginList` à `["*"]`.

## Limites connues

- **100 cartes maximum par import** (un bouton par lot au-delà).
- Ne crée pas de type de note ; ne crée un paquet qu'après confirmation explicite.
- Modèles Anki très personnalisés : seuls les deux premiers champs sont utilisés.
- Mise en forme limitée : pas de liste imbriquée, de souligné, de titre, de tableau, de lien ni d'image. Comme en Markdown, `a*b*c` met `b` en italique.
- Éditeur visuel : exposant et indice s'appliquent mot par mot ; un trou imbriqué ou l'indice d'un trou (`::indice`) se modifient dans « Texte brut ».
- Une carte importée **avant la 1.6.0** avec des `**` visibles n'est pas un doublon exact de sa version mise en forme : elle est signalée « Formulation similaire ». Un changement de mise en forme seul n'est pas proposé comme mise à jour.
- La détection du bouton dépend du DOM de ChatGPT.com (`[data-dil-source-message-id]`, `[data-user-message-bubble]`, avec `[data-message-author-role]` en secours). En cas de changement, le mode de secours reste disponible.
- Navigateur de bureau uniquement : AnkiConnect n'est pas joignable depuis un mobile.
