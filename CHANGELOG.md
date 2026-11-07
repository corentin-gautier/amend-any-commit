# Changelog

## 0.8.0

- Renamed **Source Control Graph Plus**, with a new extension ID: `corentin-gautier.source-control-graph-plus`. Install it in place of Graph Commit Tools (`corentin-gautier.amend-any-commit`), and update the line in `argv.json` (see the README).
- New icon: the Source Control icon of VS Code with the right-click menu this extension adds to it.
- **Merge into Current Branch...** in the right-click menu of the Source Control Graph: merge commit, fast-forward or squash, as in Git Graph. On conflicts, an **Abort Merge** button.
- **Rebase Current Branch on This Commit...** in the same menu, with a confirmation that warns when pushed commits get rewritten. On conflicts, an **Abort Rebase** button.
- **Add Staged Changes to This Commit**: fold what is staged into an older commit, the commits after it replayed.
- **Squash Commits from Here to HEAD...**, **Drop Commit...** and **Revert Commit...** (with the parent to choose for a merge).
- For the branches and tags of a commit: **Rename Branch...**, **Push Branch...** (optionally `--force-with-lease`), **Fetch into Local Branch...**, **Push Tag...**, **Copy Branch Name**, **Copy Tag Name**.
- Merge, rebase and squash are hidden on the current commit, where they have nothing to do.

## 0.7.0

- Renamed **Graph Commit Tools** (formerly Amend Any Commit). Same extension ID, so updates keep coming.
- **Reset Current Branch to This Commit...** in the right-click menu of the Source Control Graph, with the soft, mixed or hard mode to choose, as in Git Graph. A hard reset asks first when there are uncommitted changes.

## 0.6.0

- Edit the description, the author and the author date too, not just the subject: the input box is now a list of the fields.
- Force push is a checkbox with a label in that list, instead of an icon toggle. It stays visible, greyed out with the reason, when there is nothing to force push.
- Commands renamed to **Edit Commit...** and **Edit a Commit...**

## 0.5.0

First release.

- Edit the message of any commit on the current branch, not just the last one.
- Right-click a commit in the Source Control Graph or the Timeline, or run **Git: Edit a Commit Message...** from the Command Palette or the Source Control **...** menu.
- Author and date are kept; the commits after it are replayed on top.
- For a commit already pushed, a toggle in the input box force pushes right after, safely (`--force-with-lease`).
- English and French.
