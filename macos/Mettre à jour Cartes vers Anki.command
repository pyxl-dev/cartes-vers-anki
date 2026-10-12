#!/bin/bash
#
#  Cartes vers Anki — mise à jour sur macOS
#  ---------------------------------------
#  Double-clique ce fichier dans le Finder.
#
#  Il met à jour la copie locale de l'extension depuis le dépôt public officiel,
#  puis rappelle comment recharger l'extension dans le navigateur.
#
#  Ce script est volontairement prudent :
#    • il refuse tout ce qui n'est pas le dépôt officiel ;
#    • il refuse si des fichiers ont été modifiés localement ;
#    • il ne fait qu'avancer (merge --ff-only) : jamais de reset, jamais de
#      force, jamais de suppression, jamais de changement de branche.
#
#  Il ne lit aucun contenu médical et ne parle ni à Anki ni à AnkiConnect.
#
#  Compatible avec le Bash 3.2 fourni par macOS.
#

set -u

REPO_URL="${CVA_REPO_URL:-https://github.com/pyxl-dev/cartes-vers-anki.git}"
BRANCH="main"
NO_PROMPT="${CVA_NO_PROMPT:-0}"
SKIP_OPEN="${CVA_SKIP_OPEN:-0}"
HOME_DIR="${CVA_HOME:-$HOME}"

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

manifest_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/extension/manifest.json" 2>/dev/null | head -n 1
}

# Dossier réel de ce script, même s'il est lancé depuis un raccourci du Bureau
# (on suit les liens symboliques jusqu'au fichier réel).
resolve_self_dir() {
  target="$1"
  while [ -L "$target" ]; do
    dir="$(cd -P "$(dirname "$target")" && pwd)"
    link="$(readlink "$target")"
    case "$link" in
      /*) target="$link" ;;
      *)  target="$dir/$link" ;;
    esac
  done
  cd -P "$(dirname "$target")" && pwd
}

open_extensions_page() {
  if [ "$SKIP_OPEN" = "1" ]; then return 0; fi
  if [ -d "/Applications/Brave Browser.app" ] || [ -d "$HOME_DIR/Applications/Brave Browser.app" ]; then
    say "Ouverture de Brave sur la page des extensions…"
    open -a "Brave Browser" "brave://extensions" >/dev/null 2>&1 || true
  else
    say "Ouvre ton navigateur puis va sur brave://extensions (ou chrome://extensions)."
  fi
}

SCRIPT_DIR="$(resolve_self_dir "$0")" || die "Impossible de localiser ce script."
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

blank
say "==================================================="
say "  Cartes vers Anki — mise à jour (macOS)"
say "==================================================="
blank

# ---------------------------------------------------------------------------
# 1. La copie locale est-elle bien celle du dépôt officiel ?
# ---------------------------------------------------------------------------
if [ ! -d "$REPO_DIR/.git" ]; then
  blank
  say "❌ Ce fichier ne se trouve pas dans une copie de Cartes vers Anki."
  say "   Dossier examiné : $REPO_DIR"
  blank
  say "Utilise le raccourci du Bureau, ou relance l'installation."
  pause_end
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  die "git n'est pas installé. Ouvre le Terminal et lance : xcode-select --install"
fi

ORIGIN_NOW="$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)"
if [ "$ORIGIN_NOW" != "$REPO_URL" ]; then
  blank
  say "❌ Cette copie ne vient pas du dépôt officiel :"
  say "   source actuelle : ${ORIGIN_NOW:-aucune}"
  say "   source attendue : $REPO_URL"
  blank
  say "Rien n'a été modifié ni supprimé."
  pause_end
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Branche et propreté de la copie locale
# ---------------------------------------------------------------------------
CURRENT_BRANCH="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  blank
  say "❌ La copie n'est pas sur la branche « $BRANCH » (branche actuelle : ${CURRENT_BRANCH:-inconnue})."
  blank
  say "Aucun changement de branche n'est fait automatiquement."
  say "Rien n'a été modifié ni supprimé."
  pause_end
  exit 1
fi

if [ -d "$REPO_DIR/.git/rebase-merge" ] || [ -d "$REPO_DIR/.git/rebase-apply" ] || [ -e "$REPO_DIR/.git/MERGE_HEAD" ]; then
  blank
  say "❌ Une opération Git est restée inachevée dans cette copie."
  say "Rien n'a été modifié. Ouvre le Terminal dans :"
  say "   $REPO_DIR"
  pause_end
  exit 1
fi

CHANGES="$(git -C "$REPO_DIR" status --porcelain 2>/dev/null || true)"
if [ -n "$CHANGES" ]; then
  blank
  say "❌ Des fichiers ont été modifiés dans la copie locale :"
  blank
  printf '%s\n' "$CHANGES" | head -n 10
  blank
  say "La mise à jour est annulée pour ne rien écraser."
  say "Déplace ou restaure ces fichiers, puis relance ce script."
  say "Rien n'a été supprimé."
  pause_end
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Mise à jour
# ---------------------------------------------------------------------------
VERSION_BEFORE="$(manifest_version "$REPO_DIR")"
say "Version installée : ${VERSION_BEFORE:-inconnue}"
blank
say "Recherche des nouveautés…"

if ! git -C "$REPO_DIR" fetch --quiet origin "$BRANCH"; then
  blank
  say "❌ Impossible de contacter GitHub."
  blank
  say "Vérifie ta connexion Internet, puis relance ce script."
  say "Rien n'a été modifié."
  pause_end
  exit 1
fi

LOCAL_SHA="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)"
REMOTE_SHA="$(git -C "$REPO_DIR" rev-parse "origin/$BRANCH" 2>/dev/null || true)"

if [ -n "$LOCAL_SHA" ] && [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  blank
  say "✅ Déjà à jour."
  blank
  say "Version : ${VERSION_BEFORE:-inconnue} (Already up-to-date)"
  blank
  say "Pense simplement à cliquer Actualiser (↻) dans brave://extensions"
  say "si tu viens de recharger l'extension."
  open_extensions_page
  pause_end
  exit 0
fi

say "Mise à jour en cours…"
if ! git -C "$REPO_DIR" merge --ff-only "origin/$BRANCH"; then
  blank
  say "❌ La mise à jour n'a pas pu être appliquée simplement."
  blank
  say "Rien n'a été supprimé, aucun reset n'a été fait."
  say "Ta copie reste utilisable en l'état."
  pause_end
  exit 1
fi

VERSION_AFTER="$(manifest_version "$REPO_DIR")"
chmod +x "$REPO_DIR/macos/"*.command 2>/dev/null || true

blank
say "✅ Mise à jour terminée."
blank
say "Version avant : ${VERSION_BEFORE:-inconnue}"
say "Version après : ${VERSION_AFTER:-inconnue}"
blank
say "Deux gestes pour finir :"
say "  1. Dans brave://extensions, clique Actualiser (↻) sur Cartes vers Anki."
say "  2. Recharge la page ChatGPT.com (Cmd-R)."
blank
say "Tes cartes, paquets et ton historique de révision dans Anki ne sont pas"
say "concernés par cette mise à jour."

open_extensions_page
pause_end
exit 0
