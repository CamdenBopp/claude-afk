# afk

A Claude Code plugin that tells you when Claude is done or stuck, so you can walk away from a long task. When you're away it says a short line out loud and sends you an iMessage each time a turn finishes, Claude asks you something, a plan is ready, or a tool call may be waiting on your approval.

AFK is per session, so a long build in one project can ping you while another project stays quiet. Each project can say whether its new sessions start with AFK on, and `/afk on all` covers every open session when you get up from the desk.

It can also turn itself on. If you reply from your phone through Remote Control and haven't typed anything on your Mac for a few minutes, it assumes you've stepped away. Your next message from the Mac turns it back off.

## Requirements

- macOS. Pings use the built-in `say` command and the Messages app.
- Messages signed in to iMessage, if you want texts.
- Claude Code 2.1.286 or later. The plugin uses function hooks, which are an early-access API and may change between releases.

## Install

Clone the repo, then point Claude Code at the folder.

For one terminal session:

```bash
claude --plugin-dir ~/path/to/claude-afk
```

For every session, including the Code tab in the Claude desktop app, add the folder to `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/path/to/claude-afk"
  }
}
```

## Set up

Run `/afk setup`. The pane has these parts:

- **Voice:** turn spoken pings on or off and pick any voice installed on your Mac. If you use a screen reader, pick a different voice from the one it uses so pings stand out.
- **iMessage:** the email address or phone number to text, plus an optional fallback that's tried if the first send fails. Press Enter in a field to save it. Use "Send test message" to check it. Include the country code on a phone number, like +1 for the US.
- **Ping me when:** an On/Off setting for each event that can send a ping.
- **Defaults for every project:** whether new sessions start with AFK on, and how long the Mac has to be quiet before a phone message turns AFK on (or Never).
- **This project:** the same two settings for the project you're in, or "Use default". A project is its git repository, so every worktree of a repo shares one setting. Outside git, the project is the folder.

The first test message makes macOS ask whether Claude Code may control Messages. Allow it, or no texts will go out.

On the phone, the pane shows your settings and its buttons work, but you can't edit text fields or pick from lists there. Change those from the Mac.

## Commands

| Command | What it does |
| --- | --- |
| `/afk` | Toggles AFK in this session. |
| `/afk on`, `/afk off` | Turns AFK on or off in this session. |
| `/afk on all`, `/afk off all` | Turns AFK on or off in every open session. |
| `/afk setup` | Opens the setup pane. |
| `/afk status` | Says whether AFK is on here, when this Mac last sent a message, and this project's settings. |
| `/afk test` | Sends one ping through every channel that's on. |

`/afk` runs right away even while Claude is mid-turn, so you can turn it on on your way out.

## How AFK decides

Each session starts with its project's setting, or the global default if the project uses the default. After that, the newest decision wins: `/afk` in the session, or `/afk on all` / `off all` from any session. An "all" only covers sessions that were open when you ran it; a session opened later starts from its project's setting.

Claude Code labels every message with where it came from. A message typed in the session itself is labelled `composer`. A message sent through Remote Control from a phone or browser is labelled `bridge`. The plugin records when the last `composer` message arrived, in any session that has the plugin loaded. A `bridge` message that arrives after the project's quiet period turns AFK on in that session.

AFK that you turned on yourself stays on until you turn it off. AFK that turned itself on switches off as soon as you type on the Mac, in any session.

## Limits

- **Approval pings are a best guess.** Plugins can't see the permission dialog itself, only the engine's decision to ask. In auto mode that question may be settled for you a few seconds later. So the plugin waits 15 seconds and only pings if the call still hasn't moved. A long command that was approved quietly can still set it off, which is why the message says Claude "may" need your approval.
- **A sent text isn't a delivered text.** The plugin knows Messages accepted the message, not that it arrived. If the first address fails outright, the fallback is tried.
- **macOS only.** On other systems the commands fail and you get a toast saying so.

## Privacy

Your settings, including the address and number you enter, stay on your machine in Claude Code's plugin store. Texts go out through your own Messages app. The plugin makes no network calls of its own.

## Development

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The tests run the plugin inside the engine with a fake clock and store. They capture the `say` and `osascript` commands instead of running them, so nothing speaks or sends.

For editor types and `tsc`, run `/plugin-types` inside Claude Code from this folder, which writes the engine's declarations into `.claude/types`. Then:

```bash
npx -p typescript tsc -p .
```

## License

MIT
