# Prompt Upgrade

A Claude Code mod that turns a rough prompt into a clear one before it is sent.
It opens a pane, asks up to three quick multiple-choice questions, rewrites the
prompt, and shows your original and the upgrade side by side. Nothing is sent
until you press Run it.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install prompt-upgrade --marketplace csfoo28/prompt-upgrade
```

Answer `y` to add the marketplace, then pick a scope (user is first).

From a shell:

```
claude plugin install prompt-upgrade --marketplace csfoo28/prompt-upgrade
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box,
then Plugins, Add marketplace with `csfoo28/prompt-upgrade`, then Add plugin.

If the repository is private, it installs only for people who can read it on
GitHub and whose machine already has a git credential for github.com (an SSH key,
or `gh auth login` then `gh auth setup-git`).

## Commands

| Command | What it does |
| --- | --- |
| `/better <prompt>` | Upgrades that prompt in the pane |
| `/better` | Opens the pane with a box to type a prompt |
| `/better on` | Automatic mode: prompts you type go to the pane first |
| `/better off` | Turns automatic mode off |
| `/better history` | Your last 20 upgrades; click one to reopen its review |

In automatic mode these go straight through untouched: slash commands, prompts
with files or images, messages sent while Claude is working, short replies
("yes", "keep going", anything of two words or fewer), and anything starting with
`>` (the `>` is removed before sending).

## Checks

```
claude plugin validate .
claude plugin test .
```
