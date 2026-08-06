# Seed files

`AGENTS.md` becomes the installer-managed `~/.deck/AGENTS.md` during bootstrap.
Install and update converge it to this public, generic Prime conversation
contract. If an older home has local edits, bootstrap preserves them under
`~/.deck/backups/` before replacing the contract. Operator-owned names,
preferences, and routing stay under `~/.deck/config/`; the repository
contributor guide is the root `AGENTS.md`.

## Move to a new machine

Clone Deck and run the repository-root `install.sh`; bootstrap installs OptMem
and creates a new plain runtime home. Then transfer only reviewed private
configuration and dossiers. Never transfer credentials, Smithers runtime state,
or a git checkout of `~/.deck`.
