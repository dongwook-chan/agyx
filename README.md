# agyx

`agyx` is a multi-account session supervisor for Google's Antigravity CLI
(`agy`). It can pause every managed terminal session, switch the shared macOS
Keychain credential, and restart each conversation in its original terminal.

## Requirements

- macOS on Apple Silicon (`darwin/arm64`) or Linux on ARM64 (`linux/arm64`)
- Node.js 20 or newer
- Google Antigravity CLI (`agy`)

The npm package intentionally targets ARM64 Unix hosts only. Installation
aborts on other hosts. The long-running `agy` supervisor runs through
`bin/agyx-supervisor`, a tiny POSIX launcher that selects and `exec`s the native
Rust binary for the current host:

- `bin/agyx-supervisor-darwin-arm64`
- `bin/agyx-supervisor-linux-arm64`

Because the launcher uses `exec`, the long-running process is the Rust
supervisor itself; Node is not kept alive for managed `agy` sessions. In a local
development checkout, the launcher falls back to `agyx-agy` when the matching
native binary has not been built.

## Install

```bash
npm install -g agyx
agyx install
source ~/.zshrc
```

`agyx install` writes a shell function to your shell rc file. It does not modify
the already-open terminal automatically. Open a new terminal, or run the
displayed `source ...` command.

For the current terminal only, without reloading your shell rc file:

```bash
eval "$(agyx shell-init)"
```

If you run an interactive `agyx` command before installing the shell
integration, agyx asks once whether to configure `agy` as the transparent shell
function. If GitHub CLI (`gh`) is installed, agyx also asks once whether to star
the repository. Interactive prompts use Inquirer. Set `AGYX_NO_ONBOARDING=1` to
suppress these prompts.

The shell integration makes `agy` transparently run as:

```text
agyx-supervisor <all original agy arguments>
```

If the native supervisor binary is not available in a development checkout, the
shell function falls back to `agyx-agy`, which uses the Node supervisor.

Verify the active terminal with:

```bash
type agy
```

Expected result: `agy` is a shell function that calls `agyx-supervisor`.

All original options are forwarded, including:

```bash
agy --continue
agy --conversation <UUID>
agy --model <model>
agy --project <project-id>
agy --dangerously-skip-permissions
agy -p "one-shot prompt"
```

One-shot `--print`/`--prompt` commands are not automatically restarted, which
prevents duplicate requests.

## Account setup

Save the account currently stored by `agy`:

```bash
agyx save
agyx save personal
```

When the name is omitted, `agyx save` briefly probes `agy` authentication,
detects the actual keyring account email from the `agy` log, and derives a
profile name from the email local-part. Use `--email EMAIL` only when you want
to override the detected metadata.

Add another account:

```bash
agyx login work
agyx login
```

`agyx login` performs this transaction:

1. Pause every supervised `agy` child process.
2. Stop any unmanaged `agy` process that could overwrite the Keychain.
3. Run the Google OAuth login flow.
4. Save and activate the new credential.
5. Restart every supervised session in its original terminal.

When the name is omitted, `agyx login` derives it from the OAuth email detected
in the `agy` log.

Use `--no-resume` to leave sessions paused after login.

## Switching

```bash
agyx list
agyx use work
agyx use
agyx next
agyx autoswitch
agyx status
```

`agyx use` without a profile opens an interactive picker. `agyx list` renders a
terminal table. Both show profile metadata:

- `status`: `ready`, `quota`, `disabled`, or `unknown`
- `quota-reset`: relative quota reset time when it can be inferred from logs
- `last-request`: when a supervised `agy` log last showed a model request
- `activated`: when agyx last made the profile active
- `switches`: how many times agyx selected the profile through login/use/next

`agyx next` uses name-sorted round-robin order, starting after the currently
active profile. It skips profiles marked `disabled`, credential-mismatched,
ineligible, or currently quota exhausted for the active provider scope. If a
quota reset time has passed, the profile becomes selectable again.

Each supervisor preserves its working directory and original arguments. It also
extracts the active conversation UUID from the session log and uses
`agy --conversation <UUID>` when restarting.

Conversation names are supported by `agy` through `/rename` and `/resume`, but
`agyx` tracks UUIDs because names can be changed or duplicated.

## Quota detection

`agyx` passively scans supervised `agy` session logs for common quota/rate-limit
signals such as `RESOURCE_EXHAUSTED`, HTTP `429`, and `Individual quota
reached`. When a reset hint such as `Resets in 73h16m27s` is present, agyx stores
the inferred reset time in profile metadata.

When the active model can be inferred from the same session log, quota is stored
per provider scope: `claude`, `gemini`, or `gpt-oss`. If no reliable model
context exists, the quota event is stored as `unknown` and treated as
profile-wide.

Automatic quota failover is configured with:

```bash
agyx autoswitch
agyx autoswitch all-providers
agyx autoswitch provider-first
agyx autoswitch off
```

The default is `all-providers`: agyx waits until both Claude and Gemini quota are
exhausted for the active profile before switching accounts. `provider-first`
switches as soon as the current provider scope is exhausted. Automatic switching
uses the same global pause/switch/resume transaction as `agyx next`.

## Native supervisor build

For local native packaging on the current host:

```bash
npm run build:native
npm run check:native-package
```

`npm pack` and `npm publish` run `check:native-package` and fail if the launcher
or the current host's native binary is missing or not executable.

Release CI should build every supported binary and then run:

```bash
AGYX_REQUIRE_ALL_NATIVE=1 npm run check:native-package
```

## Security

- Credentials remain in macOS Keychain.
- Profile metadata only is stored in `~/.config/agyx/state.json` with mode 0600.
- Account changes wait for supervised sessions to stop before modifying the
  shared `gemini/antigravity` Keychain item.

macOS may display a Keychain access prompt the first time an account is saved or
switched.

## Current limitation

Antigravity stores conversations locally, but a conversation created by one
Google account may not be authorized for another account's backend project.
`agyx` restores the local conversation ID; cross-account backend access remains
subject to Antigravity's account permissions.
