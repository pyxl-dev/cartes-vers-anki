#!/bin/bash
#
#  Tests du kit bêta macOS — Cartes vers Anki
#  -----------------------------------------
#  Tout se passe dans un bac à sable jetable : HOME temporaire, dépôt Git de
#  test local, Bureau temporaire. Le vrai dossier personnel de l'utilisateur
#  n'est jamais écrit, et aucun raccourci réel n'est créé sur le Bureau.
#
#  Usage : bash tests/mac-beta-setup.sh
#

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$HERE/.." && pwd)"
MACOS_DIR="$REPO_DIR/macos"
INSTALLER="$MACOS_DIR/Installer Cartes vers Anki.command"
UPDATER="$MACOS_DIR/Mettre à jour Cartes vers Anki.command"
REAL_HOME="$HOME"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
ko() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n      -> %s\n' "$1" "$2"; }

SB="$(mktemp -d "${TMPDIR:-/tmp}/cva-beta-tests-XXXXXX")" || exit 1
cleanup() { rm -rf "$SB"; }
trap cleanup EXIT

HOME_SB="$SB/home"
DESKTOP_SB="$HOME_SB/Desktop"
FIXTURE="$SB/fixture"
ORIGIN_BARE="$SB/origin.git"
INSTALL="$HOME_SB/Applications/Cartes vers Anki Beta"
mkdir -p "$DESKTOP_SB"

# ---------------------------------------------------------------------------
# Dépôt Git de test : un dépôt « source » puis sa copie nue, clonable.
# ---------------------------------------------------------------------------
make_fixture() {
  rm -rf "$FIXTURE" "$ORIGIN_BARE"
  mkdir -p "$FIXTURE/extension" "$FIXTURE/macos"
  cp "$MACOS_DIR/"*.command "$FIXTURE/macos/"
  printf '# Fixture de test\n' > "$FIXTURE/README.md"
  printf '.DS_Store\n' > "$FIXTURE/.gitignore"
  printf '// extension factice pour les tests\n' > "$FIXTURE/extension/content.js"
  printf '{ "manifest_version": 3, "name": "Cartes vers Anki", "version": "1.4.0", "permissions": ["storage"] }\n' > "$FIXTURE/extension/manifest.json"
  git -C "$FIXTURE" init -q
  git -C "$FIXTURE" symbolic-ref HEAD refs/heads/main
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" -c user.name=fixture -c user.email=fixture commit -q -m "fixture 1.4.0"
  git clone -q --bare "$FIXTURE" "$ORIGIN_BARE"
  git -C "$FIXTURE" remote add origin "$ORIGIN_BARE" 2>/dev/null || true
}

bump_fixture_to() {
  printf '{ "manifest_version": 3, "name": "Cartes vers Anki", "version": "%s", "permissions": ["storage"] }\n' "$1" > "$FIXTURE/extension/manifest.json"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" -c user.name=fixture -c user.email=fixture commit -q -m "fixture $1"
  git -C "$FIXTURE" push -q origin main
}

# ---------------------------------------------------------------------------
# Lanceurs : environnement entièrement redirigé vers le bac à sable.
# ---------------------------------------------------------------------------
run_installer() {
  CVA_HOME="$HOME_SB" \
  CVA_REPO_URL="file://$ORIGIN_BARE" \
  CVA_INSTALL_DIR="$INSTALL" \
  CVA_DESKTOP_DIR="$DESKTOP_SB" \
  CVA_NO_PROMPT=1 CVA_SKIP_OPEN=1 \
  bash "$INSTALLER" 2>&1
  return $?
}

run_updater() {
  CVA_HOME="$HOME_SB" \
  CVA_REPO_URL="file://$ORIGIN_BARE" \
  CVA_NO_PROMPT=1 CVA_SKIP_OPEN=1 \
  bash "$INSTALL/macos/Mettre à jour Cartes vers Anki.command" 2>&1
  return $?
}

installed_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALL/extension/manifest.json" 2>/dev/null | head -n 1
}

echo "=== Kit bêta macOS : tests ==="
echo "bac à sable : $SB"
echo

# --- 1. Syntaxe et droits -------------------------------------------------
echo "--- 1. Syntaxe et droits ---"
for f in "$INSTALLER" "$UPDATER"; do
  if bash -n "$f" 2>/dev/null; then ok "syntaxe bash : $(basename "$f")"; else ko "syntaxe bash : $(basename "$f")" "$(bash -n "$f" 2>&1 | head -2)"; fi
  if [ -x "$f" ]; then ok "exécutable : $(basename "$f")"; else ko "exécutable : $(basename "$f")" "bit x absent"; fi
