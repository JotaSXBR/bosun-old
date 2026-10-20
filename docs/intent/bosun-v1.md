# Bosun v1 — statement of intent

Confirmed by the founder in an interview on 2026-10-20. **Layer on top of
the existing plans, not a replacement**: `roadmap.md`, `vision.md`,
`ai-agents.md` and `TODO.md` stay as written. Where they diverge from this
file, this file wins _for v1 only_; each front below updates the files it
touches when it becomes a spec.

## Statement

- **Outcome:** the internal operation (4+ attendants, one tenant) serves
  100% of its customer conversations through Bosun, on desktop and phone,
  with a copilot that helps and professionalizes the service.
- **User:** the founder and the attendants. The end customer only sees
  WhatsApp.
- **Why now:** the technical base exists (WAHA, inbox, funnel, agent
  structure) but the copilot could not be tested or configured, and contact
  identity is wrong (WAHA `lid` creates empty contacts instead of resolving
  the phone and matching Google Contacts).
- **Success:** one full day of real operation. The attendant picks up,
  replies, transfers and resolves from the phone. Contacts show the right
  phone and name, no empty duplicates. The copilot suggests drafts and
  contact fills (every field, approved on screen mid-conversation). The
  founder configures and tests the copilot (via UI or by talking to Claude
  Code) and sees the effective context it receives.
- **Constraint:**
  - Pricing, catalog and price tables live in an external ERP (future
    API/MCP). The copilot never touches prices.
  - WAHA stays as is.
  - AI is a human-approved copilot, not autonomous.
  - **Niche-agnostic.** The first case is a metals distributor; no metal,
    pricing or cutting concept enters the core.
  - **The brain and MCP configuration are platform services, not inbox
    features**, so future modules (tasks, calendar, owner dashboard) reuse
    them.

## Scope — 5 fronts

1. **Contacts:** identity by phone instead of `lid`, matching Google
   Contacts/People. A copilot tool suggests all contact fields from the
   conversation and asks for on-screen approval.
2. **Copilot:** playground, on-screen configuration guide, knowledge base
   with a reliable load path, and a **second brain at two levels (contact
   and company)** with trust layers (company direction > attendant > learned
   by the AI) and an "effective context" screen showing what the copilot
   reads and the limits. The brain learns from attendants with caveats
   (spelling, tone and sales errors) and from manual company direction.
   Look for open-source references before building.
3. **Configuration via Claude Code:** MCP plus skills, with good practices
   built in, so Bosun is configured conversationally.
4. **Navigation reform**, including phone attendance.
5. **Foundation for future agents:** guardrails, shared tools, handoff.

## Out of scope for v1

Push notifications (future), pricing/catalog, autonomous agents, billing,
per-tenant branding (the Bosun design system is done), LGPD endpoints,
channels beyond WhatsApp, the secrets vault, Bosun _consuming_ external MCP
servers (v1 only _exposes_ an MCP for Claude Code), and the future modules (tasks, calendar, owner
dashboard, documents, indicators).

## Divergences from existing docs (flagged, not fixed)

- `roadmap.md` lists MCP, vault and RAG as out of the skeleton; v1 brings
  MCP and a knowledge base in. (There, "vault" means the **secrets vault**
  for credentials, a different thing from the second brain.)
- `ai-agents.md` stages: v1 here is the _Assisted_ stage plus configuration
  and playground, not only _Passive_.
- `vision.md` frames a resellable multi-tenant SaaS; v1 is internal use.
  Both remain valid; internal use has priority.

## Reference

Orbit (orbitagents.com) was reviewed for ideas only: effective-context
screen, trust-ranked memory (human edits win), scoped learnings, autofill
from links, skills loaded on demand, rotatable MCP link. Not adopted: 3D
memory graph, department org chart, outbound-sales skill library.
