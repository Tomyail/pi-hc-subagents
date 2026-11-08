# pi-hc-subagents

Sub-agents for [pi](https://github.com/earendil-works/pi), dispatched through
[herdr-core](https://herdr.dev) so every child shows up **under its parent** in
herdr-app's agents panel.

```
main agent (terminal t3y)
├── scout-auth      (child of t3y)
├── reviewer-diff   (child of t3y)
└── planner         (child of t3y)
```

## Why not pi-subagents / pi-herdr-subagents

| | spawns | appears in agents panel | non-blocking |
| --- | --- | --- | --- |
| `pi-subagents` | in-process | no | no |
| `pi-herdr-subagents` | `herdr pane split` | as a pane, no parent edge | yes |
| **this** | `hc run --parent <self>` | yes, as a child terminal | yes |

`pi-herdr-subagents` splits panes, which reshapes the user's layout and records
no parent-child edge. This extension never touches the layout: it starts a
background herdr terminal with `--parent`, so the relationship lives in
herdr-core and the agents panel renders it as a tree.

## Requirements

- pi `~1.5.0`
- herdr-core (`hc` on `PATH`) and pi running **inside a herdr-app terminal** —
  `HC_TERMINAL_ID` must be set, otherwise there is no parent to attach to.
- **Not** installed alongside `pi-subagents`: both register a `subagent` tool.
  The extension refuses to load if it finds one in `~/.pi/agent/settings.json`.

## Install

```bash
pi install git:github.com/Tomyail/pi-hc-subagents
```

## Agents

Definitions are markdown files with YAML frontmatter, read from
`.pi/agents/*.md` (project) and `~/.pi/agent/agents/*.md` (user). Project wins
on a name clash.

```markdown
---
name: scout
description: Fast read-only recon
tools: read, grep, glob, bash
model: magpie/group/scout
thinking: low
spawning: false
---

You explore the codebase and report what you find. Cite file paths and line
numbers. Never edit files.
```

| key | meaning |
| --- | --- |
| `name` | defaults to the filename |
| `description` | shown in the tool's agent list |
| `tools` | allowlist passed as `--tools`; omit for all tools |
| `model` | `provider/id`, passed as `--provider` + `--model` |
| `thinking` | passed as `--thinking` |
| `spawning` | `false` (default) keeps the child from launching grandchildren |
| `auto-exit` | `true` (default) reclaims the child once it reports; `false` leaves it live for inspection |

`spawning: false` is enforced twice: the child gets a system-prompt note, and
`PI_HC_SUBAGENT_CHILD=1` makes this extension skip registration inside it.

## Tools

### `subagent`

Launches one or more helpers and **returns immediately**.

```jsonc
{ "agent": "scout", "task": "Map the auth module", "title": "Scout: auth" }
```

Pass `children: [...]` to launch several at once. Each child becomes a herdr
terminal named after `name` (default `<agent>-<n>`), labelled
`hc.subagent=1`, `hc.agent=<agent>`, `hc.title=<title>`.

The child's report is its **last assistant message**, read from its session
file once the terminal leaves `working`. It arrives as a separate message that
starts a new turn — so the parent should not poll, and should keep working or
stop.

A child does not exit after its turn: `pi "<task>"` runs the turn and stays at
its prompt. So by default the extension **reclaims** it — `hc kill` then `hc rm`
right after the report is delivered, and the row leaves the agents panel. Set
`auto-exit: false` in the agent definition when you want to peek at the child or
send it a follow-up instead.

Names are unique among live terminals, so a repeat launch steps around a taken
name (`scout-2`, `scout-3`).

### `subagent_kill`

Stops a running child by name or terminal address, then removes its terminal
record. No report follows.

## How completion is detected

`subagent_done` is only registered for auto-exit children, so this extension
does not rely on it. Instead it polls `hc get <address> --json` every 2s and
treats the child as finished when the terminal is gone, or when it is alive but
no longer `working` after a 90s startup grace (idle, waiting for a human).

## Testing

```bash
node test/smoke.ts
```

Launches a real child, waits for its report, prints it, then checks the child's
terminal was reclaimed. Run it from a herdr-app terminal. It sets
`PI_HC_SUBAGENTS_SKIP_RIVAL_CHECK=1` because the rival guard would otherwise
refuse to load.

## Limitations

- One level deep: a child cannot spawn grandchildren.
- No live widget; progress is visible in herdr-app's agents panel.
- Reports are the child's final assistant message — no structured result schema.