done
if command -v shasum >/dev/null 2>&1; then
  if bash -n "$UPDATER" 2>/dev/null && [ "$(head -1 "$UPDATER")" = "#!/bin/bash" ]; then ok "shebang /bin/bash"; else ko "shebang /bin/bash" "shebang inattendu"; fi
fi

# --- 2. Première installation --------------------------------------------
echo
echo "--- 2. Première installation ---"
make_fixture
OUT="$(run_installer)"; CODE=$?
if [ "$CODE" -eq 0 ]; then ok "installation : code de sortie 0"; else ko "installation : code de sortie 0" "code $CODE — $OUT"; fi
if [ -d "$INSTALL/.git" ]; then ok "installation : copie clonée"; else ko "installation : copie clonée" "$INSTALL absent"; fi
if [ -f "$INSTALL/extension/manifest.json" ]; then ok "installation : extension présente"; else ko "installation : extension présente" "manifeste absent"; fi
if [ "$(installed_version)" = "1.4.0" ]; then ok "installation : version lue (1.4.0)"; else ko "installation : version lue" "obtenu « $(installed_version) »"; fi
if [ -x "$INSTALL/macos/Mettre à jour Cartes vers Anki.command" ]; then ok "installation : script de MAJ exécutable"; else ko "installation : script de MAJ exécutable" "bit x absent"; fi
if [ -L "$DESKTOP_SB/Mettre à jour Cartes vers Anki.command" ]; then ok "raccourci Bureau créé (lien)"; else ko "raccourci Bureau créé" "absent"; fi
LINK_T="$(readlink "$DESKTOP_SB/Mettre à jour Cartes vers Anki.command" 2>/dev/null || true)"
if [ "$LINK_T" = "$INSTALL/macos/Mettre à jour Cartes vers Anki.command" ]; then ok "raccourci : délègue au script installé"; else ko "raccourci : délègue au script installé" "cible « $LINK_T »"; fi
if printf '%s' "$OUT" | grep -q "Charger l'extension non empaquetée"; then ok "installation : instructions navigateur affichées"; else ko "installation : instructions navigateur affichées" "texte absent"; fi
if printf '%s' "$OUT" | grep -q "1.4.0"; then ok "installation : version affichée"; else ko "installation : version affichée" "texte absent"; fi
# Aucun accès au vrai dossier personnel
if [ ! -e "$REAL_HOME/Applications/Cartes vers Anki Beta" ]; then ok "aucune écriture dans le vrai dossier Applications"; else ko "aucune écriture dans le vrai dossier Applications" "chemin réel créé"; fi

# --- 3. Réinstallation idempotente ---------------------------------------
echo
echo "--- 3. Réinstallation (idempotente) ---"
OUT="$(run_installer)"; CODE=$?
if [ "$CODE" -eq 0 ]; then ok "réinstallation : code de sortie 0"; else ko "réinstallation : code de sortie 0" "code $CODE — $OUT"; fi
if [ -d "$INSTALL/.git" ] && [ "$(installed_version)" = "1.4.0" ]; then ok "réinstallation : copie intacte"; else ko "réinstallation : copie intacte" "version « $(installed_version) »"; fi
if printf '%s' "$OUT" | grep -q "Déjà à jour"; then ok "réinstallation : signalée comme déjà à jour"; else ko "réinstallation : signalée comme déjà à jour" "$OUT"; fi
if [ "$(find "$HOME_SB/Applications" -maxdepth 1 -mindepth 1 | wc -l | tr -d ' ')" = "1" ]; then ok "réinstallation : une seule copie"; else ko "réinstallation : une seule copie" "plusieurs dossiers"; fi

