const vscode = require('vscode');
const path = require('path');
const { inspect, reword, forcePush, identity, repositoryRoot, listCommits, RewordError } = require('./reword');

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

// The description goes through a one-line input box, so its line breaks are shown as this sign.
const NEWLINE = '⏎';
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?( ?[+-]\d{2}:?\d{2}|Z)?$/;
const AUTHOR_FORMAT = /^([^<>]+?)\s*<([^<>\s]+)>$/;

// Shows one input box and resolves with its value, or undefined when cancelled.
// `validate` returns an error message or undefined; `buttons` are { button, apply(value) => newValue }.
function askValue({ title, value, prompt, validate = () => undefined, buttons = [] }) {
	return new Promise(resolve => {
		const input = vscode.window.createInputBox();
		input.title = title;
		input.value = value;
		input.valueSelection = [0, value.length];
		input.prompt = prompt;
		input.buttons = buttons.map(entry => entry.button);
		let result;
		input.onDidChangeValue(value => {
			input.validationMessage = validate(value);
		});
		input.onDidTriggerButton(button => {
			const entry = buttons.find(entry => entry.button === button);
			if (entry) {
				input.value = entry.apply(input.value);
				input.validationMessage = validate(input.value);
			}
		});
		input.onDidAccept(() => {
			if (validate(input.value)) {
				return;
			}
			result = input.value;
			input.hide();
		});
		input.onDidHide(() => {
			input.dispose();
			resolve(result);
		});
		input.show();
	});
}

// Shows the list of what can be edited and resolves with the item picked, or undefined when cancelled.
// Picking an item with `toggle` flips it in place instead; picking an `inert` item does nothing.
function pickField(title, items, active) {
	return new Promise(resolve => {
		const pick = vscode.window.createQuickPick();
		pick.title = title;
		pick.placeholder = vscode.l10n.t('Choose what to edit, then Apply');
		pick.matchOnDescription = true;
		pick.items = items();
		pick.activeItems = pick.items.filter(item => item.id === active);
		let result;
		pick.onDidAccept(() => {
			const [item] = pick.selectedItems;
			if (!item || item.inert) {
				return;
			}
			if (item.toggle) {
				item.toggle();
				pick.items = items();
				pick.activeItems = pick.items.filter(other => other.id === item.id);
				return;
			}
			result = item;
			pick.hide();
		});
		pick.onDidHide(() => {
			pick.dispose();
			resolve(result);
		});
		pick.show();
	});
}

const oneLine = text => text.replace(/\n/g, NEWLINE);
const preview = text => text.trim() ? oneLine(text.trim()) : vscode.l10n.t('(none)');

// Lets the user edit the subject, description, author and date of the commit, and choose whether to force
// push a commit already pushed. Resolves with { message, author, forcePush }, or undefined when cancelled.
async function askEdit(cwd, info, forcePushDefault) {
	const [subject, ...rest] = info.message.split('\n');
	const state = {
		subject,
		// The blank line after the subject is implied; the description is what follows it.
		description: rest.join('\n').replace(/^\n+/, ''),
		author: `${info.author.name} <${info.author.email}>`,
		date: info.author.isoDate,
		forcePush: forcePushDefault,
	};
	const title = vscode.l10n.t('Edit Commit ({0})', info.sha.slice(0, 7));
	const items = () => [
		{ id: 'subject', label: `$(edit) ${vscode.l10n.t('Subject')}`, description: state.subject },
		{ id: 'description', label: `$(note) ${vscode.l10n.t('Description')}`, description: preview(state.description) },
		{ id: 'author', label: `$(person) ${vscode.l10n.t('Author')}`, description: state.author },
		{ id: 'date', label: `$(calendar) ${vscode.l10n.t('Date')}`, description: state.date },
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		info.pushed ? {
			id: 'forcePush',
			label: `${state.forcePush ? '☑' : '☐'} ${vscode.l10n.t('Force push after editing')}`,
			detail: vscode.l10n.t('git push --force-with-lease: only if nobody pushed in the meantime'),
			toggle: () => { state.forcePush = !state.forcePush; },
		} : {
			// Quick picks have no disabled items: the text goes in the description, which is shown dimmed.
			id: 'forcePush',
			label: '☐',
			description: vscode.l10n.t('Force push after editing'),
			detail: info.upstream
				? vscode.l10n.t('Not available: this commit is not pushed yet, nothing to force push.')
				: vscode.l10n.t('Not available: this branch has no upstream to push to.'),
			inert: true,
		},
		{ label: '', kind: vscode.QuickPickItemKind.Separator },
		{ id: 'apply', label: `$(check) ${vscode.l10n.t('Apply')}` },
	];

	let active = 'subject';
	for (;;) {
		const item = await pickField(title, items, active);
		if (!item) {
			return undefined;
		}
		if (item.id === 'apply') {
			break;
		}
		const value = await editField(cwd, item.id, state, title);
		if (value !== undefined) {
			state[item.id] = value;
		}
		// Back in the list, Enter applies right away.
		active = value !== undefined ? 'apply' : item.id;
	}

	const description = state.description.trim();
	const [, name, email] = state.author.match(AUTHOR_FORMAT);
	return {
		message: description ? `${state.subject}\n\n${description}` : state.subject,
		// The untouched date keeps its exact original value.
		author: { name, email, date: state.date === info.author.isoDate ? info.author.date : state.date },
		forcePush: info.pushed && state.forcePush,
	};
}

