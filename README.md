# Reword Commit

Adds **Edit Commit Message...** to the right-click menu of a commit in VS Code's Source Control Graph.

- The last commit is amended; an older one is rewritten and the commits after it are replayed on top (same trees, so no conflicts).
- Author and date are kept. The input box edits the subject line; the description is kept as is.
- Refused when the tree has uncommitted changes, an operation is in progress, or a merge commit is in the way.
- Warns before rewriting a commit the upstream already has (you will need `git push --force-with-lease`).

The menu is a proposed API, so VS Code must allow it in `~/.vscode/argv.json`:

```jsonc
"enable-proposed-api": ["corentin-gautier.reword-commit"]
```

Build and install:

```sh
npx @vscode/vsce package --allow-missing-repository --skip-license
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension reword-commit-0.1.0.vsix
```
