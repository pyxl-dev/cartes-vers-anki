# Développement

[← Retour au README](../README.md)

## Structure

```
extension/            extension chargeable (manifest.json à la racine)
  shared.js           fonctions communes (recherche, libellés, tags, échappement, mise en forme)
  cards.js            analyse et validation du JSON des cartes
  content.js          détection du bloc JSON sur ChatGPT + boutons d'import
  picker.js           sélecteur de paquet (avec création) et confirmation
  rich.js             éditeur visuel (barre d'outils, trous en cases)
  review.js           fenêtre de vérification : comparaison, import, mise à jour
  background.js       appels AnkiConnect (service worker MV3), résolution du port
  search.js           lecture des notes existantes
  similarity.js       comparaison lexicale locale
  popup.html/.js      port, préparation du prompt, mode de secours
macos/                kit bêta : installer et mettre à jour par double-clic
tests/test.cjs        tests de l'extension
tests/mac-beta-setup.sh  tests du kit macOS
docs/PUBLICATION.md   publication sur le Chrome Web Store (tag vX.Y.Z)
.github/workflows/    tests sur chaque PR, publication sur tag
```

## Installer depuis les sources

1. Cloner le dépôt dans un dossier permanent.
2. Ouvrir `chrome://extensions` (ou `brave://extensions`) et activer le **Mode développeur**.
3. **Charger l'extension non empaquetée** → choisir le dossier `extension/`.

## Tests

```bash
node tests/test.cjs
```

```bash
bash tests/mac-beta-setup.sh
```

Les tests tournent hors navigateur et sans réseau externe. Les scripts sont chargés dans l'ordre réel de `manifest.json`, `popup.html` et `importScripts`. Les tests d'intégration ne peuvent joindre **que** un faux AnkiConnect local, jamais un vrai Anki ouvert sur la machine.

Couverture de `tests/test.cjs` :

- **Lecture du JSON** : cartes invalides isolées, réponses coupées ou en plusieurs blocs, lots de 5 à 230 cartes, tableau nu, clé `notes`, cloze, accents, tags, HTML, contenu trop long.
- **Port AnkiConnect** : validation, identification d'un vrai AnkiConnect, refus des services étrangers, ordre 8765 → 8766, priorité du choix manuel, aucune écriture pendant la sonde.
- **Import** contre un faux AnkiConnect : 100 cartes, réimport (0 ajoutée), doublons internes, appel `multi` groupé, échec partiel, repli carte par carte sans double écriture.
- **Mise en forme** : compatibilité 1.5, marqueurs `{{c1::…}}` intacts sur 2000 textes aléatoires, doublons après mise en forme.
- **Création de paquet**, **éditeur visuel** (aller-retour sans perte, contenu collé depuis Chrome), **trous visuels**, **thème**.
- **`content.js`** sur un DOM simulé : bouton au bon endroit, jamais sur le message de l'utilisateur, pas de doublon.
- **Garde-fous** : permissions minimales, aucune URL distante, aucun secret, aucun HTML brut inséré, aucune action Anki destructive.

Non couverts : le vrai ChatGPT.com (DOM reproduit), Anki lui-même (serveur simulé), l'accessibilité au lecteur d'écran.

Le kit macOS est testé dans un bac à sable jetable (`HOME`, dépôt Git et Bureau temporaires) : installation, réinstallation, mise à jour, modifications locales, origine ou branche étrangère refusées, chemins avec espaces, absence de `git`, aucun appel à Anki.

## Publication

Voir [PUBLICATION.md](PUBLICATION.md) : un tag `vX.Y.Z` lance les tests, construit le zip et le soumet au Chrome Web Store.
