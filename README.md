# duckhunt-runner

Local daemon for [duckhunt](https://duckhunt.info) agent runs.

When something needs investigating — a CloudWatch alarm, a failing check, an issue — duckhunt
queues an *agent run*. This daemon claims it and launches **Claude Code headless on your own
machine**, so the agent works with your Claude login, your git checkouts and your AWS CLI. It
answers in the run's conversation in duckhunt, which reaches you as a push notification.

You can also start a run yourself: the *Agents* page in duckhunt is a chat with an agent running
on this machine, in a checkout of one of your repos (see [Prompt runs](#prompt-runs)).

From 0.13.0 the daemon can also take runs from other platforms that speak the same open protocol
(see [Platforms](#platforms-0130-or-later)), let a run browse with a session you saved (see
[Browser sessions](#browser-sessions-0130-or-later)) and run an agent with no server at all (see
[Local runs](#local-runs-runner-run-0130-or-later)). duckhunt stays the built-in platform. **Read
[Upgrading to 0.13.0](#upgrading-to-0130) first**: runs without an AWS account change.

The server never sees your credentials, your filesystem paths or your git tokens. It only ever
learns a repo's `workspace/slug` key and, optionally, an AWS account id — never where they live on
disk. With the progress feed on, it also receives what the agent says and one line per tool call
(see [Progress feed](#progress-feed)), never file contents or command output. The one exception is
the diff of what an `edit` conversation changed in its repo, so you can review it in the conversation
(see [Code changes per turn](#code-changes-per-turn-0140-or-later)).

## Requirements

- **Node 22+**
- **[Claude Code](https://claude.com/claude-code)** installed and logged in on this machine
  (`claude`). The daemon runs `claude -p` with your session.
- A duckhunt account on the instance you are connecting to.

> `ANTHROPIC_API_KEY` in your environment silently shadows your Claude subscription login. If it is
> set and you did not mean to bill the API, unset it for the daemon's environment.

## Upgrading to 0.13.0

From 0.13.0 the daemon builds each run's Claude tool lists itself, from the permissions duckhunt sends
in a platform-neutral form, instead of taking duckhunt's lists as they come (see
[Tool lists](#tool-lists-built-by-the-daemon-0130-or-later)). For almost every run the result is the
same. The exception is AWS:

- **A run without an AWS account no longer inherits this machine's AWS.** Before, a run whose entry
  had no AWS account (or only a region) used your environment's default profile: read-only patterns in
  a `read` run, the whole AWS CLI through the shell in an `edit` one. Now it gets an empty AWS config.
- **To keep the old behaviour**, map your default identity: `duckhunt-runner resource add aws default
  <profile> [region]`. The daemon then tells duckhunt it exposes `default`, and duckhunt grants it to
  runs without an account: read-only in `read` runs, the whole AWS CLI in `edit` runs.
- Runs whose account you mapped with `aws add` behave as before, and so does an account you did not
  map (empty AWS, with a note in the feed).
- The daemon warns once when it starts if this machine has AWS configured (the AWS CLI, AWS variables
  or `~/.aws`) and `default` is not exposed to duckhunt.
- **To go back entirely**, set `"defaults": { "toolsetRender": false }` in the config file: the daemon
  launches with duckhunt's lists again, only compares them with its own, announces neither
  `toolset_render` nor `default`, and does not warn. Browser sessions need the switch on.

A run from a duckhunt that does not send the neutral form yet launches exactly as in 0.12.0.

## Setup

```sh
npx duckhunt-runner@0.13.0 login
npx duckhunt-runner@0.13.0 repos discover ~/dev
npx duckhunt-runner@0.13.0 start
```

Pin the version: the daemon runs `claude -p` with a shell on your machine, so install the release you
mean to run (Settings → Agents → Machines shows the commands pinned to the version duckhunt
recommends). That is the whole thing. Step by step:

| Command | What it does |
| --- | --- |
| `login [base-url] [label]` | Connects the daemon to your account. Opens the browser, you paste the code back. Defaults to `https://duckhunt.info`; pass a URL for another instance (`https://` is assumed if you omit the scheme). Both arguments are optional — an argument that does not look like a URL is taken as the label, which distinguishes machines if you run more than one. A running daemon switches to the new credential before its next claim; one connected to another instance keeps it until you restart it. |
| `repos discover [dir]` | Scans a directory for git checkouts and maps each one by its `origin` remote, so an agent can read the code behind an alarm. Add `--dry-run` to see what it would map. Only the `workspace/slug` key reaches the server. A repo checked out in more than one directory is listed but not mapped: pick one with `repos add`. |
| `repos list\|add\|remove` | Manage that map by hand: `repos add <workspace/slug> <path>`. `list` and `add` show each repo's health warnings (see below). |
| `aws add <accountId> <profile> [region] [--s3-read [bucket[/prefix]]…]` | Optional. Binds an AWS account id to a profile of your local AWS CLI, so the agent can read metrics, logs and resource state for that account. `--s3-read` (0.13.0 or later) also lets runs read S3 objects (see [S3 object reads](#s3-object-reads-0130-or-later)). |
| `aws list\|remove` | Manage the AWS map. |
| `resource list\|add\|remove\|check [repo\|aws\|browser]` | The same maps by resource type (0.13.0 or later): `repos`, `aws` and `browser` are its `repo`, `aws` and `browser` types, with the same output and exit codes (`resource discover repo` is `repos discover`). `resource add aws default <profile> [region]` maps the machine's default AWS identity (see [AWS accounts](#aws-accounts-0110-or-later)). `resource check` prints the repo and browser warnings and exits 1 if one blocks runs. |
| `browser login\|list\|check\|remove` | Browser sessions saved on this machine (0.13.0 or later; see [Browser sessions](#browser-sessions-0130-or-later)). |
| `status [--platforms]` | Reports whether a daemon is running, this machine's kit (Claude version, which credential it will use, AWS profiles and mapped repos) and what duckhunt last said about this machine (see [Machines](#machines-and-credentials)). Run this first when something does not work. `--platforms` shows each platform instead (see [Platforms](#platforms-0130-or-later)). |
| `logout [id]` | Unpairs this machine from duckhunt and deletes its credential from the config file (0.11.0 or later; see [Machines](#machines-and-credentials)). With an id, does the same for another platform. |
| `login <url> --as [id]`, `platforms …`, `audit …` | Add and manage other platforms, and read what each one ran here (0.13.0 or later; see [Platforms](#platforms-0130-or-later)). |
| `start [--verbose]` | Starts the claim loop. |
| `run [flags] "<prompt>"` | Runs an agent on this machine with no server (0.13.0 or later; see [Local runs](#local-runs-runner-run-0130-or-later)). `run` with no prompt still starts the daemon, with a deprecation warning. |

Configuration lives in `~/.duckhunt-runner.json`. It holds the base URL, the OAuth credential, this
machine's id, the repo and AWS maps, and optional defaults (`model`, `maxBudgetUsd`, `maxConcurrent`, `auditRetentionDays`, `toolsetRender`). Set `DUCKHUNT_RUNNER_CONFIG` to use
another file (a second account, a test instance) and `DUCKHUNT_RUNNER_HOME` to move the state
directory (`~/.duckhunt-runner`: the scratch directory, `--verbose` logs, the daemon lock, the
per-run MCP configs and `server-state.json`, what duckhunt last said about this machine; from 0.13.0
also `audit/`, `platforms/<id>/` for other platforms, `browser-vault/` for saved browser sessions and
`sockets/` for `runner run`). `--version` prints the daemon version.

From 0.13.0 the same file can also hold `platforms` (other platforms and your settings for each, see
[Platforms](#platforms-0130-or-later)), `resources` (resource types other than repos and AWS: today
`browser`), `providers` (where to find odysea and the vault) and `version: 2`. These keys only appear once you use something that needs them, so a file
without them is exactly what 0.12.0 wrote, and the duckhunt credential and the repo and AWS maps stay
in their usual keys either way. An older daemon on the same file keeps working and leaves the new keys
alone (daemons before 0.10.1 rewrite the whole file and drop them). A file with a `version` this daemon
does not know is refused rather than half-read.

The daemon does not need a restart after `login`, `repos`, `aws`, `resource`, `browser`, `platforms` or a hand edit of the file: it
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
ExecStart=/usr/bin/npx duckhunt-runner@0.13.0 start
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
**78** instead of retrying every few seconds. It also deletes that credential from the config file,
just like `logout` (0.13.1 or later), so unpairing a machine from duckhunt is enough: you don't need to
run `logout` on it. If a `login` replaced the credential in the meantime, the new one is kept. A
read-only config file is left as it is, with a warning. Run `login` again to pair it. With other platforms
configured (0.13.0 or later), only the platform whose credential died stops, along with its runs; the
daemon exits with 78 when none is left usable, and a new `login` brings that platform back without a
restart.

The machine's label is `label` from the config, or the hostname. From 0.13.0 a label longer than
duckhunt accepts (100 characters) is clipped, and a blank one falls back to the hostname; before,
duckhunt refused every claim with it.

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
shows how many are in use. With other platforms (0.13.0 or later), `maxConcurrent` is the pool they
all share, each one capped by its own `slots`, and a slot that frees up goes to the next waiting
platform in turn. Never run two daemons on the same config file: the credential rotates on
every refresh and duckhunt revokes it when it sees an old one again. `start` refuses a second daemon
on the same state directory; raise one daemon's slots instead.

## How a run works

1. **A run is queued** from duckhunt: the *investigate with agent* action on an entry, the same
   button on an alert notification, or an automation rule with that action (or one that runs a
   prompt of yours, see below).
2. **The daemon claims it** and gets a prompt, a tool profile, the model to use and a short-lived MCP
   token scoped to that single run. It launches `claude -p` in a worktree of the mapped checkout (or a
   scratch directory when the alarm has no repo). An investigation is a `read` conversation like any
   other (see [Prompt runs](#prompt-runs)), with an even smaller kit: no web, and no shell when the
   rule may comment on the ticket. Whether it can extend Claude's native memory is your choice (see
   [Native memory](#native-memory-080-or-later)).
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

So an unattended investigation can never change anything, and anything that leaves duckhunt needs you
to have said yes to that specific action, spelled out with the literal command. Changing AWS resources
or code is never part of that: the run proposes an `edit` conversation, which you review and launch.

A rule can also *run a prompt* you wrote (on a schedule, when an entry is created, updated or
notified, or when you move a task; a move by someone you share the workspace with never starts it). That run starts with your instruction, so it may also write inside
duckhunt (create, move and organise tasks, label, take notes) and read the repo you chose. With the
`edit` profile, which you arm once with the identity check when you save the rule, it may also change
code in its own worktree, never in your checkout; below the confirmed tier its deny list also blocks
`git push`, `git remote` and `gh` (a best-effort guard, not a sandbox). Anything that leaves duckhunt
(a Jira comment or transition, an email, a pull request) still needs your yes in that run.

#### AWS accounts (0.11.0 or later)

A run carries the AWS account of its entry. The daemon maps it to the profile you bound with
`aws add`. An account this machine does not map no longer falls back to your default profile, which
may belong to another account: the AWS CLI runs with empty config and credentials files of its own
(and no profile, no keys from the environment and no instance or container credentials), so every
call fails, and the run's feed says which account to map. duckhunt already omits the AWS read
patterns for an investigation whose account this machine does not announce; this is the second line.

From 0.13.0 a run without an account gets an empty AWS config too, unless you map the machine's
default identity under the key `default` (`resource add aws default <profile> [region]`; `aws add`
still takes only account ids). Nothing creates it for you. When it is exposed to duckhunt (it is by
default, like every AWS key), the daemon announces that it has one, never its profile, and duckhunt
grants it to runs without an account (see [Upgrading to 0.13.0](#upgrading-to-0130)). Other platforms
ask for AWS by key (see [Platforms](#platforms-0130-or-later)), and their runs get no AWS at all
unless they are granted a key you exposed to them.

#### S3 object reads (0.13.0 or later)

A `read` run can list S3 (`aws s3 ls`) but not read objects: `s3api get-object` needs a local output
file, and a permission rule can't limit `get-object` or `aws s3 cp` to stdout, so both stay denied.
To let investigations read objects such as ALB access logs, opt in per AWS key:

```sh
duckhunt-runner aws add <account-id> <profile> [region] --s3-read acme-alb-logs/AWSLogs/
duckhunt-runner aws add <account-id> <profile> [region] --s3-read      # any bucket the profile can read
```

The targets are `bucket` or `bucket/prefix`. They are stored as `aws.<key>.s3Read` (`true` or a
list) and shown by `aws list`. Running `aws add` again without the flag removes it.
`resource add aws` takes the same flag, including for the `default` key.

A run that has a grant for that key then gets one more MCP server, `res_aws_<key>`. It is the runner
itself (a hidden `mcp-s3` subcommand) with only the run's AWS settings, `PATH`, `HOME` and the
allowed targets in its environment. Its single tool, `s3_read {bucket, key, offset?, maxBytes?, region?}`:

- refuses anything outside the allowed buckets and prefixes;
- checks the size first (`head-object`) and won't read an object over 256 MB compressed;
- streams it with `aws s3 cp s3://… -` (stdout only, no shell), gunzipping `.gz` objects, and stops as
  soon as it has the requested window: at most 512 KB of text per call, never past 64 MB of
  decompressed data. The reply says which bytes it holds and the `offset` to continue from;
- returns text only: for a binary object (NUL bytes) it reports the size read, not the content.

It never writes a local file and has no upload path. The feed shows `s3://bucket/key` and the window
asked for, never the content. It is offered only when the daemon builds the run's tool lists (the
default from 0.13.0, v0 platforms and `runner run`); with `defaults.toolsetRender: false` the run
gets a note instead. An `edit` run gets it too, though its shell could already read the object.

## Prompt runs

A prompt run is a conversation you start from the *Agents* page: you pick one of the repos mapped
on this runner (or none), optionally a branch, and write what you want. The daemon runs it like any
other run, with your Claude login, and every reply or follow-up resumes the same Claude session.
Requires daemon 0.4.0+ and a Claude CLI that supports `--permission-mode`, `--strict-mcp-config`,
`--disallowedTools` and `--setting-sources`; otherwise the daemon does not offer prompt runs and is
never handed one.

### Model (0.12.0 or later)

The model is the one duckhunt asks for: your default in Settings → Agents, the one you pick in the
composer or later in the thread, or the one set on a rule action. When duckhunt asks for none, the
daemon uses `defaults.model` from the config file, and without that the Claude CLI default. A model you
change in the thread applies from the next step on, resumed sessions included. The daemon only passes a
model alias or id (`opus`, `sonnet`, `claude-opus-5-5`…) and ignores anything else with a note in the
feed; the run then uses this machine's model.

It announces the `model` capability only when `claude --help` lists `--model`, and duckhunt only sends
a model to daemons that announce it, so an older daemon keeps using `defaults.model`. The model each
run reports back is the one its main loop used (the CLI's init event), not the small auxiliary model
the CLI also calls for titles and summaries. `status` prints the capabilities this machine announces
(`capacidades`, `model` among them) and `start` logs them when it starts.

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
(commas, brackets, wildcards) is skipped with a warning at startup. From 0.13.0 that includes the
audit directory (from the first start after it exists), and every run is also denied the state of the
other platforms: their logs, run configs, `server-state.json`, audit and scratch directory,
including a platform added while the daemon runs (from its next step). Once a browser session is
configured, every run, `edit` included, is also denied the browser vault (see
[Browser sessions](#browser-sessions-0130-or-later)).

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
- **A symlinked project folder blocks memory writes.** If `~/.claude/projects/<repo>` (or its
  `memory/`) is a symlink to somewhere outside `~/.claude`, as GNU stow does with a dotfiles repo,
  runs can still edit `MEMORY.md` but every other memory file they write is refused ("denied
  because Claude Code is running in don't ask mode"). The Claude CLI resolves the link before applying
  the auto-memory exception, and under `dontAsk` no allow rule or `--add-dir` brings it back (checked
  with the CLI 2.1.304), so the daemon can't work around it. Keep those folders as real directories
  for the repos your runs work on, and link the dotfiles side to them instead.
- duckhunt can now let investigations and rule runs extend Claude Code's native memory too: a setting
  of yours in Settings → Agents, on by default (nothing changes in the daemon; the server just stops
  denying `Edit` and `Write` for them). Repo runs write the repo's memory, the one your interactive
  sessions in that repo load. Repo-less runs share the scratch directory's memory with your repo-less
  conversations. Those runs process content nobody reviewed (an alert, a ticket), and whatever they
  write loads into your later sessions: turn the setting off if you do not want unattended content in
  your memory. The daemon still mirrors your rules and, for the legacy automation runs of an older
  duckhunt under `--dangerously-skip-permissions`, denies both again.
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
(1 to 8 hours, 4 by default), and the model is the one duckhunt asks for (see
[Model](#model-0120-or-later)). Automation runs keep 30 minutes per step and, from 0.11.0, their
budget again when you pay with an API key (`ANTHROPIC_API_KEY`) or set `defaults.maxBudgetUsd`.
`worktree: false` and `--dangerously-skip-permissions` in the repo map are deprecated (0.11.0) and go
away in a later release: nothing a current duckhunt sends applies them, because every conversation,
automation runs included, is a prompt run with its own worktree (or the checkout, when you choose it).
They only affect the legacy automation runs an older duckhunt server queued; `repos add`, `repos list`
and `status` say they are ignored.

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
tool-call count. From 0.13.0, what the agent types or evaluates in a tool that is not the platform's
own (the `value` of a form fill, a script it runs in a page) shows only its length, and a URL shows
only its origin and path, never its query or fragment. Browser tools get a summary of their own: the
selector of a `fill` or `select_option`, `js ‹length›` for an `evaluate`, the action of a dialog and
the key pressed.

### Code changes per turn (0.14.0 or later)

When an `edit` conversation works in a repo, duckhunt asks the daemon for the diff of each turn, and
the conversation shows it under the turn: the files it changed with their line counts, and each file's
diff on demand. Read-only steps, runs without a repo and older servers get nothing: the daemon only
does it when the claim asks for it.

- The daemon snapshots the working tree when the turn starts and again when it ends, before the
  worktree is released. Each snapshot is a git tree built with a temporary index (`git add -A` +
  `git write-tree`), so it counts files created from the shell or by a generator, follows
  `.gitignore` (an ignored `.env` never leaves the machine) and never touches your index or branch.
  The snapshots leave loose objects in the repo, which `git gc` removes in time.
- The diff ignores your git config where it would change its shape or run programs: fixed `a/`/`b/`
  prefixes, no colour, no external diff or textconv, unquoted paths.
- Secrets are masked per file. Config files (`.env*`, YAML, `.properties`, `.ini`, `.toml`, `.cfg`,
  `.conf`, Dockerfiles) get the feed's full masking. In code, the same token formats are masked, but a
  `password`, `token`, `secret` or `api_key` assignment only when its value is a quoted string or the
  line is an env file's (`DB_PASSWORD=…`), so code like `password: string` stays readable. duckhunt
  masks it all again. Paths are relative to the repo.
- Limits per turn: 300 files, 64 KB per file and 256 KB in total. A file over a limit, or a binary,
  is listed with its counts but without its diff.
- It is uploaded after the feed and before the step's status. If git or the upload fails, the turn
  just shows no changes; the run is never affected.
- In the checkout (instead of a worktree), the snapshots also catch what you edit there while the turn
  runs.

The daemon also strips variables of the Claude Code session it may have been started from
(`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`…), empty `ANTHROPIC_*` values and a dead `SSH_AUTH_SOCK` from
the environment of each run, and disables git's terminal prompts.

## Platforms (0.13.0 or later)

duckhunt is the built-in platform: `login` and `logout` without an id are still the duckhunt ones,
and it keeps its current protocol (`duckhunt-42`) even against a duckhunt that already publishes the
new one. Other platforms speak `agent-runner/0`, an open protocol they describe at
`/.well-known/agent-runner`. Each one gets its own credential, its own state directory and its own
worktrees (`<checkout>/.runner/worktrees/<id>/`), and sees only what you expose to it.

### Adding one

```sh
npx duckhunt-runner@0.13.0 login https://platform.example --as acme --name "Acme"
```

`login <url> --as [id] [--name <name>] [--trusted]` reads the platform's discovery document and its
OAuth metadata, registers this machine, and asks you to open a URL and paste the code back, like the
duckhunt `login`. Every OAuth endpoint has to be on the platform's own origin, the platform has to
serve HTTPS (plain HTTP only on localhost, for development) and support PKCE `S256`; otherwise
nothing is sent. Without a value, `--as` derives the id from the platform's host. `duckhunt` and
`local` are reserved. Logging in again with the same id and the same platform renews the credential
and keeps everything you set for it; an id already used by another platform is refused.

A platform without a discovery document can only be added with `--trusted`: it then speaks the
duckhunt protocol, in which this machine cannot apply your limits (see below).

A new platform starts with nothing exposed, one slot and the lowest ceiling: no shell, no edits, no
memory, no web, no push and no access to any resource. It can still call its own MCP tools
(`platformTools: "*"`), which only ever reach that platform. To let it work on a repo, expose the key
*and* give the type an `access` level in its ceiling, by editing the config file (example below). A
running daemon picks it up within a few seconds.

| Command | What it does |
| --- | --- |
| `platforms list` | Every platform with its protocol, server, whether it is trusted, paused, its slots and what it can see. Never contacts a server. |
| `platforms pause\|resume <id>` | Stop or resume claiming; runs in progress finish. |
| `platforms expose\|unexpose <id> <type> <key\|*>` | What it can see of this machine: `repo`, `aws` and `browser` keys you mapped, or `*` for all of a type, including those you map later. |
| `platforms trust\|untrust <id>` | Whether it may get a full shell (see below). `untrust` lowers a full-shell ceiling to the read-only shell. |
| `platforms remove <id>` | Unpairs it on its server and deletes its entry. Its directories stay, since they may hold work, and the command prints where. |
| `logout <id>` | Unpairs it and deletes only its credential. |

duckhunt can be paused and its exposure edited (by default it sees every repo and AWS key, as
before, but no browser session until you run `platforms expose duckhunt browser <key>`), but not
removed or untrusted: `logout` unpairs it. `local` is the platform behind `runner run` (see
[Local runs](#local-runs-runner-run-0130-or-later)): it exists without an entry, is trusted, has the
whole ceiling and sees nothing until you expose it.

### What a platform may do

What a run can do is what the platform asks for, intersected with the ceiling you set for that
platform in the config file:

```json
{
  "platforms": {
    "acme": {
      "expose": { "repo": ["acme/api"] },
      "ceiling": { "shell": "read", "fsWrite": false, "memory": false, "web": true, "vcsPush": false, "access": { "repo": "read" }, "platformTools": "*" },
      "slots": 1,
      "runsPerDay": 20
    }
  }
}
```

For an `agent-runner/0` platform, this daemon enforces it. It builds the Claude tool lists itself from
the platform's request cut down to the ceiling, never from lists the platform sends, and a `read`
run never edits or gets a full shell. A resource is only materialized when the platform asks for it,
you exposed that key to it, and its type has an `access` level in the ceiling. A run without an AWS
grant gets an empty AWS config. A claim that asks for an unknown resource type, a key you did not
expose, a type the ceiling does not allow, or a policy field this daemon does not know is refused and
reported as failed, with a code and no paths. Its MCP servers have to be on the platform's own
origin, so a platform cannot point a run at another host or at a service on your machine.

`shell: "full"` is only allowed for platforms you marked `trusted` (`login --trusted` or
`platforms trust`); the config is invalid otherwise. A second platform that speaks the duckhunt
protocol only runs when trusted, because on that protocol the ceiling cannot be applied.

**Quotas.** `slots` (1 by default) caps its runs within `defaults.maxConcurrent`. `budgetUsdPerDay`
and `runsPerDay` cap a local day, counted from the [audit](#status-and-audit); once reached, the
platform stops claiming until midnight while the others carry on. On a Claude subscription the cost
is the one Claude reports, not what you are billed.

**Identity.** Each platform other than duckhunt is announced a machine id derived from a secret
stored in the config file (`machineSecret`) and the platform's address, so two platforms cannot tell
they share a machine by its id. duckhunt keeps its id. `label` under a platform overrides the label it
sees.

### Isolation between platforms

Kept apart: credentials (each refresh writes only its own), run configs with their tokens, scratch
directories, worktrees, logs, `server-state.json` and audit files. Every run's `Read` deny covers the
other platforms' state.

Not kept apart:

- A full shell. `Read` denies do not bind `Bash`, so an `edit` run can read this config file, which
  holds every platform's refresh token, and the tokens of runs in other slots. Only give
  `shell: "full"` to platforms you trust; that is what the `trusted` flag is for.
- Claude's native memory is stored by directory, so runs of different platforms in the same repo, and
  your own sessions there, share it. Leave `memory` off in a ceiling to keep a platform out of it.
- A platform can notice the machine is busy when its claims stop being served, though not by whom.

### Status and audit

`status --platforms` shows each platform: protocol, credential, local state (active, paused, out of
its daily quota…), what its server last said and when, quota use, a summary of its ceiling, what it
can see with the health of those repos, and its audit for the last 24 hours. Like `status`, it never
contacts a server; plain `status` prints what it always did.

The daemon keeps an audit of every platform's runs, duckhunt's included, in
`~/.duckhunt-runner/audit/<id>/YYYY-MM.jsonl` (files `0600`): one line when a run is claimed, one when
a claim is refused (with its code) and one when each step closes. It records ids, times, resource
keys and access levels, MCP server names, the model, tool names with their counts, cost, the outcome
and a SHA-256 of the prompt. It never records the prompt, results, tool arguments, paths or tokens.
A month's file is deleted once that month ended more than `defaults.auditRetentionDays` (180) ago,
and each platform keeps at most 50 MB, oldest months first, never the current one.
`audit [--platform <id>] [--since 7d|<date>] [--json]` prints it (the last 7 days by default).

### Tool lists built by the daemon (0.13.0 or later)

0.13.0 announces `toolset_v1` and `toolset_render`. duckhunt then sends each run's permissions in the
platform-neutral form next to its usual tool lists, and the daemon launches the run with the lists it
builds itself, capped by duckhunt's ceiling. The run's resources (its repo, its AWS key, a browser
session) come from the grants in that form, so a key you did not expose to duckhunt is refused rather
than used. Worktree paths do not change.

The daemon still compares its lists with duckhunt's and reports in each step's status whether they
match; duckhunt logs only a difference the daemon cannot explain. With
`"defaults": { "toolsetRender": false }` it launches with duckhunt's lists again and only compares
(see [Upgrading to 0.13.0](#upgrading-to-0130)).

## Browser sessions (0.13.0 or later)

A run can browse with a session you logged into yourself, such as your Jira or an admin console, without
the agent ever seeing your password. The browser is [odysea](https://github.com/miermontoto/odysea), an
MCP server installed separately (0.5.1 or later): the daemon finds it on `PATH` or at
`providers.browser.bin`, and launches it as its own process for each run. It never loads a browser
itself.

On npm it is `@miermontoto/odysea` (the unscoped `odysea` package is an unrelated project). Set
`providers.browser.bin` to the installed binary's absolute path, so the daemon never depends on what
`PATH` resolves:

```sh
npm i -g @miermontoto/odysea
```

Before using a binary, the daemon asks it for its identity (`odysea --identify`) and only accepts
`@miermontoto/odysea` 0.5.1 or later; anything else counts as odysea missing. That keeps an unrelated
program called `odysea` from being handed a copy of your session by accident. It is not protection
against a binary made to impersonate it: whatever is on your `PATH` already runs as you.

```sh
duckhunt-runner browser login jira https://acme.atlassian.net --origin https://acme.atlassian.net --origin https://id.atlassian.com
duckhunt-runner platforms expose duckhunt browser jira
```

| Command | What it does |
| --- | --- |
| `browser login <key> <url> [--origin <pattern> …] [--session <name>] [--exclusive] [--probe-url <url> [--login-pattern <regex>]]` | Opens a visible odysea window on `<url>` so you log in, then saves the session in the vault (`~/.duckhunt-runner/browser-vault/`, or `providers.browser.vaultDir`; `0700`). The entry is only saved if odysea saved a session. Without `--origin` it keeps the previous origins or, for a new key, uses the URL's origin. |
| `browser list` | Each session with its origins and health. |
| `browser check [key]` | Health, running each session's probe now (see below). Exits 1 if one is unusable. |
| `browser remove <key> [--purge]` | Removes the entry. `--purge` also deletes the saved session, unless another key uses it. |

**Origins** (`scheme://host[:port]`, `*.` for any subdomain, never a wildcard on fewer than two
labels) are the only part of the session a run gets: list the sign-in host too when the site logs you
in through another domain, or the session will look expired. **`--exclusive`** makes runs take turns on
the session and write back what they change (a site that rotates its token keeps working).
**`--probe-url`** is a page that tells whether you are still logged in (a redirect matching
`--login-pattern`, or a 401/403). The daemon checks each session every 10 minutes from the saved file
alone, and runs its probe at most once a day, since that opens a browser.

No platform sees a session until you expose it (`platforms expose <id> browser <key>`). duckhunt then
offers it in the composer, next to the model, where you choose what the run may do, and shows each
machine's sessions with their health under Settings → Agents → Machines. It only sends a run with a
session to a machine that has odysea and builds the tool lists itself (see
[Tool lists](#tool-lists-built-by-the-daemon-0130-or-later)).

| Access | Browser tools |
| --- | --- |
| `read` | `navigate`, `reload`, `back`, `tabs`, `resize`, `scroll`, `hover`, `wait_for`, `screenshot`, `dom_snapshot`, `dom_query`, `console_messages`, `network_requests` |
| `interact` | also `click`, `fill`, `press_key`, `select_option`, `handle_dialog` |
| `full` | also `evaluate` and `network_details` (request headers, cookies included) |

The `session` tool is never allowed. duckhunt gives a `read` conversation `read` (or `interact`, if you
turn that on in Settings → Agents, which asks you to confirm your identity) and never `full`.

**What a run gets.** Its own MCP server, `res_browser_<key>`, with a copy of the session filtered by
the daemon to the session's origins: cookies of those hosts (and parent-domain cookies they need),
their local storage and IndexedDB, no expired cookies. The copy lives in the run's private config
directory and is deleted when the step ends. An exclusive session writes back only what changed on
its origins, never anything the run collected from other sites, and never when the run was aborted
before it started. A session that is missing, unreadable, expired or logged out fails the run before
it launches, with the reason and no paths. A key this machine does not map, or a machine without
odysea, runs without a browser and says so in the feed. A run waiting for an exclusive session says
so too.

**Limits.**

- odysea's navigation allowlist covers the pages a run opens, not the requests a page makes, so
  cookies from other sites can land in a run's copy. They are never written back.
- Every run's `Read` deny covers the vault, but `Read` denies do not bind `Bash`: an `edit` run's
  shell can read every saved session. Only give a full shell to platforms you trust.
- A session's cookies are as good as your login while they last. Expose a session only to the
  platforms you would hand that login to, and pick the lowest access that does the job.

## Local runs: `runner run` (0.13.0 or later)

`run` starts an agent on this machine with no server: you are the platform (`local`), and the answer
goes to stdout, so `$(duckhunt-runner run …)` captures it while the feed goes to stderr.

```sh
duckhunt-runner platforms expose local repo acme/api
duckhunt-runner run --repo acme/api "why does the nightly import fail?"
```

| Flag | Effect |
| --- | --- |
| `--repo <ws/slug> [--branch <branch>]` | Works in a worktree of that mapped repo. |
| `--profile read\|edit` | `read` (default): read-only shell, no edits, memory and web. `edit`: full shell and edits. |
| `--push` | Allows `git push`. |
| `--grant <type:key[:access]>` | Adds a resource, such as `--grant browser:jira:interact` or `--grant aws:123456789012`. `read` by default. |
| `--model <model>` | The model for the run. |
| `--yes` | Accepts the escalation without asking. |
| `--json` | NDJSON on stdout of the conversation's messages instead (claim, event, question, result). Never prompts. |
| `--wait <duration>` | Gives up if no slot frees within it (`30s`, `5m`, `1h`). Without it, waits. |
| `--resume <conversation> "<answer>"` | Answers a question and continues. Policy flags do not apply to a resume. |

It goes through the same checks as any platform: a key you did not expose to `local`, or a request
its ceiling would cut, is refused before launch and names the fix. Anything above `read` (full shell,
edits, push, an `interact` or `full` grant) is listed and asked on the terminal; without a terminal it
needs `--yes` **and** `"unattendedEscalation": true` under `platforms.local`, so a cron line cannot
quietly run an edit.

The agent answers with a `reply` tool and asks with `ask_user`, served by a small MCP server on
`127.0.0.1` for that run only. On a terminal you answer inline; otherwise `run` prints the question and
exits 3, and `--resume` continues the conversation.

| Exit | Meaning |
| --- | --- |
| 0 | done |
| 1 | failed |
| 2 | the agent replied with a blocker |
| 3 | waiting for your answer |
| 64 | usage error |
| 75 | no free slot within `--wait`, or the daemon lock is held by something `run` cannot talk to |
| 77 | refused by the ceiling, the exposure or consent |
| 130 / 143 | interrupted (`ctrl-c` cancels the run within one heartbeat; a second one exits at once) |

With the daemon running, `run` hands the run to it over `~/.duckhunt-runner/sockets/local.sock`
(`0600`), so local runs share its slots, its git locks and its audit. Without one, `run` holds the daemon
lock while it works and `start` refuses to start meanwhile. Conversations live in
`~/.duckhunt-runner/platforms/local/`, so one can be resumed from either.

## Licence

Copyright © 2026 miermontoto.

Licensed under [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/):
you may use, modify and share it for any noncommercial purpose, keeping this notice with any copy.
Commercial use needs a separate licence. See [`LICENSE`](./LICENSE).
