# duckhunt-runner

Local daemon for [duckhunt](https://duckhunt.info) agent runs.

When something needs investigating — a CloudWatch alarm, a failing check, an issue — duckhunt
queues an *agent run*. This daemon claims it and launches **Claude Code headless on your own
machine**, so the agent works with your Claude login, your git checkouts and your AWS CLI. It
answers in the run's conversation in duckhunt, which reaches you as a push notification.

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
npx duckhunt-runner@0.11.0 login
npx duckhunt-runner@0.11.0 repos discover ~/dev
npx duckhunt-runner@0.11.0 start
```

Pin the version: the daemon runs `claude -p` with a shell on your machine, so install the release you
mean to run (Settings → Agents → Machines shows the commands pinned to the version duckhunt
recommends). That is the whole thing. Step by step:

| Command | What it does |
| --- | --- |
| `login [base-url] [label]` | Connects the daemon to your account. Opens the browser, you paste the code back. Defaults to `https://duckhunt.info`; pass a URL for another instance (`https://` is assumed if you omit the scheme). Both arguments are optional — an argument that does not look like a URL is taken as the label, which distinguishes machines if you run more than one. A running daemon switches to the new credential before its next claim; one connected to another instance keeps it until you restart it. |
| `repos discover [dir]` | Scans a directory for git checkouts and maps each one by its `origin` remote, so an agent can read the code behind an alarm. Add `--dry-run` to see what it would map. Only the `workspace/slug` key reaches the server. A repo checked out in more than one directory is listed but not mapped: pick one with `repos add`. |
| `repos list\|add\|remove` | Manage that map by hand: `repos add <workspace/slug> <path>`. `list` and `add` show each repo's health warnings (see below). |
| `aws add <accountId> <profile>` | Optional. Binds an AWS account id to a profile of your local AWS CLI, so the agent can read metrics, logs and resource state for that account. |
| `aws list\|remove` | Manage the AWS map. |
| `status` | Reports whether a daemon is running, this machine's kit (Claude version, which credential it will use, AWS profiles and mapped repos) and what duckhunt last said about this machine (see [Machines](#machines-and-credentials)). Run this first when something does not work. |
| `logout` | Unpairs this machine from duckhunt and deletes its credential from the config file (0.11.0 or later; see [Machines](#machines-and-credentials)). |
| `start [--verbose]` | Starts the claim loop. |

Configuration lives in `~/.duckhunt-runner.json`. It holds the base URL, the OAuth credential, this
machine's id, the repo and AWS maps, and optional defaults (`model`, `maxBudgetUsd`, `maxConcurrent`). Set `DUCKHUNT_RUNNER_CONFIG` to use
another file (a second account, a test instance) and `DUCKHUNT_RUNNER_HOME` to move the state
directory (`~/.duckhunt-runner`: the scratch directory, `--verbose` logs, the daemon lock, the
per-run MCP configs and `server-state.json`, what duckhunt last said about this machine). `--version`
prints the daemon version.

The daemon does not need a restart after `login`, `repos`, `aws` or a hand edit of the file: it
rereads the config every few seconds, even while all its slots are busy. Each command, and the
daemon itself when it rotates its token, rewrites only its own keys and replaces the file in one
step, so nothing undoes another's change. If the file does not parse (a hand edit in progress), the
daemon keeps the config it has and says so.

### Repo health

The daemon checks every mapped checkout when it starts and every 10 minutes, prints what changed,
and reports it to duckhunt, which shows it on the machine's row (Settings → Agents → Machines) and in
the repo picker and notifies you when a repo stops being usable. Only the repo key and a code travel,
never a path.

| Code | Meaning | Blocks runs |
| --- | --- | --- |
| `missing` | The mapped directory no longer exists. | yes |
| `not_git` | The directory exists but git does not recognise it as a checkout (a half-moved `.git`), or it sits inside another repo. | yes |
| `remote_mismatch` | Its `origin` points to a different repo than the key it is mapped under. | yes |
| `no_origin` | It has no `origin` remote, so the key cannot be verified. | no |
| `duplicate` | Another directory next to it is a separate clone of the same repo. Linked worktrees do not count. | no |
| `shared_path` | The same directory is mapped under several keys. | no |
| `orphan_worktrees` | Daemon worktrees nobody will clean up: ones git no longer tracks, or ones left in a checkout that is no longer mapped. They may hold uncommitted work, so they are never deleted for you. | no |

Duplicates are looked for among the siblings of each mapped checkout, one level deep, like
`repos discover`. `status` and `repos list` print the same warnings with the local paths.

#### Fixing the map from duckhunt

The mapped-repos list on the machine's row can remove a repo from this machine's map, or point it at
another folder when the daemon found more than one checkout of it (or found it somewhere else after
its folder disappeared). To make that choice possible, the daemon sends the **folder name** of each
candidate (with its parent only when two share a name), its branch, the age of its last commit and
how many files have uncommitted changes. Full paths never leave the machine.

The server never supplies a path. A folder choice is an opaque id the daemon generated itself, and
the daemon rejects any id that is not in its own current list, belongs to another repo, or whose
folder is no longer a checkout of that repo. Removing a mapping never deletes anything on disk. The
daemon writes only that entry of its map to the config file, checks again and reports back within
a few seconds.

To keep the map CLI-only on a machine, set `"remoteRepoEdits": false` under `defaults` in
`~/.duckhunt-runner.json`: the row then hides the controls.

### Keeping it running

`start` runs in the foreground and has to stay alive to claim runs. Use whatever your machine
already does for this — a `screen`/`tmux` session, a systemd user service, `launchd`:

```ini
# ~/.config/systemd/user/duckhunt-runner.service
[Unit]
Description=duckhunt runner

[Service]
ExecStart=/usr/bin/npx duckhunt-runner@0.11.0 start
Restart=always
# 78: this machine was unpaired (or its credential expired); it needs a new `login`, not a restart.
RestartPreventExitStatus=78

[Install]
WantedBy=default.target
```

Stopping the daemon (`ctrl-c`, `SIGTERM`) stops every run in progress, including anything their
shell commands started, and reports them as failed. A second signal exits immediately.

Only one daemon runs per state directory. `start` takes `~/.duckhunt-runner/daemon.lock` and refuses to
run while the daemon that holds it is alive; a lock left by a daemon that died, or from before a
reboot, is replaced. To run a
second account on the same machine, give it its own `DUCKHUNT_RUNNER_CONFIG` and `DUCKHUNT_RUNNER_HOME`.

### Machines and credentials

Each `login` registers a new credential, and duckhunt lists every machine you have paired under
Settings → Agents → Machines, where you can rename it, pause it, choose what it accepts
(conversations, unattended investigations or both), cap its slots and unpair it.

From 0.11.0 the daemon gives this machine a stable id (a random UUID, stored in the config file
together with the hostname it was created on) and announces it with every claim. Until the first
claim with a new credential, it also announces the client id that `login` replaced. When duckhunt
sees a known id from the same account, it **adopts** the existing machine: the new credential takes
over the machine's name, settings and conversations, the old credential is revoked, and no ghost
machine is left behind. Runs already in progress keep their MCP access: their per-run tokens are
only revoked when each step ends. Adoption never crosses accounts. A config file copied to another
host does not claim to be the original machine: `login` there creates a new id instead.

`duckhunt-runner logout` unpairs the machine from the machine itself: duckhunt revokes its
credential, deletes the machine and cancels the runs it had in progress (exactly what the × on its
row does), and the daemon deletes `clientId` and `refreshToken` from the config file. The maps,
defaults and machine id stay, so a later `login` pairs it again. Against a duckhunt that does not
know `logout` yet (404), or with a credential that was already dead, it only deletes the local one and
says so; a network or server error deletes nothing, so you can retry. A running daemon stops on its
next call.

When the credential is rejected (the machine was unpaired from duckhunt or with `logout`, or the
credential was revoked or expired), the daemon stops claiming, stops its runs and exits with code
**78** instead of retrying every few seconds. Run `login` again to pair it.

`status` prints what duckhunt said about this machine in the daemon's last claim, and how long ago:
its name in duckhunt, whether it is paused, what it accepts, its slot cap, why it is not getting work
(paused, no free slot, needs an update) and the worktrees kept with unsaved work. It never talks to
the server itself: refreshing the credential from a second process would rotate the running daemon's
token, which duckhunt treats as a replay.

### Parallel runs

By default the daemon works one run at a time. Set `defaults.maxConcurrent` in the config (1 to 8)
to run several at once; a running daemon picks it up within a few seconds:

```json
{ "defaults": { "maxConcurrent": 3 } }
```

Each Claude process takes a few hundred MB, and every parallel session draws on the same Claude plan
limits. A conversation never runs twice at once: duckhunt keeps it as a single run. What the runs
share on this machine takes turns: git operations on the same checkout (fetch, worktree
creation and cleanup), conversations opened in the checkout itself, and prompt runs with the `edit`
profile and no repo (they share the scratch directory). A run waiting for its turn
still heartbeats and says so in its feed. The daemon reports its slot count, and Settings → Agents
shows how many are in use. Never run two daemons on the same config file: the credential rotates on
every refresh and duckhunt revokes it when it sees an old one again. `start` refuses a second daemon
on the same state directory; raise one daemon's slots instead.

## How a run works

1. **A run is queued** from duckhunt: the *investigate with agent* action on an entry, the same
   button on an alert notification, or an automation rule with that action.
2. **The daemon claims it** and gets a prompt, a tool profile and a short-lived MCP token scoped to
   that single run. It launches `claude -p` in a worktree of the mapped checkout (or a scratch
   directory when the alarm has no repo). An automation run is a `read` conversation like any other
   (see [Prompt runs](#prompt-runs)), with an even smaller kit: no web, no memory, and no shell when
   the rule may comment on the ticket.
3. **The agent investigates** and answers in the run's conversation, on the *Agents* page. You get a
   push with a one-line summary on top and can reply to it straight from the notification.
4. **If it needs a decision from you**, it asks and ends its turn. Your answer resumes it in the
   *same* Claude session, so nothing it had already found is lost.

### What an agent is allowed to touch

For automation runs, permission is derived from the conversation, and the server enforces it on the
run's token:

| The run | Can |
| --- | --- |
| Started automatically | Read only. |
| Born from an instruction of yours | Also write inside duckhunt (create tasks, snooze the inbox, label). |
| Born from a yes/no you confirmed | Also act outside duckhunt through its tools (comment on or move the ticket). |

So an unattended run can never change anything, and anything that leaves duckhunt needs you to have
said yes to that specific action, spelled out with the literal command. Changing AWS resources or
code is never part of that: the run proposes an `edit` conversation, which you review and launch.

#### AWS accounts (0.11.0 or later)

A run carries the AWS account of its entry. The daemon maps it to the profile you bound with
`aws add`. An account this machine does not map no longer falls back to your default profile, which
may belong to another account: the AWS CLI runs with empty config and credentials files of its own
(and no profile, no keys from the environment and no instance or container credentials), so every
call fails, and the run's feed says which account to map. duckhunt already omits the AWS read
patterns for an investigation whose account this machine does not announce; this is the second line.

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
`read` claim that would allow `Edit`, `Write`, `NotebookEdit`, the whole of `Bash` or any shell
pattern other than a read-only AWS CLI one:

| Profile | Built-in tools | Also |
| --- | --- | --- |
| `read` | `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, read-only shell | duckhunt tools (notes, tasks, questions). No code execution and no edits, except Claude's own auto-memory (0.8.0 or later). Runs with `--setting-sources user`: your own settings, hooks and plugins apply, but the checked-out branch's `.claude/` settings and hooks do not (the agent reads the repo's `CLAUDE.md` with `Read` instead). |
| `edit` | `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `Bash`, `Edit`, `Write` | Git included: the agent commits, pushes or opens a pull request only when your prompt asks for it. Starting an `edit` conversation, and every later message or answer to it, asks you to confirm your identity again; its notifications have no reply buttons. |

#### Read-only shell (0.7.0 or later)

`read` means nothing gets changed, not that nothing can be looked at. The daemon announces
`read_shell` and the server stops denying `Bash` outright for `read` conversations:

- The Claude CLI approves its own read-only commands in the working directory (`cat`, `grep`, `jq`,
  `git log`/`diff`/`status`) and refuses anything that runs a program or writes a file (`npm run`,
  scripts, redirects, `git -c core.pager=…`, `rg --pre`, `find -exec`, `sort -o`…).
- With the AWS CLI installed, the agent can run `aws <service> describe-*|list-*|get-*|batch-get-*`
  and a few other reads (`logs filter-log-events`/`tail`/`start-query`, `s3 ls`,
  `cloudtrail lookup-events`, `dynamodb query`/`scan`, `sts get-caller-identity`). Each pattern is
  pinned to service and operation, because a wildcard before the operation lets writes through
  (`aws * list-*` matches `aws s3 rm s3://b --recursive --exclude list-x`). The daemon drops any
  AWS pattern that isn't a read, and always denies the reads that write a local file
  (`s3api get-object`, `glacier get-job-output` and the rest: every operation whose output the CLI
  saves to an `outfile`). The server also denies secret stores and credentials
  (`secretsmanager get-secret-value`, `ssm get-parameter*`, `ecr get-login-password`,
  `eks get-token`…), by operation name: the AWS CLI accepts abbreviated flags, so a flag can't be denied.
- `Bash` rules in the `allow` list of your user settings (`~/.claude/settings.json`) would apply to
  `read` conversations too, so the daemon mirrors them into the deny list for those runs. If that
  file can't be read, a `read` conversation gets no shell at all.
- The shell can't leave the working directory, but inside it a recursive read doesn't honour the
  `Read` deny list: `grep -R` follows symlinks, so a branch that commits a symlink to `~` or `/`
  would let it read `~/.aws` or this daemon's config. The `Read`, `Grep` and `Glob` tools do honour
  the deny list through symlinks. So before every step (0.10.2 or later) the daemon lists the
  symlinks committed in the working directory (`git ls-files`, submodules included, plus the
  daemon's own worktrees inside a checkout) and, if any of them points outside it (even one whose
  target doesn't exist yet), runs that step without the shell and without the AWS CLI; a working
  directory that contains your home or the daemon's state directory gets the same treatment, and so
  does a checkout git can't list (or a daemon worktree inside it that is no longer a git worktree).
  The feed says so with the count; the paths only go to the daemon's log. Symlinks that were never
  committed or staged (untracked or ignored), nested clones that aren't submodules and the scratch
  directory are your own local state, or the work of an `edit` step you confirmed, and aren't checked.

Older daemons keep the previous `read` profile: no shell.

#### Credential paths (0.11.0 or later)

duckhunt denies `Read` on a fixed list of home-relative credential paths in every `read` kit
(`~/.aws/**`, `~/.ssh/**`, `~/.duckhunt-runner.json`, `~/.claude/.credentials.json` and a few more),
because the server never learns your paths. The daemon adds the ones only this machine knows, without
sending them anywhere: its real config file (also when `DUCKHUNT_RUNNER_CONFIG` moves it), its state
directory (the logs, the lock, `server-state.json` and the run configs; not the scratch directory,
which is the working directory of runs without a repo), `$CLAUDE_CONFIG_DIR/.credentials.json`,
`AWS_SHARED_CREDENTIALS_FILE` and `AWS_CONFIG_FILE` when they are set, and the real path behind any
of the listed ones that is a symlink (dotfiles). A path that a Claude permission rule cannot express
(commas, brackets, wildcards) is skipped with a warning at startup.

Checked with Claude Code 2.1.296: `Read`, `Grep` and `Glob` honour these deny rules, through symlinks
and in recursive searches. The read-only shell approves nothing outside its working directory, and
inside it honours a denied path named directly but not a recursive read, which is why a committed
symlink that leaves the working directory takes the shell away for that step (see above).

#### Native memory (0.8.0 or later)

The daemon announces `native_memory` and the server stops denying `Edit` and `Write` outright for
`read` conversations. No rule allows them either, so under `dontAsk` the Claude
CLI only lets them write inside its own auto-memory directory (the one it loads at the start of every
session in that repo) and refuses every other path. The daemon still refuses a `read` claim that
allows them.

- `Edit`/`Write` rules in the `allow` list of the settings a run loads would open more than that, so
  the daemon mirrors them into the deny list: your user settings for `read` conversations
  (automation runs included); user, project and local settings for the legacy automation runs of an
  older duckhunt. If a settings file can't be read, those tools are denied outright (and the run
  gets no memory).
- Automation runs get no memory: they process alerts nobody reviewed, and whatever they wrote would load
  into your later sessions. The server keeps denying `Edit` and `Write` for them; the daemon would still
  mirror rules and re-deny both under `--dangerously-skip-permissions` if that ever changed.
- `edit` conversations always could write their memory: the agent is now told it may, outside its
  worktree too.

Older daemons keep `Edit` and `Write` denied in `read` conversations.

A `read` conversation or an automation run can also propose a write-enabled agent instead of only
describing a change. The proposal shows up in its thread; launching it opens the usual composer,
prefilled with the proposed prompt and the same repo, branch and anchor, and starts a new `edit`
conversation (with the identity check) linked to the one that proposed it. This needs no daemon
change.

Every prompt run uses `--strict-mcp-config`, so a `.mcp.json` in the checkout never loads.
Settings → Agents can force `read` for everything (read-only mode), and Settings → Agents → Repos
per repo. Settings → Agents → Machines pauses all your agents or one machine, and chooses what each
machine accepts. Read-only mode applies to existing `edit` conversations from
their next step on. A per-repo `read` lock covers conversations on that repo; it is not a sandbox,
since an `edit` conversation on another repo (or none) still has a shell. Conversations you start
have no turn or budget limit: each step is capped by the wall-clock limit chosen in Settings → Agents
(1 to 8 hours, 4 by default), and the model is your `defaults.model` (or the CLI default). Automation
runs keep 30 minutes per step and, from 0.11.0, their budget again when you pay with an API key
(`ANTHROPIC_API_KEY`) or set `defaults.maxBudgetUsd`.
`worktree: false` and `--dangerously-skip-permissions` in the repo map are deprecated (0.11.0) and go
away in 0.12.0: nothing a current duckhunt sends applies them, because every conversation, automation
runs included, is a prompt run with its own worktree (or the checkout, when you choose it). They only
affect the legacy automation runs an older duckhunt server queued; `repos add`, `repos list` and
`status` say they are ignored.

Each step's MCP config, which holds the run's token, is written to `~/.duckhunt-runner/run-config/`
(a `0700` directory, files `0600`) and deleted when the step ends; the daemon removes any left
behind by a daemon that died when it starts. Every run, `read` or `edit`, has `Read` denied on that
directory (Claude still loads its own `--mcp-config` from it), and no run's working directory is
inside it, so a `read` run can't read the token of a run in another slot. An `edit` run's shell
still could: it runs only after you confirm your identity. Daemons before 0.10.2 used the system
temp directory; from 0.11.0 the daemon removes, once when it starts, the ones they left there
(`duckhunt-runner-<run>-<hex>.json`, your own regular files only).

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
you can remove them with `git worktree remove` when you are done. From 0.11.0 the daemon also tells
duckhunt how many changed files and unpushed commits each kept conversation worktree holds (counts
only, never paths), and the conversation shows it with a button that asks the agent to commit them.
Worktrees kept from failed automation runs (`run-<id>`) expire after the same 7 days.

### Working in the checkout instead

When you open a conversation you can choose `checkout` instead of `worktree` (0.6.0 or later). The
agent then works in your working copy as it is: your current branch and your uncommitted changes,
with no fetch and no branch switch; the branch picker does not apply. The choice holds for the whole
conversation. Conversations on the same checkout take turns. In `edit`, Claude loads the checkout's
own settings, including the hooks in `.claude/settings.local.json` that a worktree never has. The
daemon adds `/.duckhunt/` to the checkout's `.git/info/exclude` so its worktrees never show up as
your changes.

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
