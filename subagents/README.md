# Deck crew subagent rig

This package installs pi's shipped `subagent` extension together with Deck's cross-model crewmate definitions. The extension runs each crewmate in an isolated context window, so builders can construct and validate changes and report back without filling the supervisor's context with implementation detail.

## Install

The installer only modifies the pi agent directory. It is safe to rerun: files managed by this package are refreshed as symlinks pointing at this package (for definitions) and the installed pi example (for the extension). Reruns do not remove files left by an older version of the package.

```bash
./subagents/install.sh
```

The pi example path defaults to the installed package path required by this repository. Override it with `EXTENSION_SOURCE` when testing another pi installation. For a harmless temp-target test:

```bash
INSTALL_TARGET="$(mktemp -d)/agent" ./subagents/install.sh
```

## Crew definitions

| Agent | Role | Default |
| --- | --- | --- |
| `worker` | Full-capability builder | `deck/claude-opus-5` |
| `worker-gpt` | Full-capability family alternative | `deck/gpt-5.6-terra` |
| `reviewer` | Adversarial review with inspection tools; choose the **opposite model family** from the producer | `deck/gpt-5.6-terra` |
| `reviewer-claude` | Adversarial review with inspection tools for GPT-produced work | `deck/claude-opus-5` |
| `scout` | Cheap read-only reconnaissance | `deck/claude-sonnet-5` |

Model values are Deck broker-qualified defaults. The dispatching agent may override any default for a specific task by selecting the other worker/reviewer definition (or maintaining a task-specific definition with the desired `model` frontmatter). The reviewer must still use the opposite model family from whoever produced the work under review.

## Brief language for firstmate

Firstmate can copy this into a crew brief (substitute the task and any explicit model override):

> Use the Deck pi subagent rig. Start with `scout` for cheap read-only reconnaissance when the task needs it. Delegate implementation to `worker` (Claude default) or `worker-gpt` (GPT-family alternative); builders work in isolated context windows, construct and validate the change, then report back with completed work, validation, files changed, and notes so the supervisor context stays small. After a builder finishes, run an adversarial review in a fresh context using `reviewer` or `reviewer-claude`, and choose the OPPOSITE model family from whoever produced the work. Reviewers have read-oriented inspection tools plus `bash` for repository inspection; their prompt forbids mutation, and they must return prioritized findings with exact paths. This is a behavioral contract, not a kernel-enforced sandbox. Have the builder address valid findings, rerun validation, and report the final handoff.

For larger builds, repeat builder/reviewer cycles across multiple context windows rather than putting the whole implementation and review in one conversation.

## Definition format

Files under `agents/` use pi's markdown agent format. The supported frontmatter fields are `name`, `description`, optional `tools`, and optional `model`; this matches the installed extension's `agents.ts` discovery logic. Tool names are comma-separated. No additional frontmatter fields are used.
