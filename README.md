# Source Control Graph Plus

*Formerly Graph Commit Tools and Amend Any Commit.*

Keep VS Code's built-in Source Control Graph. Right-click a commit: the actions I used to open Git Graph for are now in its menu. No new view to learn, no webview, nothing to keep in sync.

| In the right-click menu | VS Code already has | This extension adds |
| --- | --- | --- |
| **A commit** | Checkout, create branch, create tag, cherry-pick, compare, copy hash and message | Edit (message, description, author, date), add staged changes to it, squash, drop, revert, merge into the current branch, rebase the current branch on it, reset the current branch to it |
| **Its branches** | Checkout, delete (local or remote) | Rename, push (or force push), fetch into a local branch, copy name |
| **Its tags** | Delete | Push, copy name |

Merge, rebase and squash are hidden on the current commit, where they have nothing to do.

## First, allow the menu

The right-click menu of the Source Control Graph is still a *proposed* API in VS Code: VS Code only shows it for extensions it allows. Until it becomes stable, allow this extension yourself:

1. Run **Preferences: Configure Runtime Arguments** from the Command Palette. It opens `argv.json`.
2. Add this line:
   ```jsonc
   "enable-proposed-api": ["corentin-gautier.source-control-graph-plus"]
   ```
3. Quit and restart VS Code.

Without it, only editing a commit is available, from the Timeline, the Command Palette and the Source Control menu.

## Edit a commit

Any commit on your branch, not just the last one. I often notice a typo three commits too late, and `git commit --amend` only fixes the last one.

Pick the commit from one of these places:

- **Source Control Graph**: right-click a commit > **Edit Commit...**
- **Timeline** (file history, under the Explorer): right-click a commit > **Edit Commit...**
- **Command Palette**: **Git: Edit a Commit...**, then choose the commit.
- **Source Control** view: **...** menu > **Edit a Commit...**

A list opens with what you can change:

- **Subject**: the first line of the message.
- **Description**: the rest of the message. The box holds one line, so `⏎` stands for a line break (a button adds one).
- **Author**: `Name <email>`. A button fills in your own Git identity.
- **Date**: the author date, `YYYY-MM-DD HH:MM:SS +HHMM`. A button sets it to now.

Pick a line, edit it, press Enter: you are back in the list, on **Apply**. Press Enter again and that's it.

- The last commit is amended. An older commit is rewritten, then the commits after it are replayed on top. They keep the same content, so there is never a conflict.
- What you don't change is kept as is: content, author, date.
- It refuses when it can't do the job safely: uncommitted changes, a rebase or merge in progress, or a merge commit in the way.

### Commits already pushed

Changing a pushed commit rewrites history, so you need a force push afterwards. When the commit is already pushed, a **Force push after editing** checkbox in the list is active (pick it to tick or untick it). Otherwise it is greyed out, with the reason: the commit isn't pushed yet, or the branch has no upstream.

- **Ticked**: right after the edit, the branch is pushed with `--force-with-lease`. The push only goes through if the remote has not changed since you opened the list, so you never erase someone else's work. Your choice is remembered.
- **Unticked**: a warning reminds you that you will have to force push yourself.

## Add staged changes to a commit

Stage what you want to add, then right-click a commit > **Add Staged Changes to This Commit**. The changes go into that commit, and the commits after it are replayed. Unstaged changes are set aside meanwhile and put back after. If a later commit conflicts with the change, resolve the conflicts and continue the rebase, or click **Abort Rebase**: everything goes back as before, your changes staged again.

## Squash, drop, revert

- **Squash Commits from Here to HEAD...** turns this commit and all the ones after it into a single commit. You get the same list as for editing, with all their messages put together and the author and date of the oldest one. Local changes are not touched.
- **Drop Commit...** removes the commit and its changes from the branch, after a confirmation; the commits after it are replayed. The first commit of the repository cannot be dropped.
- **Revert Commit...** creates a new commit that undoes it, without rewriting the history: the safe choice for a commit already pushed. For a merge commit, you choose the parent to go back to.

Squash and drop rewrite the history like editing a commit: for a commit already pushed, you are warned (squash offers the same force push checkbox). Drop stops on conflicts like a rebase, with **Abort Rebase**.

## Merge, rebase, reset

As in Git Graph, on any commit of the graph:

- **Merge into Current Branch...**, then choose how:
  - **Merge Commit** (`--no-ff`, selected by default): always creates a merge commit.
  - **Fast-Forward** (`--ff`): moves the branch forward, without a merge commit. Only offered when it is possible.
  - **Squash** (`--squash`): stages all the changes without committing; you write the commit in Source Control.

  When a branch points at the commit, that branch is merged, so the merge message names it. If the merge stops on conflicts, resolve them in Source Control, or click **Abort Merge** to go back.
- **Rebase Current Branch on This Commit...**, then confirm. The commits of your branch are replayed on top of it; the confirmation says how many, and warns when some are already pushed (you will need to force push). It refuses with uncommitted changes. If the rebase stops on conflicts, resolve them and continue it from Source Control, or click **Abort Rebase**.
- **Reset Current Branch to This Commit...**, then choose the mode:
  - **Soft**: the branch moves, the changes of the commits left out stay staged.
  - **Mixed** (selected by default): same, but unstaged.
  - **Hard**: the branch moves and the working tree matches the commit. If you have uncommitted changes, you are asked first, since they are lost for good.

  It works backward and forward (to a commit of another branch, for instance). A commit left out is still in `git reflog` if you need it back.

## Branches and tags

VS Code puts the actions on branches and tags in the menu of their commit: each entry opens the list of the commit's branches or tags, next to VS Code's own **Delete Branch** and **Delete Tag**.

- **Rename Branch...** (local branch): the name is checked as you type (valid, not taken). The branch keeps its upstream; the branch on the remote keeps its old name.
- **Push Branch...** (local branch): to its upstream, or to a remote you choose that becomes its upstream. **Force Push** uses `--force-with-lease`.
- **Fetch into Local Branch...** (remote branch): creates or moves forward a local branch, without checking it out. It only fast-forwards; for the current branch, pull instead.
- **Push Tag...**: to the remote you choose.
- **Copy Branch Name** and **Copy Tag Name**.

Deleting a remote branch is already in VS Code's **Delete Branch**.

## Requirements

Git, and VS Code's built-in Git extension (enabled by default). English and French.

## Development

```sh
npm test                                  # git logic on throwaway repositories
npx @vscode/vsce package                  # builds source-control-graph-plus-<version>.vsix
code --install-extension source-control-graph-plus-<version>.vsix
python3 tools/draw-icon.py icon.png       # redraws the icon (needs Pillow and VS Code's codicon font)
```

Pushing a tag like `v0.8.0` publishes to the VS Code Marketplace (Trusted Publishing, no token) and Open VSX (`OVSX_PAT` secret), see `.github/workflows/release.yml`.

## Credits

The icon uses the Source Control icon from [Codicons](https://github.com/microsoft/vscode-codicons), © Microsoft, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
