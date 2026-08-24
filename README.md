# Markdown Copilot ADR Canvas

A GitHub Copilot canvas extension to browse, create, edit, and manage Architecture Decision Records (ADRs) in a configurable ADR folder (default `docs/adr`).

## What this extension provides

- ADR list with search and status filters
- ADR preview + in-place markdown editing
- ADR creation using an ADR template (`ADR-NNNN-title.md`)
- ADR status lifecycle updates
- AI workflow file generation (`AI_ADR_WORKFLOW.md`)
- Optional display of non-ADR markdown files inside `docs/adr`

## Repository layout

```text
.github/extensions/copilot-adr-canvas/
  copilot-extension.json
  extension.mjs
  web/index.html
AI_ADR_WORKFLOW.md
```

## How to use

1. Open this repository in GitHub Copilot App.
2. Open the **Markdown Copilot ADR Canvas** (`copilot-adr-canvas`) from the canvas picker.
3. Use **Change Folder** (next to **Rescan**) to select your ADR folder (default is `docs/adr`).
4. Use the UI to:
   - Search/filter ADRs
   - Open and preview ADRs
   - Edit and save markdown
   - Create a new ADR
   - Update lifecycle status
   - Generate `AI_ADR_WORKFLOW.md` from **AI Integration**

## Deploy on GitHub Copilot App

1. Put this extension in your repo at:
   `.github/extensions/copilot-adr-canvas/`
2. Commit and push the repository to GitHub.
3. Open the repository as a project/session in GitHub Copilot App.
4. Reload extensions (or restart the session) so the new canvas is discovered.
5. Open the **Markdown Copilot ADR Canvas** and start managing ADRs.

## Install for user/session scope (important)

To get the same behavior across **project/user/session** scope, install a **flat extension package**.

### Required package structure

```text
copilot-adr-canvas/
  copilot-extension.json
  extension.mjs
  web/index.html
```

For user/session scope, `extension.mjs` must be at the extension folder root. Do **not** install a full repo tree that nests files under `.github/extensions/...`.

### Why this matters

- Project scope discovery expects `.github/extensions/<name>/extension.mjs` in the repository.
- User/session scope discovery expects `<scope_extensions>/<name>/extension.mjs` directly at root.
- If user/session installs contain nested `.github/extensions/...`, the UI/features can differ from project scope.

## Notes

- The ADR folder is configurable from the canvas (**Change Folder**) and persisted in preferences.
- Preference state is stored in `copilot-adr-canvas-preferences.json` at workspace root.
