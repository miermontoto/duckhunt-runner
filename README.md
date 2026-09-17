# duckhunt-runner

Local daemon for [duckhunt](https://duckhunt.info) agent runs.

When something needs investigating — a CloudWatch alarm, a failing check, an issue — duckhunt
queues an *agent run*. This daemon claims it and launches **Claude Code headless on your own
machine**, so the agent works with your Claude login, your git checkouts and your AWS CLI. It
writes the verdict back to duckhunt as a work note, which reaches you as a push notification.

The server never sees your credentials, your filesystem paths or your git tokens. It only ever
learns a repo's `workspace/slug` key and, optionally, an AWS account id — never where they live on
disk.

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
repo and AWS maps, and optional defaults (`model`, `maxBudgetUsd`).

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

Permission is derived from the conversation, and the server enforces it on the run's token:

| The run | Can |
| --- | --- |
| Started automatically | Read only. |
| Born from an instruction of yours | Also write inside duckhunt (create tasks, snooze the inbox, label). |
| Born from a yes/no you confirmed | Also touch the outside world — the ticket, AWS. |

So an unattended run can never change anything, and anything that leaves duckhunt needs you to have
said yes to that specific action, spelled out with the literal command.

## Licence

Copyright © 2026 miermontoto.

Licensed under [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/):
you may use, modify and share it for any noncommercial purpose, keeping this notice with any copy.
Commercial use needs a separate licence. See [`LICENSE`](./LICENSE).
