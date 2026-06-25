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
agyx save personal --email you@example.com
```

Add another account:

```bash
agyx login work
```

`agyx login` performs this transaction:

1. Pause every supervised `agy` child process.
2. Stop any unmanaged `agy` process that could overwrite the Keychain.
3. Run the Google OAuth login flow.
4. Save and activate the new credential.
5. Restart every supervised session in its original terminal.

Use `--no-resume` to leave sessions paused after login.

## Switching

```bash
agyx list
agyx use work
agyx next
agyx status
```

Each supervisor preserves its working directory and original arguments. It also
extracts the active conversation UUID from the session log and uses
`agy --conversation <UUID>` when restarting.

Conversation names are supported by `agy` through `/rename` and `/resume`, but
`agyx` tracks UUIDs because names can be changed or duplicated.

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
