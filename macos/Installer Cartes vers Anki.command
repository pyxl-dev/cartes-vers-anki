#!/bin/bash
#
#  Cartes vers Anki — installation initiale sur macOS
#  -------------------------------------------------
#  Double-clique ce fichier dans le Finder, puis suis les instructions.
#
#  Ce script télécharge une copie PERMANENTE de l'extension depuis le dépôt
#  public officiel, puis explique comment la charger dans Brave ou Chrome.
#
#  Il ne touche NI à Anki, NI à ta collection, NI à tes notes : aucun accès
#  réseau vers un autre service, aucun envoi de données.
#
#  Compatible avec le Bash 3.2 fourni par macOS.
#

set -u

# ---------------------------------------------------------------------------
# Réglages. Les variables d'environnement CVA_* servent aux tests automatisés ;
# en usage normal, tu n'as rien à définir.
# ---------------------------------------------------------------------------
HOME_DIR="${CVA_HOME:-$HOME}"
REPO_URL="${CVA_REPO_URL:-https://github.com/pyxl-dev/cartes-vers-anki.git}"
INSTALL_DIR="${CVA_INSTALL_DIR:-$HOME_DIR/Applications/Cartes vers Anki Beta}"
DESKTOP_DIR="${CVA_DESKTOP_DIR:-$HOME_DIR/Desktop}"
NO_PROMPT="${CVA_NO_PROMPT:-0}"
SKIP_OPEN="${CVA_SKIP_OPEN:-0}"
UPDATER_NAME="Mettre à jour Cartes vers Anki.command"

say()   { printf '%s\n' "$*"; }
blank() { printf '\n'; }

pause_end() {
  if [ "$NO_PROMPT" = "1" ]; then return 0; fi
  blank
  printf 'Appuie sur Entrée pour fermer cette fenêtre… '
  read -r _ || true
}

die() {
  blank
  say "❌ $*"
  pause_end
  exit 1
}

# Lit la version déclarée dans le manifeste de l'extension (sans jq).
manifest_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/extension/manifest.json" 2>/dev/null | head -n 1
}

# Ouvre brave://extensions si Brave est installé ; ne casse rien sinon.
open_extensions_page() {
  if [ "$SKIP_OPEN" = "1" ]; then return 0; fi
  if [ -d "/Applications/Brave Browser.app" ] || [ -d "$HOME_DIR/Applications/Brave Browser.app" ]; then
    say "Ouverture de Brave sur la page des extensions…"
    open -a "Brave Browser" "brave://extensions" >/dev/null 2>&1 || true
  else
    say "Brave n'a pas été trouvé : ouvre-le toi-même, puis va sur brave://extensions"
    say "(ou chrome://extensions si tu utilises Chrome)."
  fi
}

blank
say "==================================================="
say "  Cartes vers Anki — installation (macOS)"
say "==================================================="
blank

# ---------------------------------------------------------------------------
# 1. Vérifications d'environnement
# ---------------------------------------------------------------------------
if [ "$(uname -s)" != "Darwin" ]; then
  die "Ce script est prévu pour macOS."
fi

if ! command -v git >/dev/null 2>&1; then
  blank
  say "❌ git n'est pas installé sur cet ordinateur."
  blank
  say "git sert uniquement à télécharger l'extension et à la mettre à jour."
  say "Pour l'installer, ouvre le Terminal et lance :"
  blank
  say "    xcode-select --install"
  blank
  say "Une fenêtre d'Apple s'ouvre : accepte, laisse l'installation se faire,"
  say "puis relance ce fichier. Rien n'est installé sans ton accord."
  pause_end
  exit 1
fi

say "Téléchargement depuis : $REPO_URL"
say "Dossier d'installation : $INSTALL_DIR"
blank

# ---------------------------------------------------------------------------
# 2. Installation (ou mise à jour si la copie existe déjà)
# ---------------------------------------------------------------------------
if [ -e "$INSTALL_DIR" ]; then
  if [ ! -d "$INSTALL_DIR/.git" ]; then
    blank
    say "❌ Un dossier existe déjà ici :"
    say "   $INSTALL_DIR"
    say "   Ce n'est pas une copie de Cartes vers Anki."
    blank
    say "Rien n'a été modifié ni supprimé. Déplace ou renomme ce dossier,"
    say "puis relance ce fichier."
    pause_end
    exit 1
  fi

  ORIGIN_NOW="$(git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || true)"
  if [ "$ORIGIN_NOW" != "$REPO_URL" ]; then
    blank
    say "❌ La copie déjà présente vient d'une autre source :"
    say "   $ORIGIN_NOW"
    blank
    say "Attendu : $REPO_URL"
    say "Rien n'a été modifié ni supprimé."
    pause_end
    exit 1
  fi

  say "Une copie existe déjà : mise à jour au lieu d'une nouvelle installation."
  blank
  CVA_NO_PROMPT=1 CVA_HOME="$HOME_DIR" CVA_REPO_URL="$REPO_URL" \
    CVA_SKIP_OPEN=1 bash "$INSTALL_DIR/macos/$UPDATER_NAME"
  if [ $? -ne 0 ]; then
    die "La mise à jour de la copie existante a échoué. Rien n'a été supprimé."
  fi
