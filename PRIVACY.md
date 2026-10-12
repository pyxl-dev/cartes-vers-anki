# Politique de confidentialité — Cartes vers Anki

**Dernière mise à jour : 11 octobre 2026**

Cette politique décrit les traitements de données réalisés par l'extension de navigateur **Cartes vers Anki** (« l'extension »), maintenue dans le dépôt [pyxl-dev/cartes-vers-anki](https://github.com/pyxl-dev/cartes-vers-anki).

## 1. À quoi sert l'extension ?

Cartes vers Anki permet de repérer des cartes de révision structurées dans les réponses de ChatGPT, de les vérifier, de comparer leur contenu avec des notes existantes, puis de les importer dans **Anki Desktop** à l'aide du module complémentaire **AnkiConnect**.

L'extension fonctionne dans le navigateur et communique avec AnkiConnect sur **l'ordinateur de l'utilisateur**.

## 2. Données auxquelles l'extension accède

Pour assurer ses fonctionnalités, l'extension peut traiter :

- **Le contenu des cartes de révision** visibles dans les réponses de ChatGPT (questions, réponses, textes à trous, précisions et étiquettes), ainsi que les modifications effectuées par l'utilisateur avant l'importation.
- **Les informations nécessaires à la comparaison avec Anki** : noms des paquets, contenu et métadonnées pertinentes des notes existantes, notamment pour détecter les doublons et proposer un remplacement explicite.
- **Les préférences de l'extension**, notamment le paquet Anki choisi et le port local utilisé pour joindre AnkiConnect.
- **Le contenu du champ de saisie de ChatGPT**, uniquement lorsqu'il est nécessaire à la fonction demandée par l'utilisateur pour y insérer un modèle de consigne ; cette fonction n'envoie pas le message à sa place.

Le script qui détecte les cartes s'exécute sur **chatgpt.com** et **chat.openai.com**. Il ne collecte pas l'historique de navigation de l'utilisateur sur d'autres sites.

Les cartes et notes peuvent contenir des informations personnelles ou sensibles si l'utilisateur décide d'en inclure dans ses cours ou ses révisions. L'extension ne recherche pas spécialement de telles informations.

## 3. Où vont les données ?

**L'extension n'envoie pas les cartes, les notes Anki ni les préférences à un serveur exploité par son développeur.**

Les échanges avec AnkiConnect utilisent une connexion HTTP locale vers **127.0.0.1** (sur le port configuré ou détecté). Ces échanges servent exclusivement aux opérations demandées ou nécessaires à leur préparation : consultation des paquets et notes, comparaison, importation et mise à jour confirmée de notes.

Les préférences sont conservées dans le stockage local du navigateur (`chrome.storage.local`). Les cartes importées ou mises à jour sont enregistrées dans la collection Anki de l'utilisateur.

L'extension ne contient **aucune télémétrie, publicité ou fonctionnalité de suivi analytique** et ne vend pas les données des utilisateurs.

## 4. Partage avec des tiers et services distincts

Aucune donnée n'est transmise par l'extension à un service distant tiers pour son propre fonctionnement.

L'utilisateur emploie toutefois des services distincts :

- **ChatGPT** : les contenus que l'utilisateur fournit directement à ChatGPT restent soumis aux pratiques de confidentialité d'OpenAI ; l'extension ne contrôle pas ces traitements.
- **Anki / AnkiConnect** : les cartes sont enregistrées localement dans Anki. Si l'utilisateur active séparément la synchronisation AnkiWeb, celle-ci relève du fonctionnement et des conditions d'Anki, et non d'un envoi réalisé par l'extension.

L'extension ne transmet pas de données à des fins publicitaires, de profilage, de solvabilité ou de prêt.

## 5. Conservation et suppression

- **Préférences** : conservées localement dans le profil du navigateur tant que l'utilisateur ne les efface pas.
- **Cartes en cours de traitement** : manipulées dans l'interface et la mémoire de l'extension pour la session ou l'opération en cours ; elles ne sont pas conservées sur un serveur du développeur.
- **Notes importées ou mises à jour** : conservées dans Anki selon les choix de l'utilisateur.

L'utilisateur peut supprimer ses notes directement dans Anki et effacer les données locales de l'extension depuis les paramètres de son navigateur. La désinstallation de l'extension ne supprime pas les cartes déjà enregistrées dans Anki.

Le développeur ne disposant pas de copie serveur de ces données, il ne peut ni les consulter ni les supprimer à distance.

## 6. Autorisations du navigateur

L'extension demande les accès nécessaires à son fonctionnement :

- **`storage`** : mémoriser localement les préférences d'utilisation.
- **`http://127.0.0.1/*`** : communiquer avec AnkiConnect sur l'ordinateur de l'utilisateur, y compris lorsque le port local est configuré différemment.
- **Accès au contenu de `chatgpt.com` et `chat.openai.com`** : détecter les cartes structurées dans les réponses et afficher les commandes d'importation.

Ces accès ne servent pas à collecter des données pour le développeur.

## 7. Évolutions de la politique

Cette politique pourra être modifiée si les fonctionnalités ou les traitements de données de l'extension évoluent. La date figurant en haut de cette page indiquera sa dernière mise à jour. Les déclarations de confidentialité du Chrome Web Store seront adaptées le cas échéant.

## 8. Contact

Pour toute question sur cette politique ou sur les données traitées par l'extension, contactez le mainteneur depuis le [dépôt GitHub de Cartes vers Anki](https://github.com/pyxl-dev/cartes-vers-anki/issues).

Cette politique concerne **Cartes vers Anki** uniquement, et non les services ChatGPT, Anki ou AnkiWeb.
