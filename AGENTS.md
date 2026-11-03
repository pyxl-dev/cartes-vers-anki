# Instructions for AI agents

You are an AI coding agent (Claude Code, Codex, Cursor...) and your user asked you to install, use or work on **Cartes vers Anki**. This file tells you how. Keep the safety rules at the end: they matter more than the rest.

## What it does

Cartes vers Anki is a Manifest V3 browser extension (Chrome, Brave, Edge). On `chatgpt.com` and `chat.openai.com` it spots a JSON block of flashcards in ChatGPT's answer and adds an "Ajouter N cartes à Anki" button under it. The user reviews and edits the cards in a visual editor, duplicates are flagged before the import (exact ones across the whole collection, close wordings with a local lexical comparison), then the cards are added to the chosen deck of **Anki Desktop** through the **AnkiConnect** add-on on `127.0.0.1` (port 8765, then 8766, or a port set in the popup). No server, no account, no telemetry. The UI and the docs in `docs/` are in French.

Accepted card JSON: `{"cards":[{"type":"basic","front":"Q","back":"A","tags":["x"]},{"type":"cloze","text":"The {{c1::term}} is ...","extra":"Details"}]}`. A bare array is accepted too. Up to 100 cards per import, bigger answers are split into batches. Full format: `docs/GUIDE.md`.

## Install

There is no command-line installer: an extension has to be loaded in the user's browser. Do the parts you can, and ask the user for the rest.

1. Anki Desktop must be installed and the AnkiConnect add-on set up (in Anki: `Tools -> Add-ons -> Get Add-ons`, code `2055492159`, then restart Anki). Check that Anki is open and AnkiConnect answers:
   ```sh
   curl -s 127.0.0.1:8765 -X POST -d '{"action":"version","version":6}'
   ```
   It must print a JSON object with `"result": 6` (use port 8766 if the user changed it). Anki has to stay open during review and import.
2. Extension, published version (recommended, automatic updates): ask the user to install it from the Chrome Web Store: https://chromewebstore.google.com/detail/fhkabgkbnknihhdlmcnkmnbijepclipi
3. Extension, from source (only to test an unpublished version):
   ```sh
   git clone https://github.com/pyxl-dev/cartes-vers-anki
   ```
   Then ask the user to open `chrome://extensions` (or `brave://extensions`), turn on Developer mode, click "Load unpacked" and pick the `extension/` folder of the clone. Keep the clone in a permanent folder. On macOS, the beta kit in `macos/` does the clone and shows these steps (the installer is unsigned: the user has to allow it in System Settings, never work around Gatekeeper).
4. Check: open ChatGPT.com, ask for cards in the JSON format above, the button must appear under the answer. If it does not, the popup (extension icon) has a fallback mode: paste the JSON there.

## Use

1. Anki open, then ChatGPT.com. The popup button "Préparer dans ChatGPT" inserts a ready-made prompt in the input (it never sends it).
2. The user clicks "Ajouter N cartes à Anki", reviews the statuses (new, similar wording, already present), picks or creates the deck, then clicks "Importer".
3. Cards already in Anki are unchecked and never imported again. An existing note is updated only through an explicit checkbox plus a confirmation.

For work on the code:

```sh
node tests/test.cjs            # 244 cases, no browser, fake local AnkiConnect
bash tests/mac-beta-setup.sh   # macOS kit tests, throwaway sandbox
bash tests/audit-anti-leak.sh  # leak audit before publishing
```

Code layout: `docs/DEVELOPPEMENT.md`. Publishing: raise `version` in `extension/manifest.json`, merge to `main`, push a `vX.Y.Z` tag that matches it (`docs/PUBLICATION.md`).

## Safety rules

- Never contact the user's real Anki from tests or scripts you write: use the fake AnkiConnect of `tests/test.cjs`. Never run an Anki action that deletes notes or decks, never change an existing note without the user's explicit confirmation.
- Never set AnkiConnect's `webCorsOriginList` to `["*"]` and keep `webBindAddress` on `127.0.0.1`.
- Keep the extension local: its only network target is `127.0.0.1`. No remote URL, no analytics, no secret in `extension/`. Keep permissions minimal (`storage` and `http://127.0.0.1/*`).
- The text of the user's courses goes to ChatGPT like any message: do not add personal data to prompts or examples.
- Do not bypass macOS Gatekeeper for the user and do not ask for their password.
- The repository is public: no personal paths, emails or tokens in files. `tests/audit-anti-leak.sh` checks it.
- Publishing to the Chrome Web Store is done by the `v*.*.*` tag workflow only. Do not push a tag without the user's go-ahead.

---

## Project memory (agent-kit)

Existing notes kept as they were. The block below is checked by `agent-memory check`.

# AGENTS.md

Lu au demarrage par Hermes, Codex et Claude Code. Ce fichier contient ce que le code ne dit pas.


<!--
Regles de ce fichier, verifiees par `agent-memory check` :

1. Une cle, une valeur. Pour changer un fait, tu remplaces sa ligne. Tu n'en ajoutes
   jamais une seconde : c'est ce qui empeche deux faits contradictoires de coexister.
2. Une ligne n'entre ici que si elle evite un echec constate. Si un linter, un test ou
   un hook peut porter la regle, elle va la-bas et la ligne disparait d'ici.
3. Jamais d'historique, jamais de journal, jamais de secret, jamais de description de
   l'arborescence ou du style : le code et le linter le disent mieux.
4. Si ce fichier contredit le code, le code gagne. Corrige ici dans le meme commit.
-->

<!-- agent-kit:checked:begin -->
# AGENTS.md

A lire au demarrage. Les faits de ce fichier sont ceux que le code ne montre pas.

## Verifie

Test: `node tests/test.cjs   (244 cas)`
Fini: `node tests/test.cjs` sans echec et `bash tests/audit-anti-leak.sh` propre
Interdit: joindre un vrai Anki depuis les tests (faux AnkiConnect local seulement), toute action Anki destructive, toute URL distante ou tout secret dans `extension/`

## Pieges

- piege: la version de `extension/manifest.json` doit etre strictement superieure a celle publiee, sinon le Chrome Web Store refuse l envoi
- piege: la detection du bouton depend du DOM de ChatGPT.com (`[data-dil-source-message-id]`, `[data-user-message-bubble]`, `[data-message-author-role]` en secours) ; le popup reste le mode de secours

## Decisions

- decision: 100 % local, la seule requete reseau de l extension va vers `127.0.0.1` (AnkiConnect)
<!-- agent-kit:checked:end -->
