# Markdown Copilot ADR Canvas

A GitHub Copilot canvas extension to browse, create, edit, and manage Architecture Decision Records (ADRs) in `docs/adr`.

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

1. In your project, keep ADR files under `docs/adr`.
2. Open this repository in GitHub Copilot App.
3. Open the **Markdown Copilot ADR Canvas** (`copilot-adr-canvas`) from the canvas picker.
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
5. Open the **Markdown Copilot ADR Canvas** and start managing ADRs in `docs/adr`.

## Notes

- The canvas is fixed to `docs/adr` in the active workspace.
- Preference state is stored in `copilot-adr-canvas-preferences.json` at workspace root.
