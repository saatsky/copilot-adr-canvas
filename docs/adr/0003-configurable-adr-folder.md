---
title: "Keep ADR folder configurable"
date: "2026-08-24"
status: "Accepted"
---

# Keep ADR folder configurable

## Context

ADR storage was initially hardcoded in parts of the generated workflow guidance, which made it look like
the repository only supported `docs/adr`. The canvas already supports a user-configurable ADR folder,
and the generated workflow should reflect the active workspace setting so users can place ADRs in the
location that fits their repository conventions.

## Options

- Option A: Hardcode ADRs to `docs/adr`
  - Pros: Simple default and easy to document.
  - Cons: Breaks workflows that use a different folder structure.
- Option B: Allow the ADR folder to be configured per workspace
  - Pros: Matches repository conventions and user expectations.
  - Cons: Adds a small amount of dynamic rendering logic.
- Option C: Allow arbitrary folders but do not reflect the active folder in generated guidance
  - Pros: Maximum flexibility.
  - Cons: Confusing and easy to misconfigure.

## Decision

We keep the ADR folder configurable and render the active folder into the workflow guidance at generation
time. The generated helper file should describe the actual folder in use, but the extension must not
force a fixed `docs/adr` location.

## Consequences

- Users can store ADRs where their repository expects them.
- The generated workflow text stays accurate for the current workspace.
- The extension must continue to resolve folder preferences dynamically.
