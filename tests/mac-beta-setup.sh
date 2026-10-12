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

# Dépôt publié SANS le dossier macos/ : cas de la branche principale avant que
# le kit n'y soit publié.
make_fixture_nokit() {
  rm -rf "$FIXTURE" "$ORIGIN_BARE"
  mkdir -p "$FIXTURE/extension"
  printf '# Fixture sans kit\n' > "$FIXTURE/README.md"
  printf '{ "manifest_version": 3, "name": "Cartes vers Anki", "version": "1.4.0", "permissions": ["storage"] }\n' > "$FIXTURE/extension/manifest.json"
  git -C "$FIXTURE" init -q
  git -C "$FIXTURE" symbolic-ref HEAD refs/heads/main
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" -c user.name=fixture -c user.email=fixture commit -q -m "fixture sans kit"
  git clone -q --bare "$FIXTURE" "$ORIGIN_BARE"
}

bump_fixture_to() {  printf '{ "manifest_version": 3, "name": "Cartes vers Anki", "version": "%s", "permissions": ["storage"] }\n' "$1" > "$FIXTURE/extension/manifest.json"
  git -C "$FIXTURE" add -A
  git -C "$FIXTURE" -c user.name=fixture -c user.email=fixture commit -q -m "fixture $1"
  git -C "$FIXTURE" push -q origin main
}

