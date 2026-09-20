# Online Optimization Plan Design

**Date:** 2026-08-13
**Status:** Approved design, pending plan review

## Purpose

Create one maintainable, repository-facing optimization plan that turns the current
gap analysis and online repository audit into an ordered delivery program. The plan
must make it clear what blocks user workflows, what strengthens reliability, and
what is required before a public npm release.

## Documentation Boundary

`GAP_ANALYSIS.md` remains the factual inventory of implemented capabilities,
remaining gaps, and verification evidence. It will gain a concise online-delivery
status section covering:

- the default branch (`master`) versus CI push trigger (`main`) mismatch;
- the absence of open pull requests and issues at the audit time;
- the unreviewed, unvalidated `petrel` documentation branch;
- CI badge and release metadata placeholders; and
- the distinction between automated validation and missing end-to-end acceptance.

`docs/optimization-plan.md` becomes the single current execution roadmap. The
existing dated plan remains unchanged as a historical planning artifact.

## Plan Structure

The new plan will contain:

1. Scope, goals, and explicit non-goals.
2. An online project health snapshot with its audit date and evidence boundary.
3. A priority map separating P0 user-workflow blockers, P1 product/reliability
   work, P2 extensions, and release governance.
4. Five dependency-ordered delivery waves:
   - restore the managed-skill workflow;
   - make CI and end-to-end acceptance trustworthy;
   - unify source handling and lifecycle surfaces;
   - add safety, recovery, and observability infrastructure; and
   - prepare distribution and optional product expansion.
5. For every work item: scope, prerequisites, implementation boundary, acceptance
   criteria, and operational risk or rollback strategy.
6. Exit gates for beta readiness and a public npm v0.1 release.

## Ordering Rules

Work is sequenced by user impact and validation leverage:

- No new marketplace or UI expansion precedes completion of Managed Restore.
- CI branch coverage and hermetic end-to-end tests precede release claims.
- Source-domain unification precedes broad update, diff, merge, and Web lifecycle
  expansion.
- Runtime locking, migration, backup, and diagnostics are shared foundations; they
  land before destructive lifecycle operations are presented as reliable.
- npm publication is gated on package metadata, packed-artifact validation, and
  recorded platform acceptance.

## Verification Expectations

Documentation changes will be checked for internal links, headings, no placeholder
tasks, and consistency with the current repository configuration. The plan will not
claim that a feature is implemented merely because an interface or test double
exists.

## Non-goals

This documentation work does not implement the identified product features, alter
remote GitHub settings, create issues, change branch protection, publish packages,
or modify CI behavior. Those actions are planned as separately verifiable tasks.
