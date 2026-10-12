# Kit bêta macOS — Cartes vers Anki

Deux fichiers à double-cliquer dans le Finder, pour installer l'extension une
première fois puis la mettre à jour sans rien retaper.

| Fichier | Quand l'utiliser |
| --- | --- |
| `Installer Cartes vers Anki.command` | Une seule fois, pour la première installation. |
| `Mettre à jour Cartes vers Anki.command` | Ensuite, chaque fois qu'une nouvelle version est publiée. |

L'installation place une copie permanente de l'extension dans
`~/Applications/Cartes vers Anki Beta` et ajoute un raccourci **Mettre à jour
Cartes vers Anki** sur le Bureau.

## Si le double-clic n'exécute pas le fichier

Un dossier téléchargé depuis GitHub (*Code → Download ZIP*) **ne conserve pas le
droit d'exécution** : macOS ouvre alors le fichier dans un éditeur de texte au
lieu de le lancer. Ce n'est pas une erreur de ta part, et le fichier n'est pas
abîmé.

**Le geste à faire, une seule fois :** clic droit (ou `Ctrl` + clic) sur le
fichier → *Ouvrir avec* → **Terminal**. Le script se lance. Répète l'opération
pour l'autre fichier.

Ensuite, plus rien à faire : le raccourci posé sur le Bureau fonctionne par
simple double-clic.

> Si tu récupères le dépôt avec `git clone`, ce problème ne se pose pas : le
> droit d'exécution est conservé, et l'installateur le rétablit de toute façon
> sur sa propre copie.

## Premier lancement : l'avertissement de macOS

macOS peut afficher un message du type *« … ne peut pas être ouvert car il
provient d'un développeur non identifié »*. C'est normal pour un script non
signé. Pour l'autoriser : **clic droit sur le fichier → Ouvrir → Ouvrir**. Une
seule fois suffit.

Ce kit ne demande jamais ton mot de passe, n'utilise pas `sudo` et ne désactive
aucune protection de macOS.

## Limites connues de cette version bêta

- **Archive ZIP et droit d'exécution.** Le dépôt conserve le droit d'exécution
  (mode `100755`), et un `git clone` le respecte. Une archive *Download ZIP*
  téléchargée depuis GitHub peut en revanche ne pas le transporter : dans ce cas
  le double-clic n'exécute pas le fichier. Le contournement par *Ouvrir avec →
  Terminal* est le geste prévu, mais son comportement exact n'est pas garanti
  sur toutes les versions de macOS. **Le chemin recommandé reste donc
  l'installateur lui-même, qui clone le dépôt** — il rétablit aussi le droit
  d'exécution sur sa propre copie.
- **Avertissement de sécurité macOS.** Le premier lancement peut demander une
  confirmation (clic droit → *Ouvrir*). Le kit n'est pas signé : c'est normal
  pour un script distribué hors App Store.
- **Deux navigateurs seulement testés** : Brave et Chrome (Chromium). Edge
  devrait fonctionner, sans garantie.
- **Raccourci du Bureau.** Il peut être refusé si macOS restreint l'accès au
  Bureau. Dans ce cas le script de mise à jour reste accessible dans le dossier
  d'installation, et son chemin est affiché à la fin de l'installation.

## Ce que le kit ne fait pas

- Il ne touche **pas** à Anki : ni aux cartes, ni aux paquets, ni à l'historique
  de révision. Il ne parle jamais à AnkiConnect.
- Il ne lit aucun contenu de cours.
- Il ne télécharge que le dépôt public officiel, et rien d'autre.
- La mise à jour se limite à `git fetch` puis `git merge --ff-only` : jamais de
  remise à zéro, jamais d'écrasement, jamais de changement de branche.

## Version installée

Le dépôt public est actuellement en **1.4.0**. La version **1.4.2** arrivera
automatiquement par la mise à jour dès qu'elle sera fusionnée.
