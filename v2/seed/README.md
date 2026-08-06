# Seed files

`AGENTS.md` becomes the installer-managed `~/.deck/AGENTS.md` during bootstrap.
Install and update converge it to this public, generic Prime conversation
contract. If an older home has local edits, bootstrap preserves them under
`~/.deck/backups/` before replacing the contract. Operator-owned names,
preferences, and routing stay under `~/.deck/config/`; the repository
contributor guide is the root `AGENTS.md`.

## Move to a new machine

Clone Deck and run the repository-root `install.sh`; bootstrap installs OptMem
and creates a new plain runtime home plus a new host-local durable root.
Configure that host deliberately. Never transfer `~/.deck`,
`~/.deck-durable`, credentials, dossiers, project policy, Smithers state, or
worktrees from another machine.
