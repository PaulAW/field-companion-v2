# Field Companion — Claude Code project instructions

## PROJECT_STATE.md maintenance

`PROJECT_STATE.md` exists so a separate **Claude Chat** design/planning session — which
cannot see this Claude Code session, local files, or git history — can get oriented on
the project by reading one doc.

**Update `PROJECT_STATE.md` after a push only when the push changes something Claude Chat
would need to know to reason about the project:**
- a new feature or capability ships
- architecture or schema changes (new tables, new services, new data flow)
- a deployed URL changes or a new one is added
- deploy/rollout status changes (e.g. a migration completes, a connector goes live)

**Do not update it for:**
- routine bug fixes, UI tweaks, or refactors that don't change the shape of the system
- commits that don't touch what's deployed or how it's architected

When in doubt, ask whether a Claude Chat session planning the next piece of work would
be misled without the update — if not, skip it.
