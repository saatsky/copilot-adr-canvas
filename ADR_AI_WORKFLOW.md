---
status: "Accepted"
---

# ADR AI Workflow

> Auto-generated for Markdown Copilot ADR Canvas on 2026-09-16.
> Read this file before creating, updating, or reviewing ADRs.

## Conventions

- **Recommended ADR folder:** `docs/adr/`. Each project may choose and document its own ADR folder; this recommendation is not mandatory.
- **Filename pattern:** `NNNN-title-with-dashes.md` (4-digit zero-padded). Titles may include `ADR` or any other naming the project or user chooses; an `ADR-` prefix is not required.
- **Front matter fields:** `title`, `date` (YYYY-MM-DD), `status`
- **Status lifecycle:** `Proposed` → `Accepted` → `Deprecated` / `Superseded` / `Rejected`
- **Numbering:** use the next max number + 1; never renumber existing ADRs.

## Nygard Template (example)

```markdown
---
title: <Decision title>
date: YYYY-MM-DD
status: Accepted
---

# <Decision title>

## Context

<Describe the situation, constraints, and forces at play.>

## Options

- **Option A:** <Description>  
  Pros: <...>  
  Cons: <...>
- **Option B:** <Description>  
  Pros: <...>  
  Cons: <...>

## Decision

<State the chosen option and why.>

## Consequences

<Describe outcomes, trade-offs, and follow-up implications.>
```

Do not add a `## Status` section; status remains in YAML front matter.

## Lifecycle Guidance

- New ADRs default to `Proposed` unless the user explicitly requests another status.
- Never update an ADR status without explicit user instruction.
- Lifecycle changes modify only the front matter `status`; preserve existing ADR content unless the user asks for other changes.

## Prompt Examples

1. Create the next ADR in the recommended folder (`docs/adr/`) for [decision], using the next max number + 1 and the Nygard template.
2. Review `NNNN-title-with-dashes.md` for missing sections, weak rationale, and unclear consequences; suggest improvements without changing the file.
3. Change the status of `NNNN-title-with-dashes.md` to `Superseded` and update only its front matter status.
4. Use the ADR inventory and existing ADR content to explain the decision history for [topic], citing the relevant NNNN filenames and titles.

## What AI Should Do

1. Create ADRs with the Nygard section structure and filename convention above.
2. Review ADRs for missing context, weak options, unclear decisions, and consequences.
3. Use the inventory and ADR contents to answer decision-history questions, citing relevant filenames and titles.
4. Preserve existing content and never make lifecycle or other edits without explicit user instruction.

## Current ADR Inventory

<!-- ADR_INVENTORY_START -->
| # | File | Title | Status | Date |
|---|---|---|---|---|
| 0001 | `ADR-0001-use-markdown-adr-canvas-extension.md` | ADR-0001: Use Markdown Copilot ADR Canvas Extension | Accepted | 2026-08-21 |
| 0002 | `0002-standardize-ai-adr-workflow-template.md` | Standardize AI ADR workflow template | Accepted | 2026-08-24 |
| 0003 | `0003-configurable-adr-folder.md` | Keep ADR folder configurable | Accepted | 2026-08-24 |
<!-- ADR_INVENTORY_END -->
