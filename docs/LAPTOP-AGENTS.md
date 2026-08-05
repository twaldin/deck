# Laptop agents → orch-host handoff

For agents running on a **glass laptop**. You are **not** the deck orchestrator. You prepare work and drop files the orch will read. The orch lives on a durable host and owns pipelines.

## Reach the orch host

```sh
# Prefer a hosts-file or MagicDNS name; fall back to the host's tailnet address.
ssh <user>@<orch-host>
```

Use the host's own login user. Do not assume the laptop username.

## What you may put on the orch host

| OK | Never |
|---|---|
| Personal git clones under `~/dev/<name>` | Company product checkouts |
| Handoff / brief markdown under `~/.deck/data/inbox/` | Work OAuth, eng-agent keys, prod tokens |
| Personal project notes | Copy of another host's `~/.deck` or broker store |

## Install or update a personal project

```sh
ssh <user>@<orch-host> 'bash -s' <<'EOF'
set -euo pipefail
# example: clone or pull a personal repo
REPO_URL="https://github.com/YOU/PROJECT.git"
NAME="PROJECT"          # short id: [a-z0-9-]
DIR="$HOME/dev/$NAME"

if [ ! -d "$DIR/.git" ]; then
  git clone "$REPO_URL" "$DIR"
else
  git -C "$DIR" fetch --all --prune
  git -C "$DIR" pull --ff-only || true
fi

# register profile if missing (yolo-ship default for personal)
python3 - <<PY
import json
from pathlib import Path
p = Path.home()/".deck/config/projects.json"
profiles = json.loads(p.read_text()) if p.exists() else []
if not any(x.get("id")=="$NAME" for x in profiles):
    profiles.append({
        "id": "$NAME",
        "repo": "YOU/$NAME",
        "primary": str(Path.home()/ "dev" / "$NAME"),
        "pipeline": "yolo-ship",
        "yolo": True,
        "stamp": False,
        "knowledge": [],
    })
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(profiles, indent="\t") + "\n")
    print("added profile", "$NAME")
else:
    print("profile exists", "$NAME")
PY
EOF
```

Edit `repo` / paths to match reality. Pipeline stays **`yolo-ship`** on personal hosts unless the captain says otherwise.

## Drop work for the orch (inbox)

```sh
ssh <user>@<orch-host> 'mkdir -p ~/.deck/data/inbox'
# copy a handoff
scp ./HANDOFF-my-feature.md <user>@<orch-host>:~/.deck/data/inbox/
```

### Handoff file shape

Name: `~/.deck/data/inbox/<slug>.md`

```markdown
# <slug>

## Intent
One paragraph: what done looks like.

## Repo
profile id or path under ~/dev/...

## Acceptance
- [ ] measurable criterion 1
- [ ] measurable criterion 2

## Context
Links, prior PRs, constraints. No secrets.

## Pipeline
yolo-ship | (only if captain said stamp)
```

Captain (or orch when he says “drain inbox”) turns these into `ship` runs. **Do not** start smithers yourself from the laptop unless asked.

## Update deck code on the box

```sh
ssh <user>@<orch-host> '~/dev/deck/update.sh'
```

## Glass in (human)

```sh
herdr --remote <user>@<orch-host>
# remote shell:
source ~/.deck/enter.sh && pi
```

Then talk to the orch: describe work, point at inbox files, stamp when asked.

## One-liner the laptop agent can cat first

```sh
ssh <user>@<orch-host> 'cat ~/dev/deck/docs/LAPTOP-AGENTS.md'
```
