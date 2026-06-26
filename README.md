# agyx

`agyx` is a multi-account session supervisor for Google's Antigravity CLI
(`agy`). It can pause every managed terminal session, switch the shared macOS
Keychain credential, and restart each conversation in its original terminal.

## Requirements

- macOS
- Node.js 20 or newer
- Google Antigravity CLI (`agy`)

## Install

```bash
npm install -g agyx
agyx install
source ~/.zshrc
```

The shell integration makes `agy` transparently run as:

```text
agyx session -- <all original agy arguments>
```

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

When the name is omitted, `agyx save` reads the active Google account from
`~/.gemini/google_accounts.json` and derives a profile name from the email
local-part. Use `--email EMAIL` only when you want to override the detected
metadata.

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
in the `agy` log, falling back to `~/.gemini/google_accounts.json`.

Use `--no-resume` to leave sessions paused after login.

## Switching

```bash
agyx list
agyx use work
agyx use
agyx next
agyx status
```

`agyx use` without a profile opens an interactive picker. The picker and
`agyx list` show profile metadata:

- `status`: `ready`, `quota`, `disabled`, or `unknown`
- `reset`: relative quota reset time when it can be inferred from logs
- `last-used`: when the profile was last activated through agyx
- `picks`: how many times agyx selected the profile

`agyx next` uses name-sorted round-robin order, starting after the currently
active profile. It skips profiles marked `disabled` or currently quota
exhausted. If a quota reset time has passed, the profile becomes selectable
again.

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

This release records quota state and makes `agyx next` avoid exhausted profiles.
It does not yet perform an automatic global account switch from inside a running
session; use `agyx next` after a quota message so the switch still happens
through the normal pause/switch/resume transaction.

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
