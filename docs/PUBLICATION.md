# Publication automatique sur le Chrome Web Store

Une fois configuré, publier une version se fait en deux commandes :

```bash
# après avoir monté "version" dans extension/manifest.json et fusionné sur main
git tag v1.5.0
git push origin v1.5.0
```

Le workflow `.github/workflows/publish-chrome-web-store.yml` :

1. vérifie que le tag correspond à la version du manifeste ;
2. lance les tests (`node tests/test.cjs`) ;
3. construit le `.zip` du dossier `extension/` ;
4. l'envoie au Chrome Web Store (**API v2** — l'API v1 n'est plus acceptée après le 15 octobre 2026) ;
5. le soumet à l'examen de Google ;
6. crée une release GitHub avec le `.zip` en pièce jointe.

Après approbation par Google (de quelques heures à quelques jours), **Chrome, Brave et
Edge mettent à jour l'extension tout seuls** chez les utilisateurs : il n'y a rien à
faire de leur côté. Le kit macOS (`macos/`) ne sert plus qu'aux versions bêta non
publiées.

> La version du manifeste doit toujours être **strictement supérieure** à celle déjà
> publiée, sinon le Chrome Web Store refuse l'envoi.

---

## Configuration (une seule fois)

### 1. Identifiants du Chrome Web Store

Dans le [tableau de bord développeur](https://chrome.google.com/webstore/devconsole/) :

- **ID de l'extension** : affiché sous le nom de l'article (`fhkabgkbnknihhdlmcnkmnbijepclipi`).
- **ID de l'éditeur (publisher)** : menu **Éditeur → Paramètres**.

Dans GitHub : **Settings → Secrets and variables → Actions → onglet Variables**, créer :

| Variable | Valeur |
|---|---|
| `CWS_EXTENSION_ID` | `fhkabgkbnknihhdlmcnkmnbijepclipi` |
| `CWS_PUBLISHER_ID` | l'ID d'éditeur |

### 2. Compte de service Google Cloud

```bash
PROJECT_ID=ton-projet-gcp
gcloud config set project "$PROJECT_ID"
gcloud services enable chromewebstore.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
gcloud iam service-accounts create cws-publisher --display-name="Chrome Web Store publisher"
```

Puis, dans le tableau de bord du Chrome Web Store, section **Compte**, ajouter
l'adresse du compte de service (`cws-publisher` suivi de `@<PROJECT_ID>.iam.gserviceaccount.com`).
Un seul compte de service est possible par éditeur.

### 3a. Authentification sans clé (recommandé)

GitHub prouve son identité à Google à chaque exécution (Workload Identity Federation) :
aucune clé à stocker ni à faire tourner. L'accès est limité à ce dépôt **et aux tags `v…`**.

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

gcloud iam workload-identity-pools create github \
  --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc cartes-vers-anki \
  --location=global --workload-identity-pool=github \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository=='pyxl-dev/cartes-vers-anki' && assertion.ref.startsWith('refs/tags/v')"

gcloud iam service-accounts add-iam-policy-binding \
  "cws-publisher@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/pyxl-dev/cartes-vers-anki"
```

Variables GitHub à ajouter :

| Variable | Valeur |
|---|---|
| `GCP_WIF_PROVIDER` | `projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github/providers/cartes-vers-anki` |
| `GCP_SERVICE_ACCOUNT` | `cws-publisher@<PROJECT_ID>.iam.gserviceaccount.com` |

> Avec cette condition, le lancement manuel (« Run workflow » depuis une branche) est
> refusé par Google : seuls les tags `v…` peuvent publier. C'est voulu.

### 3b. Variante plus simple : clé JSON

Si tu préfères ne pas configurer la fédération : crée une clé JSON pour le compte de
service (console Google Cloud → IAM → Comptes de service → Clés), puis colle tout le
contenu du fichier dans un **secret** GitHub nommé `GCP_SA_KEY`. Ne définis pas
`GCP_WIF_PROVIDER` : le workflow utilisera alors la clé. Supprime le fichier local
ensuite. Une clé qui fuite donne le droit de publier à ta place : la variante 3a est
préférable.

### 4. Environnement de protection (facultatif mais conseillé)

Le workflow tourne dans l'environnement GitHub `chrome-web-store`. Dans
**Settings → Environments → chrome-web-store**, tu peux exiger ton approbation avant
chaque publication (« Required reviewers ») et limiter les déploiements aux tags `v*`.

---

## Vérifier l'état d'une soumission

Le résumé de l'exécution GitHub affiche la réponse de `fetchStatus`. Le tableau de bord
du Chrome Web Store montre aussi l'état (« En attente d'examen », « Publié »…).