# --- 4. Mise à jour depuis une nouvelle version --------------------------
echo
echo "--- 4. Mise à jour vers une nouvelle version ---"
bump_fixture_to "1.4.2"
OUT="$(run_updater)"; CODE=$?
if [ "$CODE" -eq 0 ]; then ok "mise à jour : code de sortie 0"; else ko "mise à jour : code de sortie 0" "code $CODE — $OUT"; fi
if [ "$(installed_version)" = "1.4.2" ]; then ok "mise à jour : nouvelle version installée"; else ko "mise à jour : nouvelle version installée" "obtenu « $(installed_version) »"; fi
if printf '%s' "$OUT" | grep -q "1.4.0" && printf '%s' "$OUT" | grep -q "1.4.2"; then ok "mise à jour : versions avant/après affichées"; else ko "mise à jour : versions avant/après affichées" "$OUT"; fi
if printf '%s' "$OUT" | grep -q "Actualiser"; then ok "mise à jour : rappel du bouton Actualiser"; else ko "mise à jour : rappel du bouton Actualiser" "texte absent"; fi

# --- 5. Déjà à jour ------------------------------------------------------
echo
echo "--- 5. Déjà à jour ---"
OUT="$(run_updater)"; CODE=$?
if [ "$CODE" -eq 0 ] && printf '%s' "$OUT" | grep -q "Déjà à jour"; then ok "déjà à jour : message explicite"; else ko "déjà à jour : message explicite" "code $CODE — $OUT"; fi

# --- 6. Modifications locales refusées -----------------------------------
echo
echo "--- 6. Modifications locales refusées ---"
printf '\n// retouche locale\n' >> "$INSTALL/extension/content.js"
OUT="$(run_updater)"; CODE=$?
if [ "$CODE" -ne 0 ]; then ok "modification locale : mise à jour refusée"; else ko "modification locale : mise à jour refusée" "code 0 inattendu"; fi
if printf '%s' "$OUT" | grep -q "modifiés dans la copie locale"; then ok "modification locale : message lisible"; else ko "modification locale : message lisible" "$OUT"; fi
if grep -q "retouche locale" "$INSTALL/extension/content.js"; then ok "modification locale : fichier préservé"; else ko "modification locale : fichier préservé" "fichier écrasé"; fi
git -C "$INSTALL" checkout -q -- extension/content.js

# --- 7. Origine incorrecte refusée ---------------------------------------
echo
echo "--- 7. Origine incorrecte refusée ---"
git -C "$INSTALL" remote set-url origin "file://$SB/autre-depot.git"
OUT="$(run_updater)"; CODE=$?
if [ "$CODE" -ne 0 ]; then ok "origine incorrecte : refusée"; else ko "origine incorrecte : refusée" "code 0 inattendu"; fi
if printf '%s' "$OUT" | grep -q "dépôt officiel"; then ok "origine incorrecte : message lisible"; else ko "origine incorrecte : message lisible" "$OUT"; fi
git -C "$INSTALL" remote set-url origin "file://$ORIGIN_BARE"

# --- 8. Mauvaise branche refusée -----------------------------------------
echo
echo "--- 8. Mauvaise branche refusée ---"
git -C "$INSTALL" checkout -q -b essai-local
OUT="$(run_updater)"; CODE=$?
if [ "$CODE" -ne 0 ]; then ok "mauvaise branche : refusée"; else ko "mauvaise branche : refusée" "code 0 inattendu"; fi
if printf '%s' "$OUT" | grep -q "branche"; then ok "mauvaise branche : message lisible"; else ko "mauvaise branche : message lisible" "$OUT"; fi
if [ "$(git -C "$INSTALL" rev-parse --abbrev-ref HEAD)" = "essai-local" ]; then ok "mauvaise branche : aucun changement de branche forcé"; else ko "mauvaise branche : aucun changement de branche forcé" "branche modifiée"; fi
git -C "$INSTALL" checkout -q main

# --- 9. Chemins contenant des espaces ------------------------------------
echo
echo "--- 9. Espaces dans les chemins ---"
if [ -f "$INSTALL/extension/manifest.json" ] && [ -d "$HOME_SB/Applications/Cartes vers Anki Beta" ]; then
  ok "chemin avec espaces : installé correctement"
else
  ko "chemin avec espaces : installé correctement" "chemin introuvable"
fi
OUT="$(run_updater)"; CODE=$?
if [ "$CODE" -eq 0 ]; then ok "chemin avec espaces : mise à jour fonctionnelle"; else ko "chemin avec espaces : mise à jour fonctionnelle" "code $CODE"; fi

# --- 10. Absence de git ---------------------------------------------------
echo
echo "--- 10. git absent ---"
BIN_SB="$SB/bin"
mkdir -p "$BIN_SB"
for c in sh bash uname sed head grep dirname basename printf pwd mkdir ln chmod cat readlink ls sort tr awk env test rm mv cp find cut wc open; do
  p="$(command -v "$c" 2>/dev/null || true)"
  [ -n "$p" ] && ln -s "$p" "$BIN_SB/$c" 2>/dev/null
