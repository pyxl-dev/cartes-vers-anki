# Cartes vers Anki

Extension navigateur (Manifest V3) qui transforme les cartes générées par ChatGPT.com en notes dans **Anki Desktop**, sans copier-coller de JSON, avec contrôle des doublons avant import.

> ### 🧩 Installation la plus simple : [Cartes vers Anki sur le Chrome Web Store](https://chromewebstore.google.com/detail/fhkabgkbnknihhdlmcnkmnbijepclipi)
>
> Fonctionne dans Chrome, Brave et Edge. Les mises à jour s'installent ensuite toutes seules.
> Les sections « kit bêta » et « installation manuelle » ci-dessous ne servent qu'à tester une version non publiée.

**Entièrement local :** l'extension ne parle qu'à `AnkiConnect` sur la boucle locale (`127.0.0.1`). Aucun serveur distant, aucune clé d'API, aucun compte, aucune télémétrie, aucun quota imposé par l'extension.

> ### 🍎 Sur Mac, commence par ouvrir [00 - INSTALLER SUR MAC.html](00%20-%20INSTALLER%20SUR%20MAC.html)
>
> Ce guide hors ligne reprend tout, pas à pas, **y compris la fenêtre
> d'avertissement de macOS** et la façon de l'autoriser toi-même. Il s'ouvre par
> simple double-clic, dans ton navigateur.

---

## Prérequis

1. **Anki Desktop** — <https://apps.ankiweb.net/>
2. **AnkiConnect** (greffon Anki) — dans Anki : `Outils → Greffons → Obtenir des greffons`, code **`2055492159`**, puis quitter et relancer Anki.
3. Un navigateur Chromium : **Brave**, **Chrome** ou **Edge**.

## Installation rapide sur macOS (kit bêta)

**À faire avant tout le reste.** L'installateur n'est pas signé par Apple. Au
premier double-clic, macOS affiche donc cette fenêtre :

> *Élément « Installer Cartes vers Anki.command » non ouvert — Apple n'a pas pu
> confirmer que ce logiciel ne contient pas de logiciel malveillant.*
> Boutons : « Placer dans la corbeille » et « Terminé ».

1. Clique **« Terminé »** — jamais « Placer dans la corbeille », qui enverrait le
   fichier à la poubelle.
2. Va dans ** → Réglages Système → Confidentialité et sécurité**, section
   **Sécurité**, et clique **« Ouvrir quand même »**, puis confirme.
3. **Double-clique à nouveau** l'installateur : il s'exécute cette fois.

Le bouton « Ouvrir quand même » n'est proposé qu'environ **une heure** après la
tentative, et il peut être absent sur un Mac administré ou avec contrôle
parental. Si tu ne le vois pas : refais un double-clic, puis reviens dans
**Sécurité**. Cette autorisation est une décision que tu prends toi-même dans les
réglages d'Apple ; le projet ne désactive aucune protection et ne contourne rien.

Le parcours complet, écran par écran, est dans
**[00 - INSTALLER SUR MAC.html](00%20-%20INSTALLER%20SUR%20MAC.html)**.

Ensuite, le dossier **`macos/`** contient deux fichiers à double-cliquer :

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

Détails et dépannage : **[macos/LISEZ-MOI.md](macos/LISEZ-MOI.md)**.

> **Fichiers téléchargés en ZIP.** Vérifié sur l'archive réelle de cette
> branche : le droit d'exécution est bien transporté, donc le double-clic
> fonctionne après extraction. Si ton outil de décompression ne le conserve pas
> (certains clients Windows, ou une ré-archive manuelle), le double-clic ouvre
> le fichier dans un éditeur : fais alors **clic droit sur le fichier →
> *Ouvrir avec* → Terminal**, une seule fois. Un `git clone` conserve ce droit
> dans tous les cas.
>
> **Avertissement de macOS.** Voir le parcours en tête de cette section. Le
> clic droit → *Ouvrir* → *Ouvrir* ne suffit plus sur les versions récentes de
> macOS : c'est bien par **Réglages Système → Confidentialité et sécurité** que
> l'autorisation se donne.

## Installation manuelle

1. Télécharger ce dépôt (bouton *Code → Download ZIP*) et le décompresser dans un dossier **permanent**. Ne plus déplacer le dossier `extension/` ensuite.
2. Ouvrir `brave://extensions` (ou `chrome://extensions`).
3. Activer **Mode développeur**.
4. Cliquer **Charger l'extension non empaquetée** et choisir le sous-dossier **`extension/`** (celui qui contient `manifest.json`).
5. Épingler l'extension **Cartes vers Anki**, cliquer sur son icône : la liste des paquets Anki doit apparaître.

