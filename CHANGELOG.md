# Changelog

## Unreleased

- Edit the description, the author and the author date too, not just the subject: the input box is now a list of the fields.
- Force push is a checkbox with a label in that list, instead of an icon toggle.
- Commands renamed to **Edit Commit...** and **Edit a Commit...**

## 0.5.0

First release.

- Edit the message of any commit on the current branch, not just the last one.
- Right-click a commit in the Source Control Graph or the Timeline, or run **Git: Edit a Commit Message...** from the Command Palette or the Source Control **...** menu.
- Author and date are kept; the commits after it are replayed on top.
- For a commit already pushed, a toggle in the input box force pushes right after, safely (`--force-with-lease`).
- English and French.
