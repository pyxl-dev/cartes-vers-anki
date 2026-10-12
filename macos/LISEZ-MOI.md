# Kit bêta macOS — Cartes vers Anki

> **Premier réflexe :** ouvre **[00 - INSTALLER SUR MAC.html](../00%20-%20INSTALLER%20SUR%20MAC.html)**
> (à la racine du dossier téléchargé). C'est le guide pas à pas, avec les écrans
> d'avertissement de macOS et la façon de les autoriser.

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

## Premier lancement : autoriser l'installateur dans macOS

L'installateur n'est pas signé par Apple. Au premier double-clic, macOS affiche
donc cette fenêtre :

> *Élément « Installer Cartes vers Anki.command » non ouvert — Apple n'a pas pu
> confirmer que ce logiciel ne contient pas de logiciel malveillant.*
> Boutons : « Placer dans la corbeille » et « Terminé ».

**La marche à suivre, dans cet ordre :**

1. Clique **« Terminé »**. Surtout pas « Placer dans la corbeille » : ce bouton
   enverrait le fichier à la poubelle et il faudrait le retélécharger.
2. Ouvre ** (menu Pomme) → Réglages Système → Confidentialité et sécurité**.
3. Descends à la section **Sécurité** : une ligne concerne
   « Installer Cartes vers Anki.command », avec le bouton **« Ouvrir quand
   même »**. Clique-le, puis confirme. macOS peut demander ton mot de passe ou
   Touch ID : c'est macOS qui le demande, pas le projet.
4. **Double-clique à nouveau** l'installateur. Cette fois il s'exécute.

**Si le bouton « Ouvrir quand même » n'est pas là :**

- refais d'abord un double-clic sur le fichier, c'est cette tentative qui fait
  apparaître le bouton ;
- reviens ensuite dans **Confidentialité et sécurité → Sécurité** ;
- le bouton n'est proposé qu'environ **une heure** après la tentative ;
- sur un Mac administré (école, entreprise) ou avec un **contrôle parental**
  actif, le bouton peut être indisponible : il faut alors l'accord de la personne
  qui gère l'ordinateur.

Ce kit ne demande jamais ton mot de passe, n'utilise pas `sudo`, ne désactive
aucune protection de macOS et ne retire aucune mise en quarantaine. La seule
autorisation donnée est celle que tu accordes toi-même, à l'étape 3, dans les
réglages d'Apple. Le guide illustré complet est dans
**[00 - INSTALLER SUR MAC.html](../00%20-%20INSTALLER%20SUR%20MAC.html)**.

## Limites connues de cette version bêta

- **Archive ZIP et droit d'exécution.** Vérifié sur l'archive réelle de cette
  branche : GitHub transporte bien le droit d'exécution (mode `100755`), et le
  double-clic fonctionne après extraction par l'utilitaire d'archive de macOS.
  Ce n'est pas garanti avec tous les outils de décompression (certains clients
  Windows, ou une ré-archive manuelle) : dans ce cas le double-clic ouvre le
  fichier dans un éditeur de texte, et le geste prévu est *clic droit → Ouvrir
  avec → Terminal*. L'installateur rétablit de toute façon le droit d'exécution
  sur la copie qu'il installe.
- **Avertissement de sécurité macOS.** Le kit n'est pas signé : macOS bloque le
  premier double-clic. L'autorisation passe par **Réglages Système →
  Confidentialité et sécurité → Sécurité → « Ouvrir quand même »** (voir la
  section précédente). Il n'existe aucun contournement automatique, et le projet
  n'en propose aucun : faire disparaître complètement cet avertissement demande
  une vraie signature Developer ID et une notarisation, décrites dans
  [NOTARISATION.md](NOTARISATION.md).
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
