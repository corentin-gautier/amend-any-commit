const vscode = require('vscode');
const { inspect, reword, forcePush, RewordError } = require('./reword');

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

async function rewordCommand(context, sourceControl, historyItem) {
	const cwd = sourceControl?.rootUri?.fsPath;
	const commit = historyItem?.id;
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

function activate(context) {
	context.subscriptions.push(vscode.commands.registerCommand('rewordCommit.reword',
		(sourceControl, historyItem) => rewordCommand(context, sourceControl, historyItem)));
}

module.exports = { activate };
