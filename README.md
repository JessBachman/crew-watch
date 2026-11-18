# crew-watch

A Claude Code mod that watches the subagents and background jobs Claude starts, and speaks up when one of them is stuck.

It was built after a long research run lost a night: a data collector retried a request the server kept rejecting, for hours, while its subagent kept reporting "still waiting."

## What it catches

- **Repeating.** Claude or a subagent makes the exact same tool call 4 times in its last 12 and gets the exact same answer each time. crew-watch adds a note to that answer telling the model to stop, say what's blocking it, and try something else.
- **No new output.** A background job's log has printed nothing new for 20 minutes. Retry, error and "waiting" lines don't count as new even when their numbers change, so `retry 3/12` and `retry 4/12` read as the same line. crew-watch shows a toast and sends Claude a prompt to check the job, kill it if it's spinning, and change approach.
- **Silent.** A running subagent has made no model call or tool call for 20 minutes. This one is shown, not acted on, because a long build looks the same.

You see it as one line above the prompt box, for example `crew: 2 agents, 1 job`, which turns to ⚠ when something is stuck. Type `/crew` to list what's running and what looks stuck.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install crew-watch --marketplace JessBachman/crew-watch
```

Answer `y` to add the marketplace, then pick a scope (user scope runs it in every session).

From a shell:

```
claude plugin install crew-watch --marketplace JessBachman/crew-watch
```

In the Claude desktop app, where `/plugin` doesn't run: click + next to the prompt box, then Plugins, Add marketplace with `JessBachman/crew-watch`, then Add plugin.

## Settings

- `stuckMinutes` (default 20): how long a job or subagent can go quiet before it counts as stuck.
- `wakeClaude` (default on): whether a stuck background job sends Claude a prompt to deal with it. Off means you only get the toast and the warning line.
