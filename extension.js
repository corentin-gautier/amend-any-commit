const vscode = require('vscode');
const { inspect, reword, RewordError } = require('./reword');

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

async function rewordCommand(sourceControl, historyItem) {
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
	const newSubject = await vscode.window.showInputBox({
		title: vscode.l10n.t('Edit Commit Message ({0})', info.sha.slice(0, 7)),
		value: subject,
		valueSelection: [0, subject.length],
		prompt: body.trim() ? vscode.l10n.t('The commit description is kept.') : undefined,
		validateInput: value => value.trim() ? undefined : vscode.l10n.t('The message cannot be empty.'),
	});
	if (newSubject === undefined || newSubject === subject) {
		return;
	}

	if (info.pushed) {
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
			reword(cwd, info, [newSubject.trim(), body].join('\n')));
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t('Cannot edit the message: {0}', errorText(error)));
	}
}

function activate(context) {
	context.subscriptions.push(vscode.commands.registerCommand('rewordCommit.reword', rewordCommand));
}

module.exports = { activate };