else
  mkdir -p "$(dirname "$INSTALL_DIR")" || die "Impossible de créer $(dirname "$INSTALL_DIR")."
  say "Téléchargement de l'extension…"
  if ! git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"; then
    blank
    say "❌ Le téléchargement a échoué."
    blank
    say "Vérifie ta connexion Internet, puis relance ce fichier."
    say "Si un dossier incomplet a été créé, tu peux le supprimer toi-même :"
    say "   $INSTALL_DIR"
    pause_end
    exit 1
  fi
  say "Téléchargement terminé."
fi

# Les fichiers .command doivent rester exécutables, même si la copie vient
# d'une archive ZIP (le Finder perd parfois ce droit).
chmod +x "$INSTALL_DIR/macos/"*.command 2>/dev/null || true

VERSION="$(manifest_version "$INSTALL_DIR")"
if [ -z "$VERSION" ]; then
  die "Le dossier téléchargé ne contient pas l'extension attendue. Rien n'a été supprimé."
fi

# ---------------------------------------------------------------------------
# 3. Raccourci « Mettre à jour » sur le Bureau
# ---------------------------------------------------------------------------
TARGET="$INSTALL_DIR/macos/$UPDATER_NAME"
LINK="$DESKTOP_DIR/$UPDATER_NAME"

# La copie installée est clonée depuis la branche principale du dépôt. Tant que
# le kit n'y est pas publié, le script de mise à jour peut être absent : dans ce
# cas on n'installe PAS de raccourci cassé, on l'explique.
if [ ! -f "$TARGET" ]; then
  blank
  say "ℹ️  Cette version publiée du dépôt ne contient pas encore le script de"
  say "    mise à jour : aucun raccourci n'a été créé sur le Bureau."
  say "    La mise à jour restera possible en relançant ce fichier d'installation."
  say "    Ton extension est installée et fonctionnelle."
  blank
  say "Extension installée dans : $INSTALL_DIR/extension"
  pause_end
  exit 0
fi

if [ -d "$DESKTOP_DIR" ]; then
  if [ -L "$LINK" ]; then
    LINK_TARGET="$(readlink "$LINK" 2>/dev/null || true)"
    if [ "$LINK_TARGET" = "$TARGET" ]; then
      say "Raccourci de mise à jour déjà en place sur le Bureau."
    else
      say "Un raccourci du même nom existe déjà sur le Bureau : il n'a pas été modifié."
    fi
  elif [ -e "$LINK" ]; then
    say "Un fichier nommé « $UPDATER_NAME » existe déjà sur le Bureau : il n'a pas été modifié."
  else
    # Lien symbolique : le raccourci suit automatiquement les futures mises à jour
    # du script, sans recopier de fichier.
    if ln -s "$TARGET" "$LINK" 2>/dev/null; then
      say "Raccourci « $UPDATER_NAME » ajouté sur le Bureau."
    else
      # Repli : un tout petit lanceur qui délègue au script installé.
      printf '#!/bin/bash\nexec "%s"\n' "$TARGET" > "$LINK" 2>/dev/null && chmod +x "$LINK" 2>/dev/null \
        && say "Raccourci « $UPDATER_NAME » ajouté sur le Bureau." \
        || say "Le raccourci du Bureau n'a pas pu être créé (autorisation refusée)."
    fi
  fi
else
  say "Pas de dossier Bureau accessible : le raccourci n'a pas été créé."
fi

if [ ! -e "$LINK" ]; then
  say "Le script de mise à jour reste disponible ici :"
  say "   $TARGET"
fi

# ---------------------------------------------------------------------------
# 4. Mode d'emploi
# ---------------------------------------------------------------------------
blank
say "==================================================="
say "  Installation terminée — version $VERSION"
say "==================================================="
blank
say "Il reste 3 étapes dans Brave (ou Chrome) :"
blank
say "  1. Ouvre la page des extensions : brave://extensions"
say "  2. Active « Mode développeur » (interrupteur en haut à droite)."
say "  3. Clique « Charger l'extension non empaquetée » et choisis :"
blank
say "       $INSTALL_DIR/extension"
blank
say "Ensuite : ouvre Anki, puis ChatGPT.com. Un bouton « Ajouter N cartes"
say "à Anki » apparaît sous les réponses qui contiennent un bloc JSON."
blank
say "À savoir :"
say "  • Anki Desktop et le greffon AnkiConnect (code 2055492159) sont requis."
say "  • Le port d'AnkiConnect se règle dans le popup de l'extension."
say "  • Tes cartes, paquets et historique de révision ne sont jamais modifiés"
say "    par l'installation."
say "  • Pour les mises à jour : double-clique « $UPDATER_NAME »"
say "    sur le Bureau, puis clique Actualiser (↻) dans brave://extensions."
blank
say "Version installée : $VERSION"
say "Pour les prochaines versions, relance le fichier de mise à jour posé"
say "sur le Bureau : il télécharge les nouveautés sans rien réinstaller."
blank

open_extensions_page
pause_end
exit 0
