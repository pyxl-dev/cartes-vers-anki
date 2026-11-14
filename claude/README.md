# Cartes vers Anki pour Claude Desktop

Extension Claude Desktop (`.mcpb`) : Claude rédige des cartes à partir de ton cours, te les montre, repère celles qui sont déjà dans Anki, puis les ajoute dans le paquet de ton choix après ton accord. Même logique de doublons que l'extension navigateur, mêmes modules (`extension/`).

## Installer

1. Anki Desktop avec le greffon AnkiConnect (Outils > Greffons > Obtenir des greffons, code `2055492159`, puis redémarrer Anki).
2. Claude Desktop : Réglages > Extensions, glisser `cartes-vers-anki.mcpb` dans la fenêtre, puis Installer. Rien d'autre à installer : Claude Desktop fournit Node.
3. Dans une conversation, garder Anki ouvert et demander par exemple « fais-moi 20 cartes Anki sur ce cours ». Le prompt « Créer des cartes Anki depuis un cours » est aussi dans le menu « + ».

Claude Desktop est nécessaire : claude.ai dans le navigateur et l'app mobile ne peuvent pas joindre Anki sur l'ordinateur.

## Outils

| Outil | Écrit dans Anki |
|---|---|
| `anki_status`, `list_decks`, `search_notes` | non |
| `check_cards` : doublons exacts (toute la collection) et formulations proches (paquet visé) | non |
| `add_cards` : ignore toujours les doublons exacts, étiquette `claude` | ajoute |
| `create_deck` | crée un paquet |

Aucun outil ne supprime ni ne modifie une note existante. Seule cible réseau : AnkiConnect sur `127.0.0.1` (8765 puis 8766, ou le port réglé dans l'extension).

## Développer

```sh
cd claude && bun install
node build.mjs                 # dist/cartes-vers-anki.mcpb
node e2e.mjs <port>            # parcours réel contre un Anki de TEST (jamais une vraie collection)
node e2e.mjs <port> <dossier>  # même parcours sur un .mcpb décompressé
```

Anki de test : copier le dossier du greffon AnkiConnect dans `<dossier jetable>/addons21/`, puis `open -n -a Anki --args -b <dossier jetable>`.
