# Seed files

`AGENTS.md` becomes `~/.deck/AGENTS.md` during bootstrap. It is the public,
generic contract for Prime conversations; private names and routing stay under
`~/.deck/config/`. The repository contributor guide is the root `AGENTS.md`.

## Move to a new machine

Clone Deck and run the repository-root `install.sh`; bootstrap installs OptMem
and creates a new plain runtime home. Then transfer only reviewed private
configuration and dossiers. Never transfer credentials, Smithers runtime state,
or a git checkout of `~/.deck`.