# ---------------------------------------------------------------------------
# Lanceurs : environnement entièrement redirigé vers le bac à sable.
# ---------------------------------------------------------------------------
run_installer() {
  target="${1:-$INSTALL}"
  CVA_HOME="$HOME_SB" \
  CVA_REPO_URL="file://$ORIGIN_BARE" \
  CVA_INSTALL_DIR="$target" \
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
if [ -f "$INSTALL/.git/shallow" ]; then ok "installation : clone réellement superficiel (--depth 1)"; else ko "installation : clone réellement superficiel" "pas de .git/shallow : le test ne couvrirait pas le cas réel"; fi
if [ -L "$DESKTOP_SB/Mettre à jour Cartes vers Anki.command" ]; then ok "raccourci Bureau créé (lien)"; else ko "raccourci Bureau créé" "absent"; fi
LINK_T="$(readlink "$DESKTOP_SB/Mettre à jour Cartes vers Anki.command" 2>/dev/null || true)"
if [ "$LINK_T" = "$INSTALL/macos/Mettre à jour Cartes vers Anki.command" ]; then ok "raccourci : délègue au script installé"; else ko "raccourci : délègue au script installé" "cible « $LINK_T »"; fi
if printf '%s' "$OUT" | grep -q "Charger l'extension non empaquetée"; then ok "installation : instructions navigateur affichées"; else ko "installation : instructions navigateur affichées" "texte absent"; fi
if printf '%s' "$OUT" | grep -q "1.4.0"; then ok "installation : version affichée"; else ko "installation : version affichée" "texte absent"; fi
# Aucun accès au vrai dossier personnel : on compare l'état réel AVANT et APRÈS
# l'ensemble des tests. Une installation réelle préexistante ne fait donc plus
# échouer la suite, alors qu'une écriture provoquée par les tests la ferait
# échouer immédiatement.
real_snapshot() {
  { ls -l "$REAL_HOME/Applications" 2>/dev/null; ls -l "$REAL_HOME/Desktop" 2>/dev/null; } | md5 -q 2>/dev/null || echo "indisponible"
}
REAL_BEFORE="$(real_snapshot)"

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

# --- 5bis. Clone superficiel, plusieurs commits d'avance -----------------
echo
echo "--- 5bis. Clone superficiel : plusieurs commits d'avance ---"
bump_fixture_to "1.4.3"
bump_fixture_to "1.4.4"
bump_fixture_to "1.4.5"
OUT="$(run_updater)"; CODE=$?
if [ "$CODE" -eq 0 ]; then ok "superficiel : avance de plusieurs commits acceptée"; else ko "superficiel : avance de plusieurs commits acceptée" "code $CODE — $OUT"; fi
if [ "$(installed_version)" = "1.4.5" ]; then ok "superficiel : version finale atteinte"; else ko "superficiel : version finale atteinte" "obtenu « $(installed_version) »"; fi
if [ -f "$INSTALL/.git/shallow" ]; then ok "superficiel : clone toujours superficiel après mise à jour"; else ko "superficiel : clone toujours superficiel" "profondeur modifiée sans raison"; fi

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
# Motifs de contrôle assemblés à l'exécution : ce fichier ne doit pas se
# détecter lui-même, comme le fait déjà tests/audit-anti-leak.sh.
S='/'
HOME_RE="${S}Users${S}[A-Za-z]"
MAIL_RE="[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"
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
if grep -qE "${HOME_RE}|${MAIL_RE}" "$INSTALLER" "$UPDATER"; then
  ko "aucun chemin ni courriel personnel dans le kit" "motif trouvé"
else
  ok "aucun chemin ni courriel personnel dans le kit"
fi
if grep -q "ff-only" "$UPDATER"; then ok "mise à jour en avance rapide uniquement (--ff-only)"; else ko "mise à jour en avance rapide uniquement (--ff-only)" "absent"; fi

# --- 12. Dépôt publié sans le kit ---------------------------------------
echo
echo "--- 12. Dépôt publié sans le kit (avant publication) ---"
make_fixture_nokit
INSTALL_SANS="$HOME_SB/Applications/Sans kit"
LINK_SANS="$DESKTOP_SB/Mettre à jour Cartes vers Anki.command"
rm -f "$LINK_SANS"
OUT="$(run_installer "$INSTALL_SANS")"; CODE=$?
if [ "$CODE" -eq 0 ]; then ok "dépôt sans kit : installation aboutie"; else ko "dépôt sans kit : installation aboutie" "code $CODE — $OUT"; fi
if [ -f "$INSTALL_SANS/extension/manifest.json" ]; then ok "dépôt sans kit : extension bien installée"; else ko "dépôt sans kit : extension bien installée" "extension absente"; fi
if [ -e "$LINK_SANS" ]; then ko "dépôt sans kit : aucun raccourci cassé" "raccourci créé vers un script absent"; else ok "dépôt sans kit : aucun raccourci cassé"; fi
if printf '%s' "$OUT" | grep -q "ne contient pas encore le script"; then ok "dépôt sans kit : explication claire"; else ko "dépôt sans kit : explication claire" "$OUT"; fi

# --- 13. Guide d'installation macOS (HTML statique) ----------------------
echo
echo "--- 13. Guide d'installation macOS ---"
GUIDE="$REPO_DIR/00 - INSTALLER SUR MAC.html"
if [ -f "$GUIDE" ]; then ok "guide : présent à la racine du dossier"; else ko "guide : présent à la racine du dossier" "fichier absent"; fi
for kw in "Terminé" "Placer dans la corbeille" "Confidentialité et sécurité" "Ouvrir quand même" "github.com/pyxl-dev/cartes-vers-anki" "Mode développeur" "Charger l'extension non empaquetée" "2055492159"; do
  if grep -qF "$kw" "$GUIDE" 2>/dev/null; then ok "guide : mentionne « $kw »"; else ko "guide : mentionne « $kw »" "absent"; fi
done
if grep -qE "xattr[[:space:]]+-d|spctl[[:space:]]+(--master-disable|disable)|sudo " "$GUIDE" 2>/dev/null; then
  ko "guide : aucune recommandation de contournement" "$(grep -nE 'xattr[[:space:]]+-d|spctl[[:space:]]+(--master-disable|disable)|sudo ' "$GUIDE" | head -2)"
else
  ok "guide : aucune recommandation de contournement"
fi
if grep -qE "<script|src=[\"']https?://|@import|url\(https?://" "$GUIDE" 2>/dev/null; then
  ko "guide : aucun script ni ressource distante" "$(grep -nE '<script|src=["'"'"']https?://|@import|url\(https?://' "$GUIDE" | head -2)"
else
  ok "guide : aucun script ni ressource distante"
fi
if head -1 "$GUIDE" | grep -qi "<!DOCTYPE html>" && grep -qi '<html lang="fr"' "$GUIDE" && grep -qi "</html>" "$GUIDE"; then
  ok "guide : HTML statique bien formé"
else
  ko "guide : HTML statique bien formé" "structure inattendue"
fi
for rel in "macos/LISEZ-MOI.md" "macos/NOTARISATION.md"; do
  if grep -qF "$rel" "$GUIDE" 2>/dev/null && [ -f "$REPO_DIR/$rel" ]; then ok "guide : lien relatif vers $rel"; else ko "guide : lien relatif vers $rel" "lien ou cible manquant"; fi
done
for doc in "$REPO_DIR/README.md" "$MACOS_DIR/LISEZ-MOI.md"; do
  if grep -qF "00%20-%20INSTALLER%20SUR%20MAC.html" "$doc" 2>/dev/null; then ok "lien vers le guide dans $(basename "$doc")"; else ko "lien vers le guide dans $(basename "$doc")" "absent"; fi
done
if [ -f "$MACOS_DIR/NOTARISATION.md" ] && grep -q "notarytool" "$MACOS_DIR/NOTARISATION.md" && grep -q "Developer ID" "$MACOS_DIR/NOTARISATION.md"; then
  ok "note de notarisation présente et utile"
else
  ko "note de notarisation présente et utile" "absente ou incomplète"
fi
if grep -qE "clic droit sur le fichier → \*\*Ouvrir\*\* → \*\*Ouvrir\*\*" "$REPO_DIR/README.md" 2>/dev/null; then
  ko "README : ne promet plus le clic droit → Ouvrir" "formulation encore présente"
else
  ok "README : ne promet plus le clic droit → Ouvrir"
fi
if grep -qE "Réglages Système|Confidentialité et sécurité" "$REPO_DIR/README.md" 2>/dev/null; then
  ok "README : parcours officiel macOS en évidence"
else
  ko "README : parcours officiel macOS en évidence" "absent"
fi

# --- 14. Le vrai dossier personnel n'a pas bougé --------------------------
echo
echo "--- 14. Intégrité du vrai dossier personnel ---"
REAL_AFTER="$(real_snapshot)"
if [ "$REAL_BEFORE" = "$REAL_AFTER" ]; then
  ok "aucune écriture dans le vrai dossier personnel pendant les tests"
else
  ko "aucune écriture dans le vrai dossier personnel pendant les tests" "état modifié : Applications ou Bureau"
fi

echo
echo "bac à sable supprimé : $SB"
echo "Résultat : $PASS réussis, $FAIL échoués"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