done
OUT="$(PATH="$BIN_SB" CVA_HOME="$HOME_SB" CVA_REPO_URL="file://$ORIGIN_BARE" \
  CVA_INSTALL_DIR="$SB/home/Applications/Autre copie" CVA_DESKTOP_DIR="$DESKTOP_SB" \
  CVA_NO_PROMPT=1 CVA_SKIP_OPEN=1 bash "$INSTALLER" 2>&1)"; CODE=$?
if [ "$CODE" -ne 0 ]; then ok "git absent : arrêt propre"; else ko "git absent : arrêt propre" "code 0 inattendu"; fi
if printf '%s' "$OUT" | grep -q "xcode-select --install"; then ok "git absent : explique Xcode Command Line Tools"; else ko "git absent : explique Xcode Command Line Tools" "$OUT"; fi
if printf '%s' "$OUT" | grep -qi "sudo"; then ko "git absent : aucun sudo proposé" "sudo mentionné"; else ok "git absent : aucun sudo proposé"; fi

# --- 11. Garde-fous du kit -----------------------------------------------
echo
echo "--- 11. Garde-fous du kit ---"
if grep -qE "curl[^|]*\|[[:space:]]*bash|wget[^|]*\|[[:space:]]*bash" "$INSTALLER" "$UPDATER"; then
  ko "aucun « curl | bash »" "motif trouvé"
else
  ok "aucun « curl | bash »"
fi
if grep -qE "sudo|spctl|--master-disable|reset --hard|push --force|clean -" "$INSTALLER" "$UPDATER"; then
  ko "aucune commande destructive ou privilégiée" "$(grep -nE 'sudo|spctl|--master-disable|reset --hard|push --force|clean -' "$INSTALLER" "$UPDATER" | head -3)"
else
  ok "aucune commande destructive ou privilégiée"
fi
if grep -qE "127\.0\.0\.1|localhost|notesInfo|updateNoteFields|findNotes|addNote|deckNames|canAddNotes" "$INSTALLER" "$UPDATER"; then
  ko "aucun appel AnkiConnect dans le kit" "$(grep -nE '127\.0\.0\.1|localhost|notesInfo|updateNoteFields|findNotes|addNote|deckNames|canAddNotes' "$INSTALLER" "$UPDATER" | head -3)"
else
  ok "aucun appel AnkiConnect dans le kit"
fi
# Le kit ne doit jamais MODIFIER Anki : aucune action d'écriture, même indirecte.
if grep -qE "addNote|addNotes|deleteNotes|deleteDecks|changeDeck|updateNoteFields|storeMediaFile|removeNotes|deleteCards|createDeck" "$INSTALLER" "$UPDATER"; then
  ko "aucune mutation Anki dans le kit" "$(grep -nE 'addNote|addNotes|deleteNotes|deleteDecks|changeDeck|updateNoteFields|storeMediaFile|removeNotes|deleteCards|createDeck' "$INSTALLER" "$UPDATER" | head -3)"
else
  ok "aucune mutation Anki dans le kit"
fi
# Aucun accès réseau, même local : le kit ne fait que parler à git.
if grep -qE "127\.0\.0\.1|localhost|:8765|:8766|curl |wget |ncat |/dev/tcp/" "$INSTALLER" "$UPDATER"; then
  ko "aucun accès réseau local dans le kit" "$(grep -nE '127\.0\.0\.1|localhost|:8765|:8766|curl |wget |ncat |/dev/tcp/' "$INSTALLER" "$UPDATER" | head -3)"
else
  ok "aucun accès réseau local dans le kit"
fi
if grep -qE "/Users/[A-Za-z]|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}" "$INSTALLER" "$UPDATER"; then
  ko "aucun chemin ni courriel personnel dans le kit" "motif trouvé"
else
  ok "aucun chemin ni courriel personnel dans le kit"
fi
if grep -q "ff-only" "$UPDATER"; then ok "mise à jour en avance rapide uniquement (--ff-only)"; else ko "mise à jour en avance rapide uniquement (--ff-only)" "absent"; fi

echo
echo "bac à sable supprimé : $SB"
echo "Résultat : $PASS réussis, $FAIL échoués"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