## Utilisation

1. **Anki ouvert**, puis ouvrir ChatGPT.com.
2. Joindre ou coller le cours, et demander les cartes sous forme d'**un seul bloc de code JSON** (voir le schéma ci-dessous).
3. Un bouton **« Ajouter N cartes à Anki »** apparaît automatiquement sous la réponse. Au-delà de 100 cartes, un bouton par **lot de 100** (« Lot 2 : ajouter les cartes 101 à 200 »).

   La lecture est **tolérante** : une carte mal formée est écartée seule (avec sa raison, listée dans la fenêtre de vérification) au lieu de bloquer tout le lot ; une réponse **coupée** par ChatGPT donne les cartes complètes, la dernière carte incomplète étant ignorée ; plusieurs blocs de code dans la même réponse sont **additionnés**.
4. Cliquer dessus : la fenêtre de vérification liste les cartes, permet de les corriger et de choisir le paquet.

   **Éditeur visuel.** Chaque champ (question, réponse, texte à trous, précisions) se modifie **mis en forme**, comme dans un traitement de texte : barre d'outils **G** (gras), *I* (italique), x² (exposant), x₂ (indice), listes à puces et numérotées, « Effacer » la mise en forme ; Ctrl/Cmd+B et Ctrl/Cmd+I fonctionnent aussi. Un collage arrive toujours en **texte simple**. Le lien **« Texte brut »** montre le texte exact envoyé à Anki (avec son aperçu) pour qui préfère l'écrire à la main.

   **Textes à trous sans syntaxe.** Chaque trou est une **case** contenant la réponse attendue, précédée du numéro de la carte qu'il produira : on corrige la réponse dans la case, on retire un trou avec **×** (le texte reste), et on **crée un trou** en sélectionnant un mot puis **« Transformer la sélection en trou »** (nouveau numéro = nouvelle carte). Le texte autour des trous se modifie librement ; une modification qui casserait un trou est refusée avec une explication.

   **Apparence.** Le bouton « Thème » (en haut de la fenêtre) et le réglage « Apparence » du popup choisissent **automatique** (suit le mode clair / sombre du système, en direct), **clair** ou **sombre**.
5. La **comparaison se lance automatiquement** à l'ouverture (sur le dernier paquet utilisé) : les doublons exacts sont décochés, les formulations proches sont signalées « à vérifier ».
6. Changer de paquet dans la liste **relance la comparaison automatiquement** ; les conclusions du paquet précédent sont abandonnées et les cartes remises à l'état initial. Le bouton **« Relancer la comparaison »** reste disponible en secours.
7. Facultatif : remplir **« Tag du lot »** (par exemple `Cardio::Cours_3`). Ce tag est ajouté à **toutes** les cartes importées, en plus de leurs propres tags (il ne compte pas dans la limite de 8), et il est **mémorisé** pour la prochaine fois. Les espaces deviennent `_`, comme pour les autres tags.
8. Vérifier le **récapitulatif** en bas de la fenêtre (« 87 carte(s) → paquet « Cardio › Cours 3 » · tag du lot « Cardio::Cours_3 » »), puis cliquer **« Importer dans Anki »**. Les cartes déjà présentes ne sont jamais réimportées. L'envoi à Anki est **groupé** (un seul appel pour tout le lot) ; une carte refusée par Anki n'empêche pas les autres et son numéro est indiqué.

Le paquet de destination se **recherche** : taper tout ou partie du nom (la casse, les accents et les ligatures sont ignorés — `coeur` trouve `cœur`). Les résultats sont affichés par niveaux (`Cardiologie › Item 221 › Sous-item`) alors que la valeur transmise reste le nom complet Anki `Parent::Enfant`. Un paquet parent et ses sous-paquets se choisissent dans la même liste, et l'analyse porte sur le paquet choisi **et ses sous-paquets**. Le sélecteur se pilote au clavier (flèches puis Entrée) ; taper ne relance pas la comparaison, seule une **sélection** le fait.

**Choisir ou créer un paquet.** Cliquer le champ sélectionne le nom affiché : taper le **remplace** et filtre la liste (Échap ou un clic ailleurs réaffichent le paquet choisi ; « ▾ » montre tous les paquets). Le bouton **« + Nouveau paquet »**, toujours visible, ouvre un petit formulaire sous le champ ; la liste propose aussi « + Créer le paquet « X » » quand le nom tapé n'existe pas. Le formulaire indique ce qui sera créé (et si le paquet parent le sera aussi) : rien n'est écrit avant le clic sur **« Créer le paquet »**. Les sous-paquets s'écrivent `Parent::Enfant` (ou `Parent › Enfant`). Les noms vides, de plus de 150 caractères ou contenant des guillemets sont refusés avec une explication. Seule l'action `createDeck` est utilisée : aucun paquet existant n'est modifié, et un paquet portant déjà ce nom (casse ignorée) est simplement choisi. Après création, la liste est rechargée, le nouveau paquet est sélectionné et la comparaison relancée.

