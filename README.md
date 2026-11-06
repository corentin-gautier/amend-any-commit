# Amend Any Commit

`git commit --amend` only fixes the last commit. This extension lets you fix **any** commit on your branch (message, description, author, date), in two clicks, without an interactive rebase.

I made it because I often notice a typo three commits too late, and Git Graph had no way to fix it.

## How to use it

Pick the commit from one of these places:

- **Source Control Graph**: right-click a commit > **Edit Commit...** (see [the note below](#source-control-graph-menu)).
- **Timeline** (file history, under the Explorer): right-click a commit > **Edit Commit...**
- **Command Palette**: **Git: Edit a Commit...**, then choose the commit.
- **Source Control** view: **...** menu > **Edit a Commit...**

A list opens with what you can change:

- **Subject**: the first line of the message.
- **Description**: the rest of the message. The box holds one line, so `⏎` stands for a line break (a button adds one).
- **Author**: `Name <email>`. A button fills in your own Git identity.
- **Date**: the author date, `YYYY-MM-DD HH:MM:SS +HHMM`. A button sets it to now.

Pick a line, edit it, press Enter: you are back in the list, on **Apply**. Press Enter again and that's it.

## What it does

- The last commit is amended. An older commit is rewritten, then the commits after it are replayed on top. They keep the same content, so there is never a conflict.
- What you don't change is kept as is: content, author, date.
- It refuses when it can't do the job safely: uncommitted changes, a rebase or merge in progress, or a merge commit in the way.

## Commits already pushed

Changing a pushed commit rewrites history, so you need a force push afterwards. When the commit is already pushed, a **Force push after editing** checkbox in the list is active (pick it to tick or untick it). Otherwise it is greyed out, with the reason: the commit isn't pushed yet, or the branch has no upstream.

- **Ticked**: right after the edit, the branch is pushed with `--force-with-lease`. The push only goes through if the remote has not changed since you opened the list, so you never erase someone else's work. Your choice is remembered.
- **Unticked**: a warning reminds you that you will have to force push yourself.

## Source Control Graph menu

The right-click menu of the Source Control Graph is still a *proposed* API in VS Code: VS Code only shows it for extensions it allows. Until it becomes stable, you can allow this extension yourself:

1. Run **Preferences: Configure Runtime Arguments** from the Command Palette. It opens `argv.json`.
2. Add this line:
   ```jsonc
   "enable-proposed-api": ["corentin-gautier.amend-any-commit"]
   ```
3. Quit and restart VS Code.

The Timeline, the Command Palette and the Source Control menu work without this.

## Requirements

Git, and VS Code's built-in Git extension (enabled by default).

## Development

```sh
npm test                                  # git logic on throwaway repositories
npx @vscode/vsce package                  # builds amend-any-commit-<version>.vsix
code --install-extension amend-any-commit-<version>.vsix
python3 tools/draw-icon.py icon.png       # redraws the icon (needs Pillow)
```

Pushing a tag like `v0.5.0` publishes to the VS Code Marketplace (Trusted Publishing, no token) and Open VSX (`OVSX_PAT` secret), see `.github/workflows/release.yml`.
