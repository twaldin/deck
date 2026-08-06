# Remote-agent → Deck-host handoff

For agents running on another machine. Prepare work and drop files that any
plain Pi session on the durable Deck host can pick up. Smithers owns pipelines
and delivery state on that host.

## Reach the Deck host

```sh
# Use a host name or private-network address controlled by the operator.
ssh <user>@<deck-host>
```

Use the host's own login user. Do not assume the laptop username.

## What you may put on the Deck host

| OK | Never |
|---|---|
| Personal git clones under `~/dev/<name>` | Company product checkouts |
| Handoff / brief markdown under `~/.deck/data/inbox/` | Work OAuth, eng-agent keys, prod tokens |
| Personal project notes | Copy of another host's `~/.deck` or broker store |

## Install or update a personal project

```sh
ssh <user>@<deck-host> 'bash -s' <<'EOF'
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

Edit `repo`, paths, and merge posture to match the operator's reviewed project policy.

## Drop work for Deck (inbox)

```sh
ssh <user>@<deck-host> 'mkdir -p ~/.deck/data/inbox'
# copy a handoff
scp ./HANDOFF-my-feature.md <user>@<deck-host>:~/.deck/data/inbox/
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
configured project profile; never invent merge authority in the handoff
```

The operator opens a plain Deck session, reviews these files, and turns them
into `ship` runs. Do not start Smithers from the remote machine unless asked.

## Update deck code on the box

```sh
ssh <user>@<deck-host> '~/dev/deck/update.sh'
```

## Enter a plain session remotely

```sh
ssh -t <user>@<deck-host> 'source ~/.deck/enter.sh && pi'
```

Then describe the work, point at inbox files, and answer queued decisions when
asked. No proprietary remote terminal tool is required.

## One-liner the laptop agent can cat first

```sh
ssh <user>@<deck-host> 'cat ~/dev/deck/docs/LAPTOP-AGENTS.md'
```
