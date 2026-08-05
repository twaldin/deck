# Seed files

`AGENTS.md` becomes `~/.deck/AGENTS.md` during bootstrap. It is the public,
generic contract for plain pi sessions; private names and routing stay under
`~/.deck/config/`. The repository contributor guide is the root `AGENTS.md`.

## Move to a new machine

Install deck with `install.sh`, install OptMem, then transfer only reviewed
private configuration, dossiers, and memory according to `docs/home-cutover.md`.
Never transfer credentials, runtime state, or a git checkout of `~/.deck`.
