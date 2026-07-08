# Publishing Branch Diff

Steps to publish this extension to the [VS Code Marketplace](https://marketplace.visualstudio.com/vscode).

## 1. Push the repo to GitHub

The Marketplace README rewrites relative image links (e.g. `media/hero.svg`) to
the repository's raw URL on the default branch, so the repo — **including the
`media/` assets** — must be on GitHub first for images to render on the listing.

```bash
git init -b master
git add -A
git commit -m "Branch Diff 0.1.0"
gh repo create firdaushatta/git-branch-diff --public --source=. --push
```

## 2. Create a Marketplace publisher

1. Sign in to [Azure DevOps](https://dev.azure.com) and create an organization
   (free) if you don't have one.
2. Go to the [Marketplace publisher management](https://marketplace.visualstudio.com/manage)
   page and **create a publisher** with the ID **`firdaushatta`** — it must match
   the `publisher` field in `package.json`.

## 3. Create a Personal Access Token (PAT)

In Azure DevOps → **User settings → Personal access tokens → New Token**:

- **Organization:** All accessible organizations
- **Scopes:** *Custom defined* → **Marketplace → Manage**

Copy the token (shown once).

## 4. Publish

### Option A — from your machine

```bash
npm ci
npx @vscode/vsce login firdaushatta   # paste the PAT when prompted
npx @vscode/vsce publish              # runs vscode:prepublish (production build) + uploads
```

### Option B — from CI (tag-triggered)

The repo already includes `.github/workflows/release.yml`. To use it:

1. Add a repository secret **`VSCE_PAT`** (the token from step 3):
   `gh secret set VSCE_PAT`
2. Tag and push:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

The workflow type-checks, tests, packages `git-branch-diff-v0.1.0.vsix`, attaches it
to a GitHub Release, and runs `vsce publish` (only when `VSCE_PAT` is set).

## Sanity check before publishing

```bash
npm run check-types && npm test
npx @vscode/vsce package     # produces a .vsix with no warnings
npx @vscode/vsce ls          # inspect exactly what will ship
```

## Updating

Bump `version` in `package.json` (and add a `CHANGELOG.md` entry), then repeat
step 4 — or use `npx @vscode/vsce publish minor|patch` to bump and publish in one
step.
