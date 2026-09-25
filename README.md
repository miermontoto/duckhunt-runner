# duckhunt-runner

Local daemon for [duckhunt](https://duckhunt.info) agent runs.

When something needs investigating — a CloudWatch alarm, a failing check, an issue — duckhunt
queues an *agent run*. This daemon claims it and launches **Claude Code headless on your own
machine**, so the agent works with your Claude login, your git checkouts and your AWS CLI. It
writes the verdict back to duckhunt as a work note, which reaches you as a push notification.

You can also start a run yourself: the *Agents* page in duckhunt is a chat with an agent running
on this machine, in a checkout of one of your repos (see [Prompt runs](#prompt-runs)).

The server never sees your credentials, your filesystem paths or your git tokens. It only ever
learns a repo's `workspace/slug` key and, optionally, an AWS account id — never where they live on
disk. With the progress feed on, it also receives what the agent says and one line per tool call
(see [Progress feed](#progress-feed)), never file contents or command output.

## Requirements

- **Node 22+**
- **[Claude Code](https://claude.com/claude-code)** installed and logged in on this machine
  (`claude`). The daemon runs `claude -p` with your session.
- A duckhunt account on the instance you are connecting to.

> `ANTHROPIC_API_KEY` in your environment silently shadows your Claude subscription login. If it is
> set and you did not mean to bill the API, unset it for the daemon's environment.

## Setup

```sh
npx duckhunt-runner login
npx duckhunt-runner repos discover ~/dev
npx duckhunt-runner start
```

That is the whole thing. Step by step:

| Command | What it does |
| --- | --- |
| `login [base-url] [label]` | Connects the daemon to your account. Opens the browser, you paste the code back. Defaults to `https://duckhunt.info`; pass a URL for another instance (`https://` is assumed if you omit the scheme). Both arguments are optional — an argument that does not look like a URL is taken as the label, which distinguishes machines if you run more than one. |
| `repos discover [dir]` | Scans a directory for git checkouts and maps each one by its `origin` remote, so an agent can read the code behind an alarm. Add `--dry-run` to see what it would map. Only the `workspace/slug` key reaches the server. |
| `repos list\|add\|remove` | Manage that map by hand: `repos add <workspace/slug> <path>`. |
| `aws add <accountId> <profile>` | Optional. Binds an AWS account id to a profile of your local AWS CLI, so the agent can read metrics, logs and resource state for that account. |
| `aws list\|remove` | Manage the AWS map. |
| `status` | Reports this machine's kit: Claude version, which credential it will use, AWS profiles and mapped repos. Run this first when something does not work. |
| `start [--verbose]` | Starts the claim loop. |

Configuration lives in `~/.duckhunt-runner.json`. It holds the base URL, the OAuth credential, the
repo and AWS maps, and optional defaults (`model`, `maxBudgetUsd`, `maxConcurrent`). Set `DUCKHUNT_RUNNER_CONFIG` to use
another file (a second account, a test instance) and `DUCKHUNT_RUNNER_HOME` to move the state
directory (`~/.duckhunt-runner`: the scratch directory and `--verbose` logs). `--version` prints the
daemon version.

### Keeping it running

`start` runs in the foreground and has to stay alive to claim runs. Use whatever your machine
already does for this — a `screen`/`tmux` session, a systemd user service, `launchd`:

```ini
# ~/.config/systemd/user/duckhunt-runner.service
[Unit]
Description=duckhunt runner

[Service]
ExecStart=/usr/bin/npx duckhunt-runner start
Restart=always

[Install]
WantedBy=default.target
```

Stopping the daemon (`ctrl-c`, `SIGTERM`) stops every run in progress, including anything their
shell commands started, and reports them as failed. A second signal exits immediately.

### Parallel runs

By default the daemon works one run at a time. Set `defaults.maxConcurrent` in the config (1 to 8)
to run several at once, and restart the daemon:

```json
{ "defaults": { "maxConcurrent": 3 } }
```

Each Claude process takes a few hundred MB, and every parallel session draws on the same Claude plan
limits. A conversation never runs twice at once: duckhunt keeps it as a single run. What the runs
share on this machine takes turns: git operations on the same checkout (fetch, worktree
creation and cleanup), automation runs in a checkout mapped with `worktree: false`, and prompt runs
with the `edit` profile and no repo (they share the scratch directory). A run waiting for its turn
still heartbeats and says so in its feed. The daemon reports its slot count, and Settings → Agents
shows how many are in use. Never run two daemons on the same config file: the credential rotates on
every refresh and duckhunt revokes it when it sees an old one again. Raise one daemon's slots instead.

## How a run works

1. **A run is queued** from duckhunt: the *investigate with agent* action on an entry, the same
   button on an alert notification, or an automation rule with that action.
2. **The daemon claims it** and gets a prompt, a tool profile and a short-lived MCP token scoped to
   that single run. It launches `claude -p` in the mapped checkout (or a scratch directory when the
   alarm has no repo).
3. **The agent investigates** and leaves its verdict as a work note on the entry. You get a push
   with a one-line summary on top and can reply to it straight from the notification.
4. **If it needs a decision from you**, it asks and ends its turn. Your answer resumes it in the
   *same* Claude session, so nothing it had already found is lost.

### What an agent is allowed to touch

For automation runs, permission is derived from the conversation, and the server enforces it on the
run's token:

| The run | Can |
| --- | --- |
| Started automatically | Read only. |
| Born from an instruction of yours | Also write inside duckhunt (create tasks, snooze the inbox, label). |
| Born from a yes/no you confirmed | Also touch the outside world — the ticket, AWS. |

So an unattended run can never change anything, and anything that leaves duckhunt needs you to have
said yes to that specific action, spelled out with the literal command.

## Prompt runs

A prompt run is a conversation you start from the *Agents* page: you pick one of the repos mapped
on this runner (or none), optionally a branch, and write what you want. The daemon runs it like any
other run, with your Claude login, and every reply or follow-up resumes the same Claude session.
Requires daemon 0.4.0+ and a Claude CLI that supports `--permission-mode`, `--strict-mcp-config`,
`--disallowedTools` and `--setting-sources`; otherwise the daemon does not offer prompt runs and is
never handed one.

### Profiles

Each conversation has a profile, chosen when it starts. The Claude CLI enforces it (tool allowlist,
deny list and an explicit `--permission-mode dontAsk`), not the prompt, and the daemon refuses a
`read` claim that would allow `Bash`, `Edit`, `Write` or `NotebookEdit`:

| Profile | Built-in tools | Also |
| --- | --- | --- |
| `read` | `Read`, `Grep`, `Glob` | duckhunt tools (notes, tasks, questions). No shell, no edits. Runs with `--setting-sources user`: your own settings, hooks and plugins apply, but the checked-out branch's `.claude/` settings and hooks do not (the agent reads the repo's `CLAUDE.md` with `Read` instead). |
| `edit` | `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write` | Git included: the agent commits, pushes or opens a pull request only when your prompt asks for it. Starting an `edit` conversation, and every later message or answer to it, asks you to confirm your identity again; its notifications have no reply buttons. |

Every prompt run uses `--strict-mcp-config`, so a `.mcp.json` in the checkout never loads.
Settings → Agents can force `read` for everything (read-only mode) or per repo, pause the runner,
or stop it from accepting prompt runs. Read-only mode applies to existing `edit` conversations from
their next step on. A per-repo `read` lock covers conversations on that repo; it is not a sandbox,
since an `edit` conversation on another repo (or none) still has a shell. Prompt runs have no turn or budget limit: each step is capped
by the wall-clock limit chosen in Settings → Agents (1 to 8 hours, 4 by default; automation runs
keep 30 minutes), and the model is your `defaults.model` (or the CLI default).
`worktree: false` and `--dangerously-skip-permissions` in the repo map only apply to automation runs.

### One worktree per conversation

A prompt run works in its own git worktree, `<checkout>/.duckhunt/worktrees/conv-<id>`. It is
created detached on `origin/<branch>` right after a `git fetch`; if the branch does not exist yet,
on the remote's default branch, and the agent creates the branch if you ask for one. A branch name
that `git check-ref-format` rejects falls back to the default branch, with a note in the feed. The
worktree survives between steps, so edits are still there when you answer a question or send a
follow-up; if you delete its directory by hand, the next step recreates it.

Each claim carries a step number that the daemon sends back with every heartbeat, progress update,
feed batch and status report. When you stop a conversation, write to it again, or duckhunt gives up
on a step, the next heartbeat tells the daemon the run is no longer its own and it kills Claude and
its whole process group; a late report from that step never closes the step that replaced it.

At most every 30 minutes the daemon removes the worktrees of conversations that duckhunt reports as
closed, and any worktree unused for 7 days, skipping those of runs it is working on. It never removes one with
uncommitted changes or with commits that no branch or remote contains: those are kept and logged, and
you can remove them with `git worktree remove` when you are done. Worktrees kept from failed
automation runs (`run-<id>`) expire after the same 7 days.

### Working in the checkout instead

When you open a conversation you can choose `checkout` instead of `worktree` (0.6.0 or later). The
agent then works in your working copy as it is: your current branch and your uncommitted changes,
with no fetch and no branch switch; the branch picker does not apply. The choice holds for the whole
conversation. Conversations on the same checkout take turns, like automation runs on a repo with
`worktree: false`. In `edit`, Claude loads the checkout's own settings, including the hooks in
`.claude/settings.local.json` that a worktree never has. The daemon adds `/.duckhunt/` to the
checkout's `.git/info/exclude` so its worktrees never show up as your changes.

### Progress feed

While a run works, the daemon streams a short feed to duckhunt with what the agent says and one line
per tool call: the tool name and a short argument (a path relative to the worktree, a search
pattern, the first line of a shell command, the task or entry a duckhunt tool touches). It never
sends tool results, file contents or command output. Paths are shortened (`.` for the worktree, `~`
for your home; a file opened outside the worktree shows only its name) and anything that looks like
a secret (AWS keys, GitHub, Slack, Atlassian, Bitbucket and Anthropic tokens, credentials in a remote
URL, `password=`/`token=`-style assignments, `Bearer` headers, private keys) is masked before it
leaves the machine, also in the final result, error and stderr; the server masks it again. Set *progress feed* to *counter only* in Settings → Agents to send just the
tool-call count.

The daemon also strips variables of the Claude Code session it may have been started from
(`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`…), empty `ANTHROPIC_*` values and a dead `SSH_AUTH_SOCK` from
the environment of each run, and disables git's terminal prompts.

## Licence

Copyright © 2026 miermontoto.

Licensed under [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/):
you may use, modify and share it for any noncommercial purpose, keeping this notice with any copy.
Commercial use needs a separate licence. See [`LICENSE`](./LICENSE).
