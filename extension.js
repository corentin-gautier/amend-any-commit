const vscode = require('vscode');
const path = require('path');
const { inspect, reword, forcePush, repositoryRoot, listCommits, RewordError } = require('./reword');

const FORCE_PUSH_KEY = 'forcePush';

function errorText(error) {
	if (error instanceof RewordError) {
		switch (error.code) {
			case 'notInHead': return vscode.l10n.t('This commit is not on the current branch.');
			case 'operationInProgress': return vscode.l10n.t('A rebase, merge or cherry-pick is in progress.');
			case 'dirty': return vscode.l10n.t('Commit or stash your changes first.');
			case 'merges': return vscode.l10n.t('There is a merge commit between this commit and HEAD.');
		}
	}
	return error.stderr || error.message;
}

// Asks for the new subject. For a pushed commit, a toggle in the field chooses whether to force push
// right after. Resolves with { subject, forcePush }, or undefined when cancelled.
function askSubject(info, subject, hasBody, forcePushDefault) {
	return new Promise(resolve => {
		const input = vscode.window.createInputBox();
		input.title = vscode.l10n.t('Edit Commit Message ({0})', info.sha.slice(0, 7));
		input.value = subject;
		input.valueSelection = [0, subject.length];
		input.prompt = hasBody ? vscode.l10n.t('The commit description is kept.') : undefined;
		const toggle = {
			iconPath: new vscode.ThemeIcon('repo-force-push'),
			tooltip: vscode.l10n.t('Force push after editing (git push --force-with-lease)'),
			location: vscode.QuickInputButtonLocation.Input,
			toggle: { checked: forcePushDefault },
		};
		if (info.pushed) {
			input.buttons = [toggle];
		}
		let result;
		input.onDidChangeValue(value => {
			input.validationMessage = value.trim() ? undefined : vscode.l10n.t('The message cannot be empty.');
		});
		input.onDidAccept(() => {
			if (!input.value.trim()) {
				return;
			}
			result = { subject: input.value.trim(), forcePush: info.pushed && toggle.toggle.checked };
			input.hide();
		});
		input.onDidHide(() => {
			input.dispose();
			resolve(result);
		});
		input.show();
	});
}

async function amendCommit(context, cwd, commit) {
	if (!cwd || !commit) {
		return;
	}
	let info;
	try {
		info = await inspect(cwd, commit);
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t('Cannot edit the message: {0}', errorText(error)));
		return;
	}

	// The input box only holds one line, so it edits the subject and keeps the body as is.
	const [subject, ...rest] = info.message.split('\n');
	const body = rest.join('\n');
	const answer = await askSubject(info, subject, body.trim() !== '', context.globalState.get(FORCE_PUSH_KEY, false));
	if (!answer || answer.subject === subject) {
		return;
	}
	if (info.pushed) {
		context.globalState.update(FORCE_PUSH_KEY, answer.forcePush);
	}

	// Ticking force push is already the informed choice; otherwise warn that the history diverges.
	if (info.pushed && !answer.forcePush) {
		const proceed = vscode.l10n.t('Edit Anyway');
		const choice = await vscode.window.showWarningMessage(
			vscode.l10n.t('This commit is already pushed'),
			{ modal: true, detail: vscode.l10n.t('Its history will be rewritten: you will need to force push (git push --force-with-lease).') },
			proceed,
		);
		if (choice !== proceed) {
			return;
		}
	}

	try {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, () =>
			reword(cwd, info, [answer.subject, body].join('\n')));
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t('Cannot edit the message: {0}', errorText(error)));
		return;
	}

	if (answer.forcePush) {
		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, () => forcePush(cwd, info));
			vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) Message edited and force pushed'), 4000);
		} catch (error) {
			vscode.window.showErrorMessage(vscode.l10n.t('The message is edited, but the force push failed: {0}', errorText(error)));
		}
	}
}

// The open git repositories, from the built-in git extension.
async function openRepositories() {
	const extension = vscode.extensions.getExtension('vscode.git');
	if (!extension) {
		return [];
	}
	const git = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
	return git.repositories.map(repository => repository.rootUri.fsPath);
}

// Picks the repository to work in: the only one, the one holding the active file, or the user's choice.
async function pickRepository() {
	const roots = await openRepositories();
	if (roots.length <= 1) {
		return roots[0];
	}
	const active = vscode.window.activeTextEditor?.document.uri;
	if (active?.scheme === 'file') {
		const owner = roots
			.filter(root => active.fsPath.startsWith(root + path.sep))
			.sort((a, b) => b.length - a.length)[0];
		if (owner) {
			return owner;
		}
	}
	const choice = await vscode.window.showQuickPick(
		roots.map(root => ({ label: `$(repo) ${path.basename(root)}`, description: root, root })),
		{ placeHolder: vscode.l10n.t('Choose a repository') },
	);
	return choice?.root;
}

// Lets the user choose among the commits that can be reworded.
async function pickCommit(cwd) {
	const commits = await listCommits(cwd);
	if (commits.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t('There is no commit to edit on this branch.'));
		return undefined;
	}
	const choice = await vscode.window.showQuickPick(
		commits.map(commit => ({
			label: `$(git-commit) ${commit.subject}`,
			description: commit.sha.slice(0, 7),
			detail: `${commit.author}, ${commit.date}`,
			sha: commit.sha,
		})),
		{ placeHolder: vscode.l10n.t('Choose the commit whose message to edit'), matchOnDescription: true },
	);
	return choice?.sha;
}

function activate(context) {
	context.subscriptions.push(
		// Source Control Graph: (source control, history item).
		vscode.commands.registerCommand('amendAnyCommit.amend', (sourceControl, historyItem) =>
			amendCommit(context, sourceControl?.rootUri?.fsPath, historyItem?.id)),
		// Timeline: (git timeline item, file uri). The item's ref is the commit hash.
		vscode.commands.registerCommand('amendAnyCommit.amendFromTimeline', async (item, uri) => {
			const commit = item?.ref ?? item?.id;
			if (!commit || uri?.scheme !== 'file') {
				return;
			}
			let cwd;
			try {
				cwd = await repositoryRoot(path.dirname(uri.fsPath));
			} catch (error) {
				vscode.window.showErrorMessage(vscode.l10n.t('Cannot edit the message: {0}', errorText(error)));
				return;
			}
			await amendCommit(context, cwd, commit);
		}),
		// Command Palette, or the "..." menu of the Source Control view (which passes its source control).
		vscode.commands.registerCommand('amendAnyCommit.pick', async sourceControl => {
			const cwd = sourceControl?.rootUri?.fsPath ?? await pickRepository();
			if (!cwd) {
				return;
			}
			const commit = await pickCommit(cwd);
			if (commit) {
				await amendCommit(context, cwd, commit);
			}
		}),
	);
}

module.exports = { activate };