// Asks for a new value of one field; resolves with it, or undefined when cancelled.
async function editField(cwd, field, state, title) {
	switch (field) {
		case 'subject':
			return (await askValue({
				title: `${title}: ${vscode.l10n.t('Subject')}`,
				value: state.subject,
				validate: value => value.trim() ? undefined : vscode.l10n.t('The subject cannot be empty.'),
			}))?.trim();
		case 'description': {
			const value = await askValue({
				title: `${title}: ${vscode.l10n.t('Description')}`,
				value: oneLine(state.description),
				prompt: vscode.l10n.t('{0} marks a line break. Leave empty for no description.', NEWLINE),
				buttons: [{
					button: { iconPath: new vscode.ThemeIcon('newline'), tooltip: vscode.l10n.t('Add a line break') },
					apply: value => value + NEWLINE,
				}],
			});
			return value?.split(NEWLINE).join('\n');
		}
		case 'author': {
			const mine = await identity(cwd);
			return (await askValue({
				title: `${title}: ${vscode.l10n.t('Author')}`,
				value: state.author,
				prompt: vscode.l10n.t('Name <email>'),
				validate: value => AUTHOR_FORMAT.test(value.trim()) ? undefined : vscode.l10n.t('Write it as: Name <email>'),
				buttons: mine ? [{
					button: { iconPath: new vscode.ThemeIcon('account'), tooltip: vscode.l10n.t('Use my identity ({0})', `${mine.name} <${mine.email}>`) },
					apply: () => `${mine.name} <${mine.email}>`,
				}] : [],
			}))?.trim();
		}
		case 'date':
			return (await askValue({
				title: `${title}: ${vscode.l10n.t('Date')}`,
				value: state.date,
				prompt: vscode.l10n.t('YYYY-MM-DD HH:MM:SS +HHMM (time zone optional)'),
				validate: value => DATE_FORMAT.test(value.trim()) && !Number.isNaN(Date.parse(value.trim().replace(' ', 'T').replace(/ ?([+-]\d{2}):?(\d{2})$/, '$1:$2')))
					? undefined : vscode.l10n.t('Write it as: YYYY-MM-DD HH:MM:SS +HHMM'),
				buttons: [{
					button: { iconPath: new vscode.ThemeIcon('clock'), tooltip: vscode.l10n.t('Now') },
					apply: () => now(),
				}],
			}))?.trim();
	}
	return undefined;
}

// The current local time, in the same format git shows author dates (%ai).
function now() {
	const date = new Date();
	const pad = n => String(Math.abs(n)).padStart(2, '0');
	const offset = -date.getTimezoneOffset();
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
		+ `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} `
		+ `${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}${pad(offset % 60)}`;
}

async function amendCommit(context, cwd, commit) {
	if (!cwd || !commit) {
		return;
	}
	let info;
	try {
		info = await inspect(cwd, commit);
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t('Cannot edit the commit: {0}', errorText(error)));
		return;
	}

	const answer = await askEdit(cwd, info, context.globalState.get(FORCE_PUSH_KEY, false));
	if (!answer) {
		return;
	}
	if (info.pushed) {
		context.globalState.update(FORCE_PUSH_KEY, answer.forcePush);
	}
	const unchanged = answer.message === info.message.trim()
		&& answer.author.name === info.author.name
		&& answer.author.email === info.author.email
		&& answer.author.date === info.author.date;
	if (unchanged) {
		return;
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
			reword(cwd, info, answer.message, answer.author));
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t('Cannot edit the commit: {0}', errorText(error)));
		return;
	}

	if (answer.forcePush) {
		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, () => forcePush(cwd, info));
			vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) Commit edited and force pushed'), 4000);
		} catch (error) {
			vscode.window.showErrorMessage(vscode.l10n.t('The commit is edited, but the force push failed: {0}', errorText(error)));
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
		{ placeHolder: vscode.l10n.t('Choose the commit to edit'), matchOnDescription: true },
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
				vscode.window.showErrorMessage(vscode.l10n.t('Cannot edit the commit: {0}', errorText(error)));
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
