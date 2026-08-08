# Supply-Chain CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Renforcer la CI publique d'Astratra avec des contrôles de code, dépendances, secrets, paquets et services de données.

**Architecture:** La CI principale reste responsable de l'installation reproductible, des tests et des builds. Des workflows dédiés isolent CodeQL et la revue des dépendances. Un script contrôle l'installation des archives npm dans un projet vierge. La publication npm est documentée comme publication attestée via OIDC, car son activation dépend du réglage du compte npm.

**Tech Stack:** GitHub Actions, CodeQL, dependency-review-action, Gitleaks, Node.js 20/22, npm pack.

## Global Constraints

- La CI utilise `npm ci` et le lockfile commité.
- Les contrôles ne publient aucun paquet et ne demandent aucun token npm.
- Les tests contre Redis, MongoDB et PostgreSQL ne font pas partie de cette CI.
- La configuration Trusted Publishing npm reste une action explicite de l'organisation npm.

---

### Task 1: Reproductibilité et contrôles de dépendances

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/codeql.yml`
- Create: `.github/workflows/dependency-review.yml`
- Create: `.github/workflows/secrets.yml`

- [x] Remplacer l'installation CI par `npm ci`.
- [x] Ajouter CodeQL pour JavaScript.
- [x] Ajouter la revue des dépendances sur les pull requests.
- [x] Ajouter Gitleaks sur l'historique et les fichiers du dépôt.

### Task 2: Installation des paquets

**Files:**
- Create: `scripts/verify-package-installation.js`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [x] Vérifier qu'une archive npm produite localement s'installe dans un dossier vierge.
- [x] Ne pas ajouter de services Docker ni de tests d'intégration dépendants de Docker.

### Task 3: Publication attestée

**Files:**
- Create: `docs/PUBLISHING.md`

- [x] Documenter la liaison GitHub Trusted Publishing par package npm.
- [x] Documenter `npm publish --provenance` et l'absence de token dans GitHub Actions.