**Sélection des cartes.** Chaque ligne porte une **case à cocher toujours visible**, y compris quand le détail est replié : cliquer la case sélectionne ou désélectionne la carte sans ouvrir la ligne ; cliquer le titre ou le chevron déplie le détail. Deux boutons font **« Tout sélectionner (cartes nouvelles) »** et **« Tout désélectionner »**, et un compteur indique en permanence le nombre de cartes retenues.

Chaque ligne affiche aussi un **point de statut** avant le titre, complété par une légende et un libellé accessible (le statut ne repose jamais sur la seule couleur) :

| Point | Statut | Signification |
|---|---|---|
| 🟢 vert | Nouvelle | Aucun doublon détecté : la carte est cochée pour l'import |
| 🟠 orange | Formulation similaire | Ressemblance lexicale : décochée par précaution, réactivable en connaissance de cause |
| 🔴 rouge | Déjà présente | Doublon certain : case d'import **désactivée** et décochée, non réimportable |

Pendant la comparaison, les points restent **neutres** (« Comparaison en cours ») et les cases sont désactivées : aucun statut n'est affiché avant d'avoir été vérifié. Si une carte est à la fois un doublon certain et une ressemblance, c'est **le doublon qui prime**. Après analyse, seules les cartes nouvelles sont cochées ; un doublon exact ne peut jamais être réactivé, ni par un changement de paquet, ni par « Tout sélectionner (cartes nouvelles) ».

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
| `tags` | facultatif — 8 tags conservés au maximum (le tag du lot s'ajoute en plus) |

### Mise en forme des cartes

Les textes des cartes acceptent un petit sous-ensemble de Markdown, converti en HTML Anki **après** échappement complet du texte :

| Écrire | Résultat dans Anki |
|---|---|
| `**gras**`, `*italique*`, `` `code` `` | **gras**, *italique*, `code` |
| `Na^+^`, `Ca^2+^`, `x^2^` | exposant (Na⁺, Ca²⁺, x²) |
| `H~2~O`, `x~1~` | indice (H₂O, x₁) |
| lignes commençant par `- ` | liste à puces |
| lignes commençant par `1. `, `2. `… | liste numérotée |
| retour à la ligne (`\n` dans le JSON) | retour à la ligne |

Rien d'autre : ni lien, ni image, ni HTML brut (une balise écrite par ChatGPT reste du texte visible). Les marqueurs de texte à trous `{{c1::…}}` et `{{c1::…::indice}}` ne sont **jamais coupés** : une mise en forme peut être à l'intérieur d'un trou (`{{c1::Na^+^}}`), jamais à cheval sur ses accolades ; l'indice reste en texte simple. Un texte sans mise en forme donne exactement le même champ qu'avant la version 1.6.0.
Autres contraintes :

- **100 cartes par vérification / import.** Au-delà, la réponse est découpée automatiquement en lots de 100, chacun avec son bouton.
- **Tags** : les espaces deviennent `_`, la hiérarchie Anki `Parent::Enfant` est conservée, ainsi que les lettres accentuées et ligatures (`cœur`).
- Le **paquet de destination** doit exister dans Anki, ou être créé depuis la fenêtre de vérification (après confirmation).
- Le type de note doit être **Basique / Basic** ou **Texte à trous / Cloze**. L'extension écrit dans les **deux premiers champs** du type de note : tester avec un type très personnalisé avant un usage réel.
- Une carte invalide est refusée avec son numéro, sans bloquer les autres.

### Prompt prêt à l'emploi

> À partir du cours ci-dessous, crée 20 cartes Anki de révision à long terme. Une seule connaissance testée par carte, question sans ambiguïté, réponse précise. N'invente aucune donnée absente du cours. Réponds uniquement par un bloc de code contenant du JSON valide, au format exact : `{"cards":[{"type":"basic","front":"Question","back":"Réponse","tags":["medecine"]},{"type":"cloze","text":"Le {{c1::métoprolol}} est …","extra":"Précision","tags":["medecine"]}]}`. Garde les marqueurs `{{c1::…}}` intacts. Mise en forme autorisée : `**gras**`, `*italique*`, `` `code` ``, listes « - » ou « 1. », exposant `^texte^` et indice `~texte~` ; aucun lien, aucune image, aucun HTML.

Le bouton **« Préparer dans ChatGPT »** du popup insère une version générique de ce prompt (toutes matières), qui annonce la même mise en forme.

## Doublons

Deux contrôles complémentaires, tous deux exécutés **avant** l'ajout :

- **Doublons exacts** — action `canAddNotes` d'AnkiConnect, portée **collection entière**, plus les répétitions internes au lot. Re-contrôle à l'insertion. Les cartes concernées sont décochées et jamais réimportées. Le contrôle porte sur le champ **mis en forme**, exactement celui qui sera écrit : une carte reformatée à l'identique reste un doublon.
- **Formulations proches** — comparaison **lexicale locale** (pas d'IA) des questions et réponses dans le paquet choisi et ses sous-paquets, plafonnée à 20 000 notes. La mise en forme est ignorée (`H~2~O` et `H<sub>2</sub>O` se comparent comme `H2O`). L'interface indique explicitement si l'analyse est partielle. Ces cartes sont décochées par précaution et signalées « à vérifier » : deux questions proches peuvent tester deux faits différents.

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

- **100 cartes maximum par import** : au-delà, l'extension propose un bouton par lot de 100.
- L'extension ne crée pas de type de note. Elle ne crée un paquet que depuis la fenêtre de vérification, après confirmation explicite.
- Éditeur visuel : pas de liste imbriquée (un sous-point devient un point du même niveau), pas de souligné (non conservé) ; un exposant ou un indice s'applique mot par mot. Un trou imbriqué dans un autre, ou l'indice d'un trou (`::indice`), se modifie dans « Texte brut ». La création d'un trou se fait par sélection (souris ou Maj+flèches).
- Mise en forme volontairement limitée : pas de liste imbriquée (une ligne indentée reste un élément du même niveau), pas de titre, de tableau, de lien ni d'image. Comme en Markdown, `a*b*c` met `b` en italique : écrire `a × b × c` ou utiliser `` `code` `` pour un astérisque littéral.
- Une carte importée **avant la 1.6.0** avec des marqueurs visibles (`**mot**` écrit en clair) n'est pas un doublon exact de la même carte désormais mise en forme : elle est signalée « Formulation similaire » et décochée par précaution.
- Un changement **uniquement** de mise en forme n'est pas proposé comme remplacement d'une note existante (le texte est identique).
- La détection automatique du bouton dépend de la structure HTML de ChatGPT.com. Elle est vérifiée sur le DOM courant (`[data-dil-source-message-id]` pour le message de l'assistant, `[data-user-message-bubble]` pour le message de l'utilisateur), avec l'ancien sélecteur `[data-message-author-role]` conservé en secours. Si le site change encore, le **mode de secours par collage** reste opérationnel.
- L'import se fait dans un navigateur de bureau (Brave/Chrome/Edge) ; AnkiConnect n'est pas joignable depuis un navigateur mobile.
- Les modèles Anki très personnalisés ne sont pas détectés automatiquement : l'extension utilise les deux premiers champs.

## Tests

```bash
node tests/test.cjs          # extension : 233 tests
bash tests/mac-beta-setup.sh # kit macOS : 42 tests, dans un bac à sable jetable
```

233 tests hors navigateur, sans réseau externe. Les scripts sont chargés dans l'ordre réel lu dans `manifest.json`, `popup.html` et `importScripts`, et les tests d'intégration ne peuvent joindre **que** le faux AnkiConnect (jamais un vrai Anki ouvert sur la machine) :

- lecture tolérante : carte invalide isolée, réponse coupée au milieu d'une carte, réponse recollée sur deux blocs, plusieurs blocs JSON, 230 cartes découpées en 3 lots, accolades et guillemets dans le texte, code ordinaire ignoré ;
- analyse du JSON : lots de 5 / 50 / 100 / 101 / 200 cartes, bloc ```` ```json ````, tableau nu, clé `notes`, cloze valide et invalide, accents, tags, HTML, contenu trop long ;
- port AnkiConnect : validation `1..65535`, identification d'un vrai AnkiConnect, refus d'un JSON étranger / d'une page HTML / d'un objet sans version, ordre de sondage 8765 → 8766, priorité du choix manuel, aucune écriture envoyée pendant la sonde ;
- import réel contre un **faux AnkiConnect** en boucle locale : ajout de 100 cartes, réimport → 0 ajoutée + 100 doublons, doublon interne au lot, cloze, refus au-delà de 100, paquet inconnu, contrôle d'origine des messages ;
- import groupé : un seul appel `multi`, échec partiel (cartes refusées numérotées, les autres ajoutées), erreur globale → repli carte par carte avec re-contrôle des doublons (jamais de double écriture) ;
- mise en forme : compatibilité exacte avec la 1.5 pour un texte simple, gras / italique / code / exposant / indice / listes, aucun lien ni HTML, marqueurs `{{c1::…}}` intacts (y compris sur 2000 textes aléatoires), doublon reconnu après mise en forme, similarité insensible à la mise en forme, aperçu construit en DOM sûr ;
- création de paquet (`CREATE_DECK`) : sous-paquets, paquet existant jamais recréé, noms invalides refusés sans écriture, origine contrôlée ; dans la fenêtre : option en dernière position, confirmation, annulation sans écriture, rechargement, sélection et comparaison relancée ;
- tag du lot : normalisé, ajouté en plus des 8 tags, mémorisé, affiché dans le récapitulatif ;
- éditeur visuel : aller-retour éditeur → texte sans perte sur 2000 textes aléatoires, contenu produit par Chrome (blocs, lignes vides, listes, styles imbriqués, styles et liens collés ignorés), barre d'outils, collage en texte simple, bascule texte brut ;
- champ paquet : Échap / clic ailleurs, formulaire de création (explication, annulation, paquet existant choisi, erreur d'Anki, clavier) ;
- thème : automatique suivi en direct, clair / sombre imposés et mémorisés, contraste du mode sombre, réglage du popup ;
- texte à trous visuel : positions exactes dans la source (2000 textes aléatoires), réponse modifiée à sa place avec mise en forme et indice conservés, réponses invalides refusées, trou retiré sans perdre le texte, sélection transformée en trou (refus à cheval sur une mise en forme, un trou ou du code), bascule texte brut ;
- `content.js` avec un DOM simulé : bouton « Ajouter N cartes à Anki » créé dans le bon conteneur, jamais sur le message de l'utilisateur, pas de doublon de bouton après re-balayage, ancien DOM pris en charge, ouverture de la fenêtre, message neutre quand toutes les cartes existent déjà, import envoyé pour des cartes neuves ;
- cohérence du manifeste (version, permissions minimales, aucune URL distante, aucun motif de secret), ordre de chargement (`shared.js` en premier partout), aucune insertion de HTML brut, aucune action Anki destructive.

**Ce que les tests ne couvrent pas :** le site ChatGPT.com réel (le DOM du test est une reproduction), Anki lui-même (le serveur est simulé), et l'accessibilité avec un lecteur d'écran.

Le kit macOS est testé séparément, dans un bac à sable jetable : `HOME` temporaire, dépôt Git local, Bureau temporaire. Le vrai dossier personnel n'est jamais écrit et aucun raccourci réel n'est créé. Les cas couverts : première installation, réinstallation idempotente, mise à jour vers une nouvelle version, « déjà à jour », modifications locales refusées, origine étrangère refusée, mauvaise branche refusée, chemins contenant des espaces, absence de `git`, syntaxe et droit d'exécution, et absence de tout appel à Anki ou à AnkiConnect.

## Structure

```
extension/      extension chargeable (manifest.json à la racine de ce dossier)
  shared.js     fonctions communes (recherche, libellés, tags, échappement, mise en forme)
  cards.js      analyse et validation du JSON des cartes
  content.js    détection du bloc JSON sur la page ChatGPT + boutons d'import
  picker.js     sélecteur de paquet (avec création) et confirmation dans la page
  rich.js       éditeur visuel (barre d'outils, trous en cases, sélection → trou)
  review.js     fenêtre de vérification : aperçu, tag du lot, comparaison, import
  background.js appels AnkiConnect (service worker MV3), résolution du port
  search.js     lecture des notes existantes (contexte et recherche)
  similarity.js comparaison lexicale locale (formulations proches)
  popup.html/popup.js  interface : port, préparation du prompt, mode de secours
docs/PUBLICATION.md  publication automatique sur le Chrome Web Store (tag vX.Y.Z)
.github/workflows/   tests sur chaque PR, publication sur tag
macos/          kit bêta : installer et mettre à jour par double-clic
  Installer Cartes vers Anki.command
  Mettre à jour Cartes vers Anki.command
  LISEZ-MOI.md  mode d'emploi et dépannage
tests/test.cjs  tests hors navigateur de l'extension
tests/mac-beta-setup.sh  tests du kit macOS (bac à sable jetable)
```

## Licence

MIT — voir [LICENSE](LICENSE).
