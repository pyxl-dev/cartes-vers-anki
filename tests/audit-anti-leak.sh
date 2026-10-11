#!/bin/bash
# Audit anti-fuite avant publication d'un dépôt public.
# Aucun gitleaks requis : jeu de motifs GÉNÉRIQUES (identifiants de secrets,
# chemins personnels absolus, adresses e-mail, clés privées, URL de conversation).
#
# Motifs propres à votre projet, jamais versionnés :
#   EXTRA_PATTERNS='(mon-nom|mon-domaine\.fr)' ./tests/audit-anti-leak.sh
#
# Le scan couvre TOUT l'arbre, script d'audit compris : il est écrit pour ne pas
# se détecter lui-même, ce qui évite d'avoir à l'exclure (une exclusion pourrait
# masquer une vraie fuite).
cd "$(dirname "$0")/.." || exit 1
FAIL=0

# Les chemins absolus sont assemblés à l'exécution pour que ce fichier ne se
# détecte pas lui-même, sans avoir à l'exclure du scan.
S='/'
HOME_PATH="${S}Users${S}"
SUPPORT_PATH="${S}Application Support${S}"
BS='\\'
WIN_PATH="[A-Za-z]:${BS}${BS}Users${BS}${BS}"

SECRETS='(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer [A-Za-z0-9._-]{20,})'
PATHS="(${HOME_PATH}|${SUPPORT_PATH}|${WIN_PATH}|/home/[a-z0-9_-]+/|chatgpt\.com/c/)"
EMAILS='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
PATTERNS="${SECRETS}|${PATHS}"
if [ -n "$EXTRA_PATTERNS" ]; then PATTERNS="${PATTERNS}|${EXTRA_PATTERNS}"; fi

echo "=== 1. ARBRE DE TRAVAIL ==="
if grep -rInE "$PATTERNS" --exclude-dir=.git . ; then
  echo "  ^^ MOTIFS SENSIBLES TROUVÉS"; FAIL=1
else echo "  OK : aucun motif sensible"; fi

echo
echo "=== 2. CONTENU INDEXÉ (git grep --cached) ==="
if git grep --cached -InE "$PATTERNS" ; then
  echo "  ^^ MOTIFS SENSIBLES TROUVÉS DANS L'INDEX"; FAIL=1
else echo "  OK : index propre"; fi

echo
echo "=== 3. ADRESSES E-MAIL ==="
if grep -rIoE "$EMAILS" --exclude-dir=.git . ; then
  echo "  ^^ vérifier : aucune adresse personnelle ne doit être publiée"; FAIL=1
else echo "  OK : aucune adresse e-mail"; fi

echo
echo "=== 4. FICHIERS INDEXÉS (liste exhaustive) ==="
git diff --cached --name-only | sed 's/^/  /'

echo
echo "=== 5. FICHIERS NON SUIVIS / IGNORÉS présents dans l'arbre ==="
git status --porcelain --ignored | sed 's/^/  /'

echo
echo "=== 6. ARTEFACTS (logs, archives, secrets, dépendances) indexés ? ==="
if git diff --cached --name-only | grep -Ei '\.(log|zip|crx|pem|key|env|db|sqlite|cookie)$|(^|/)(node_modules|\.env)' ; then
  echo "  ^^ ARTEFACTS TROUVÉS"; FAIL=1
else echo "  OK : aucun artefact indexé"; fi

echo
echo "=== 7. IDENTITÉ ET HISTORIQUE GIT ==="
echo "  user.name  : $(git config user.name)"
echo "  user.email : $(git config user.email)"
echo "  commits    : $(git rev-list --count --all 2>/dev/null || echo 0)"
echo "  auteurs    : $(git log --format='%an <%ae>' 2>/dev/null | sort -u | tr '\n' ' ')"

echo
[ $FAIL -eq 0 ] && echo "RÉSULTAT AUDIT : PASS (aucune fuite détectée)" || echo "RÉSULTAT AUDIT : ÉCHEC — ne pas publier en l'état"
exit $FAIL
