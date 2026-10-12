# Note technique — faire disparaître l'avertissement macOS (non fait aujourd'hui)

Document destiné aux personnes qui développent le projet. Il décrit le seul
chemin officiel pour qu'un utilisateur n'ait plus rien à autoriser, et pourquoi
il n'est pas emprunté pour l'instant.

## Le problème, en une phrase

Les fichiers `.command` de `macos/` sont des scripts non signés. macOS les met en
quarantaine au téléchargement et bloque le premier double-clic. L'utilisateur
doit autoriser le fichier lui-même dans **Réglages Système → Confidentialité et
sécurité → Sécurité → « Ouvrir quand même »**. Ce n'est ni un bug ni un défaut de
configuration : c'est le comportement prévu par Apple.

## Ce que le projet ne fait pas, et ne fera pas

- Aucune désactivation de Gatekeeper (`spctl --master-disable`).
- Aucun retrait silencieux de la mise en quarantaine (`xattr -d com.apple.quarantine`).
- Aucune élévation de privilèges (`sudo`) pour forcer l'ouverture.
- Aucune signature ad hoc présentée comme une vraie signature.

Ces contournements affaiblissent la machine de l'utilisateur et déplacent le
problème au lieu de le résoudre. Le projet préfère expliquer la procédure
officielle : c'est ce que fait `00 - INSTALLER SUR MAC.html`.

## Le vrai correctif : Developer ID + notarisation

Pour que l'avertissement disparaisse réellement, il faut livrer un paquet signé
et notarié par Apple. Cela suppose :

1. **Un compte Apple Developer Program** (payant, annuel), qui fournit un
   certificat **Developer ID Application**.
2. **Un paquet installable** : un `.app` ou un `.pkg`, plutôt qu'un `.command`
   nu. Un script seul n'est pas un livrable signable proprement ; il faut un
   conteneur.
3. **La signature** avec le certificat Developer ID, horodatée
   (`codesign --timestamp --options runtime`).
4. **La notarisation** : envoi du paquet à `notarytool` avec un mot de passe
   d'application ou une clé d'API, puis attente du verdict d'Apple.
5. **L'agrafage du ticket** (`stapler`) pour que la vérification fonctionne hors
   ligne.
6. **La validation** sur une machine propre, avec une vraie connexion Internet,
   en vérifiant qu'aucun avertissement n'apparaît.

Résultat attendu : le double-clic fonctionne directement, sans passage par les
réglages de sécurité.

## Ce qu'il faut savoir avant de s'y engager

- **Le certificat et les secrets ne doivent jamais entrer dans ce dépôt.** Le
  mot de passe d'application ou la clé d'API de notarisation se stockent dans le
  trousseau de la machine de build ou dans les secrets d'une intégration
  continue, jamais dans un fichier versionné.
- **La signature change le mode de distribution.** Un `.pkg` installé dans
  `/Applications` n'est plus un dossier cloné par `git` : le mécanisme de mise à
  jour actuel (`git fetch` + `git merge --ff-only`) devrait être repensé, par
  exemple avec un paquet versionné ou un canal de mise à jour dédié.
- **Le code de l'extension ne change pas.** L'extension elle-même est chargée
  « non empaquetée » dans le navigateur ; la signature concerne le kit
  d'installation, pas l'extension.
- **Le Chrome Web Store est un autre sujet.** Une fois l'extension publiée, la
  partie navigateur n'a plus besoin d'installation manuelle. Le kit macOS
  resterait utile pour AnkiConnect et pour les utilisateurs hors Store.

## En attendant

La procédure utilisateur documentée dans
[`../00 - INSTALLER SUR MAC.html`](../00%20-%20INSTALLER%20SUR%20MAC.html) et dans
[`LISEZ-MOI.md`](LISEZ-MOI.md) est la seule voie officielle. Elle demande une
minute, une seule fois par utilisateur.

## Références

- Apple — ouvrir une app d'un développeur non identifié :
  <https://support.apple.com/fr-fr/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac>
- Apple — notariser un logiciel macOS avant distribution :
  <https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>
- Apple — `notarytool` :
  <https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution/customizing_the_notarization_workflow>
