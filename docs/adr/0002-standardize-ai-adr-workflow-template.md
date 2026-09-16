---
title: "Standardize AI ADR workflow template"
date: "2026-08-24"
status: "Accepted"
---

# Standardize AI ADR workflow template

## Context

The ADR canvas generates an `ADR_AI_WORKFLOW.md` helper file to guide how ADRs are written and reviewed.
The earlier template was too minimal and its preview output could be hard to parse, especially when options
were rendered in table-like text inside the markdown example. The workflow also needed to preserve the
more descriptive guidance from the user-provided version without losing the extension-generated inventory
and dynamic ADR folder reference.

## Options

- Option A: Keep the minimal generated workflow template
  - Pros: Simple and easy to maintain.
  - Cons: Less guidance for AI and humans; weaker preview readability.
- Option B: Merge the richer guidance into the generated workflow template
  - Pros: Better instructions, clearer examples, and more consistent ADR drafting.
  - Cons: Slightly longer generated document.
- Option C: Maintain a separate hand-edited workflow file outside generation
  - Pros: Full manual control over the text.
  - Cons: Regeneration would drift and the canvas would no longer be the source of truth.

## Decision

We standardize the generated workflow template and merge the richer guidance into the extension source.
The template now uses parser-friendly markdown for the options and consequences sections, while keeping
the generated inventory and the dynamic ADR folder reference intact.

## Consequences

- ADR guidance is clearer for both humans and AI.
- The preview renders more reliably.
- The extension remains the source of truth for the generated helper file.
