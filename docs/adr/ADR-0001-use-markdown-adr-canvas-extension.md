---
title: "ADR-0001: Use Markdown Copilot ADR Canvas Extension"
date: "2026-08-21"
status: "Accepted"
---

# ADR-0001: Use Markdown Copilot ADR Canvas Extension

## Status

Accepted

## Context

This repository needs a structured way to capture and browse architectural decision records (ADRs).
The Copilot ADR Canvas extension provides an in-editor UI for browsing, creating, and editing ADRs
stored as markdown files under `docs/adr`.

## Options

- Option A: Use plain markdown files with no tooling
- Option B: Use the `adr-tools` CLI
- Option C: Use the Copilot ADR Canvas extension

## Decision

We adopt the Copilot ADR Canvas extension (Option C). It integrates directly into the Copilot CLI
workflow, supports front-matter metadata, and provides a canvas UI for browsing and editing ADRs
without leaving the editor.

## Consequences

- Positive: ADRs are browsable via the canvas panel; AI integration is available for drafting.
- Negative: Requires the `project:copilot-adr-canvas` extension to be loaded in the session.
