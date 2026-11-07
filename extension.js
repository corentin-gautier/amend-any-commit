const vscode = require('vscode');
const path = require('path');
const { commitSubject, fixup, drop, squashInfo, squash, commitParents, revert, remotes, splitRemoteRef, branchUpstream, pushBranch, pushTag, fetchInto, inspect, reword, forcePush, resetTo, checkBranchName, renameBranch, mergeInfo, merge, rebaseInfo, rebase, abort, hasLocalChanges, resolveCommit, currentBranch, identity, repositoryRoot, listCommits, RewordError } = require('./reword');

const FORCE_PUSH_KEY = 'forcePush';

function errorText(error) {
	if (error instanceof RewordError) {
		switch (error.code) {
			case 'notInHead': return vscode.l10n.t('This commit is not on the current branch.');
			case 'operationInProgress': return vscode.l10n.t('A rebase, merge or cherry-pick is in progress.');
			case 'dirty': return vscode.l10n.t('Commit or stash your changes first.');
			case 'merges': return vscode.l10n.t('There is a merge commit between this commit and HEAD.');
			case 'conflicts': return vscode.l10n.t('There are conflicts.');
			case 'invalidName': return vscode.l10n.t('This is not a valid branch name.');
			case 'branchExists': return vscode.l10n.t('A branch with this name already exists.');
			case 'nothingStaged': return vscode.l10n.t('There are no staged changes. Stage what you want to add first.');
			case 'root': return vscode.l10n.t('The first commit of the repository cannot be dropped.');
			case 'currentBranch': return vscode.l10n.t('This is the current branch: pull instead.');
			case 'noRemote': return vscode.l10n.t('This repository has no remote.');
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
async function askEdit(cwd, info, forcePushDefault, title = vscode.l10n.t('Edit Commit ({0})', info.sha.slice(0, 7))) {
	const [subject, ...rest] = info.message.split('\n');
	const state = {
		subject,
		// The blank line after the subject is implied; the description is what follows it.
		description: rest.join('\n').replace(/^\n+/, ''),
		author: `${info.author.name} <${info.author.email}>`,
		date: info.author.isoDate,
		forcePush: forcePushDefault,
	};
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

// The commit is already pushed: asks before rewriting it. Resolves with true to go on.
async function confirmRewritePushed(proceed) {
	const choice = await vscode.window.showWarningMessage(
		vscode.l10n.t('This commit is already pushed'),
		{ modal: true, detail: vscode.l10n.t('Its history will be rewritten: you will need to force push (git push --force-with-lease).') },
		proceed,
	);
	return choice === proceed;
}

// Edits a commit (`squashing` false), or squashes it with all the commits after it into one (`squashing` true):
// both go through the same list of fields.
async function amendCommit(context, cwd, commit, squashing = false) {
	if (!cwd || !commit) {
		return;
	}
	const fail = error => vscode.window.showErrorMessage(squashing
		? vscode.l10n.t('Cannot squash the commits: {0}', errorText(error))
		: vscode.l10n.t('Cannot edit the commit: {0}', errorText(error)));
	let info, title;
	try {
		// Squashing keeps the content of HEAD, so local changes are no problem.
		info = await inspect(cwd, commit, { allowDirty: squashing });
		if (squashing) {
			const { count, message } = await squashInfo(cwd, info);
			if (count < 2) {
				vscode.window.showInformationMessage(vscode.l10n.t('This is the last commit: there is nothing to squash it with.'));
				return;
			}
			info = { ...info, message };
			title = vscode.l10n.t('Squash {0} Commits ({1} to HEAD)', count, info.sha.slice(0, 7));
		}
	} catch (error) {
		fail(error);
		return;
	}

	const answer = await askEdit(cwd, info, context.globalState.get(FORCE_PUSH_KEY, false), title);
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
	if (unchanged && !squashing) {
		return;
	}

	// Ticking force push is already the informed choice; otherwise warn that the history diverges.
	if (info.pushed && !answer.forcePush && !await confirmRewritePushed(squashing ? vscode.l10n.t('Squash Anyway') : vscode.l10n.t('Edit Anyway'))) {
		return;
	}

	try {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, () => squashing
			? squash(cwd, info, answer.message, answer.author)
			: reword(cwd, info, answer.message, answer.author));
	} catch (error) {
		fail(error);
		return;
	}

	if (answer.forcePush) {
		await forcePushAfter(cwd, info, squashing);
	}
}

async function forcePushAfter(cwd, info, squashing) {
	try {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, () => forcePush(cwd, info));
		vscode.window.setStatusBarMessage(squashing
			? vscode.l10n.t('$(check) Commits squashed and force pushed')
			: vscode.l10n.t('$(check) Commit edited and force pushed'), 4000);
	} catch (error) {
		vscode.window.showErrorMessage(squashing
			? vscode.l10n.t('The commits are squashed, but the force push failed: {0}', errorText(error))
			: vscode.l10n.t('The commit is edited, but the force push failed: {0}', errorText(error)));
	}
}

// Runs a rewrite that may stop on conflicts (a rebase), with `fail` for the other errors.
async function runRewrite(cwd, run, fail, restore) {
	try {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, run);
		return true;
	} catch (error) {
		if (error instanceof RewordError && error.code === 'conflicts') {
			await reportConflicts(cwd, 'rebase', restore);
		} else {
			fail(error);
		}
		return false;
	}
}

// Folds the staged changes into an older commit, like `git commit --fixup` then an autosquash rebase.
async function fixupCommit(cwd, commit) {
	if (!cwd || !commit) {
		return;
	}
	const fail = error => vscode.window.showErrorMessage(vscode.l10n.t('Cannot add the changes to the commit: {0}', errorText(error)));
	let info;
	try {
		info = await inspect(cwd, commit, { allowDirty: true });
	} catch (error) {
		fail(error);
		return;
	}
	if (info.pushed && !await confirmRewritePushed(vscode.l10n.t('Add Anyway'))) {
		return;
	}
	if (await runRewrite(cwd, () => fixup(cwd, info), fail, info.head)) {
		vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) Staged changes added to {0}', info.sha.slice(0, 7)), 4000);
	}
}

// Removes a commit from the current branch, after a confirmation.
async function dropCommit(cwd, commit) {
	if (!cwd || !commit) {
		return;
	}
	const fail = error => vscode.window.showErrorMessage(vscode.l10n.t('Cannot drop the commit: {0}', errorText(error)));
	let info;
	try {
		info = await inspect(cwd, commit);
		if (info.parents.length === 0) {
			throw new RewordError('root');
		}
	} catch (error) {
		fail(error);
		return;
	}
	const subject = info.message.split('\n')[0];
	const details = [vscode.l10n.t('Its changes are removed from the branch, and the commits after it are replayed.')];
	if (info.pushed) {
		details.push(vscode.l10n.t('It is already pushed: you will need to force push (git push --force-with-lease).'));
	}
	const proceed = vscode.l10n.t('Drop');
	const answer = await vscode.window.showWarningMessage(
		vscode.l10n.t('Drop commit {0} "{1}"?', info.sha.slice(0, 7), subject),
		{ modal: true, detail: details.join('\n\n') },
		proceed,
	);
	if (answer === proceed) {
		await runRewrite(cwd, () => drop(cwd, info), fail);
	}
}

// Creates a commit that undoes this one; for a merge, asks which parent is the mainline.
async function revertCommit(cwd, commit) {
	if (!cwd || !commit) {
		return;
	}
	const fail = error => vscode.window.showErrorMessage(vscode.l10n.t('Cannot revert the commit: {0}', errorText(error)));
	let parents, subject, sha;
	try {
		sha = await resolveCommit(cwd, commit);
		parents = await commitParents(cwd, sha);
		subject = await commitSubject(cwd, sha);
	} catch (error) {
		fail(error);
		return;
	}
	let parent;
	if (parents.length > 1) {
		const choice = await vscode.window.showQuickPick(parents.map((parent, index) => ({
			label: `$(git-commit) ${parent.subject}`,
			description: parent.sha.slice(0, 7),
			detail: index === 0 ? vscode.l10n.t('Parent 1, usually the branch merged into') : vscode.l10n.t('Parent {0}, usually the branch merged', index + 1),
			parent: index + 1,
		})), {
			title: vscode.l10n.t('Revert Merge {0}', sha.slice(0, 7)),
			placeHolder: vscode.l10n.t('Choose the parent to go back to'),
		});
		if (!choice) {
			return;
		}
		parent = choice.parent;
	} else {
		const proceed = vscode.l10n.t('Revert');
		const answer = await vscode.window.showInformationMessage(
			vscode.l10n.t('Revert commit {0} "{1}"?', sha.slice(0, 7), subject),
			{ modal: true, detail: vscode.l10n.t('A new commit undoes its changes. The history is not rewritten.') },
			proceed,
		);
		if (answer !== proceed) {
			return;
		}
	}
	try {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, () => revert(cwd, sha, parent));
	} catch (error) {
		if (error instanceof RewordError && error.code === 'conflicts') {
			await reportConflicts(cwd, 'revert');
		} else {
			fail(error);
		}
	}
}

// Resets the current branch to `commit`, after asking the mode (soft, mixed or hard) as Git Graph does.
async function resetBranch(cwd, commit) {
	if (!cwd || !commit) {
		return;
	}
	const fail = error => vscode.window.showErrorMessage(vscode.l10n.t('Cannot reset the branch: {0}', errorText(error)));
	let branch, short;
	try {
		short = (await resolveCommit(cwd, commit)).slice(0, 7);
		branch = await currentBranch(cwd);
	} catch (error) {
		fail(error);
		return;
	}
	const modes = [
		{ mode: 'soft', label: '$(git-commit) Soft', description: '--soft', detail: vscode.l10n.t('Keep all changes, staged') },
		{ mode: 'mixed', label: '$(diff) Mixed', description: '--mixed', detail: vscode.l10n.t('Keep all changes, unstaged') },
		{ mode: 'hard', label: '$(warning) Hard', description: '--hard', detail: vscode.l10n.t('Discard all changes') },
	];
	const choice = await vscode.window.showQuickPick(modes, {
		title: branch
			? vscode.l10n.t('Reset {0} to {1}', branch, short)
			: vscode.l10n.t('Reset HEAD to {0}', short),
		placeHolder: vscode.l10n.t('Choose the reset mode'),
		activeItem: modes[1],
	});
	if (!choice) {
		return;
	}
	try {
		if (choice.mode === 'hard' && await hasLocalChanges(cwd)) {
			const proceed = vscode.l10n.t('Reset Anyway');
			const answer = await vscode.window.showWarningMessage(
				vscode.l10n.t('You have uncommitted changes'),
				{ modal: true, detail: vscode.l10n.t('A hard reset discards them for good.') },
				proceed,
			);
			if (answer !== proceed) {
				return;
			}
		}
		await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, () => resetTo(cwd, commit, choice.mode));
	} catch (error) {
		fail(error);
	}
}

// After a merge or rebase stopped on conflicts: shows where to resolve them, and offers to abort.
async function reportConflicts(cwd, operation, restore) {
	vscode.commands.executeCommand('workbench.view.scm');
	const texts = {
		rebase: [vscode.l10n.t('Abort Rebase'), vscode.l10n.t('The rebase stopped on conflicts. Resolve them in Source Control, then continue the rebase.')],
		merge: [vscode.l10n.t('Abort Merge'), vscode.l10n.t('The merge stopped on conflicts. Resolve them in Source Control, then commit.')],
		revert: [vscode.l10n.t('Abort Revert'), vscode.l10n.t('The revert stopped on conflicts. Resolve them in Source Control, then commit.')],
	};
	const [abortLabel, message] = texts[operation];
	const choice = await vscode.window.showWarningMessage(message, abortLabel);
	if (choice === abortLabel) {
		try {
			await abort(cwd, operation, restore);
		} catch (error) {
			vscode.window.showErrorMessage(errorText(error));
		}
	}
}

// Merges `commit` (or the branch pointing at it) into the current branch, after asking how, as Git Graph does.
async function mergeCommit(cwd, commit) {
	if (!cwd || !commit) {
		return;
	}
	const fail = error => vscode.window.showErrorMessage(vscode.l10n.t('Cannot merge: {0}', errorText(error)));
	let info, branch;
	try {
		info = await mergeInfo(cwd, commit);
		branch = await currentBranch(cwd) ?? 'HEAD';
	} catch (error) {
		fail(error);
		return;
	}
	const name = info.target === info.sha ? info.sha.slice(0, 7) : info.target;
	if (info.upToDate) {
		vscode.window.showInformationMessage(vscode.l10n.t('{0} is already merged into {1}.', name, branch));
		return;
	}
	const modes = [
		{ mode: 'noff', label: `$(git-merge) ${vscode.l10n.t('Merge Commit')}`, description: '--no-ff', detail: vscode.l10n.t('Always create a merge commit') },
		// Without a possible fast-forward, this would be the same as the merge commit.
		...info.canFastForward ? [{ mode: 'ff', label: `$(arrow-up) ${vscode.l10n.t('Fast-Forward')}`, description: '--ff', detail: vscode.l10n.t('Move {0} forward to {1}, without a merge commit', branch, name) }] : [],
		{ mode: 'squash', label: `$(fold) ${vscode.l10n.t('Squash')}`, description: '--squash', detail: vscode.l10n.t('Stage all the changes, without committing: you write the commit') },
	];
	const choice = await vscode.window.showQuickPick(modes, {
		title: vscode.l10n.t('Merge {0} into {1}', name, branch),
		placeHolder: vscode.l10n.t('Choose how to merge'),
	});
	if (!choice) {
		return;
	}
	try {
		await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, () => merge(cwd, info.target, choice.mode));
	} catch (error) {
		if (error instanceof RewordError && error.code === 'conflicts') {
			await reportConflicts(cwd, 'merge');
		} else {
			fail(error);
		}
		return;
	}
	if (choice.mode === 'squash') {
		vscode.commands.executeCommand('workbench.view.scm');
		vscode.window.showInformationMessage(vscode.l10n.t('The changes of {0} are staged: commit them to finish the squash.', name));
	}
}

// Replays the commits of the current branch on top of `commit`, after a confirmation.
async function rebaseOnCommit(cwd, commit) {
	if (!cwd || !commit) {
		return;
	}
	const fail = error => vscode.window.showErrorMessage(vscode.l10n.t('Cannot rebase: {0}', errorText(error)));
	let info, branch;
	try {
		info = await rebaseInfo(cwd, commit);
		branch = await currentBranch(cwd) ?? 'HEAD';
	} catch (error) {
		fail(error);
		return;
	}
	const short = info.sha.slice(0, 7);
	if (info.upToDate) {
		vscode.window.showInformationMessage(vscode.l10n.t('{0} is already based on {1}.', branch, short));
		return;
	}
	const proceed = vscode.l10n.t('Rebase');
	const details = [
		info.count === 1
			? vscode.l10n.t('1 commit will be replayed on top of {0}.', short)
			: vscode.l10n.t('{0} commits will be replayed on top of {1}.', info.count, short),
	];
	if (info.pushed) {
		details.push(vscode.l10n.t('Some of them are already pushed: you will need to force push (git push --force-with-lease).'));
	}
	const answer = await vscode.window.showWarningMessage(
		vscode.l10n.t('Rebase {0} on {1}?', branch, short),
		{ modal: true, detail: details.join('\n\n') },
		proceed,
	);
	if (answer !== proceed) {
		return;
	}
	await runRewrite(cwd, () => rebase(cwd, info.sha), fail);
}

// Renames a local branch, from its label in the Source Control Graph.
async function renameRef(cwd, ref) {
	if (!cwd || !ref?.startsWith('refs/heads/')) {
		return;
	}
	const from = ref.slice('refs/heads/'.length);
	const to = (await vscode.window.showInputBox({
		title: vscode.l10n.t('Rename Branch {0}', from),
		value: from,
		prompt: vscode.l10n.t('New branch name'),
		validateInput: async value => {
			value = value.trim();
			if (value === from) {
				return undefined;
			}
			const problem = await checkBranchName(cwd, value);
			return problem && errorText(new RewordError(problem));
		},
	}))?.trim();
	if (!to || to === from) {
		return;
	}
	try {
		await renameBranch(cwd, from, to);
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t('Cannot rename the branch: {0}', errorText(error)));
	}
}

const refName = ref => ref.replace(/^refs\/(heads|remotes|tags)\//, '');

// Chooses the remote to push to: the only one, or the user's choice, `preferred` first.
async function pickRemote(cwd, preferred) {
	const names = await remotes(cwd);
	if (names.length === 0) {
		throw new RewordError('noRemote');
	}
	if (names.length === 1) {
		return names[0];
	}
	names.sort((a, b) => (b === preferred) - (a === preferred) || (b === 'origin') - (a === 'origin'));
	const choice = await vscode.window.showQuickPick(names.map(name => ({ label: `$(cloud) ${name}`, name })), {
		placeHolder: vscode.l10n.t('Choose the remote'),
	});
	return choice?.name;
}

// The remote the current branch pushes to, to offer it first.
async function currentRemote(cwd) {
	const branch = await currentBranch(cwd);
	return branch && (await branchUpstream(cwd, branch))?.remote;
}

// Pushes a local branch, to its upstream or to a remote it then tracks; optionally with --force-with-lease.
async function pushRef(cwd, ref) {
	if (!cwd || !ref?.startsWith('refs/heads/')) {
		return;
	}
	const branch = refName(ref);
	const fail = error => vscode.window.showErrorMessage(vscode.l10n.t('Cannot push the branch: {0}', errorText(error)));
	try {
		const upstream = await branchUpstream(cwd, branch);
		const modes = [
			{ force: false, label: `$(cloud-upload) ${vscode.l10n.t('Push')}`, detail: upstream ? undefined : vscode.l10n.t('The remote branch becomes its upstream') },
			{ force: true, label: `$(warning) ${vscode.l10n.t('Force Push')}`, description: '--force-with-lease', detail: vscode.l10n.t('Only if nobody pushed to it in the meantime') },
		];
		const choice = await vscode.window.showQuickPick(modes, {
			title: upstream
				? vscode.l10n.t('Push {0} to {1}', branch, `${upstream.remote}/${refName(upstream.ref)}`)
				: vscode.l10n.t('Push {0}', branch),
		});
		if (!choice) {
			return;
		}
		const remote = upstream ? undefined : await pickRemote(cwd, await currentRemote(cwd));
		if (!upstream && !remote) {
			return;
		}
		await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, () => pushBranch(cwd, branch, { remote, force: choice.force }));
		vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) {0} pushed', branch), 4000);
	} catch (error) {
		fail(error);
	}
}

// Updates or creates a local branch from a remote branch (fast-forward only), without checking it out.
async function fetchRef(cwd, ref) {
	if (!cwd || !ref?.startsWith('refs/remotes/')) {
		return;
	}
	const fail = error => vscode.window.showErrorMessage(vscode.l10n.t('Cannot fetch the branch: {0}', errorText(error)));
	try {
		const remoteRef = await splitRemoteRef(cwd, ref);
		if (!remoteRef) {
			return;
		}
		const local = (await vscode.window.showInputBox({
			title: vscode.l10n.t('Fetch {0} into a Local Branch', refName(ref)),
			value: remoteRef.branch,
			prompt: vscode.l10n.t('Local branch to create or move forward'),
		}))?.trim();
		if (!local) {
			return;
		}
		await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, () => fetchInto(cwd, remoteRef.remote, remoteRef.branch, local));
		vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) {0} updated', local), 4000);
	} catch (error) {
		fail(error);
	}
}

async function pushTagRef(cwd, ref) {
	if (!cwd || !ref?.startsWith('refs/tags/')) {
		return;
	}
	const tag = refName(ref);
	try {
		const remote = await pickRemote(cwd, await currentRemote(cwd));
		if (!remote) {
			return;
		}
		await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, () => pushTag(cwd, tag, remote));
		vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) {0} pushed', tag), 4000);
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t('Cannot push the tag: {0}', errorText(error)));
	}
}

async function copyRefName(ref) {
	if (ref) {
		await vscode.env.clipboard.writeText(refName(ref));
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
		vscode.commands.registerCommand('sourceControlGraphPlus.amend', (sourceControl, historyItem) =>
			amendCommit(context, sourceControl?.rootUri?.fsPath, historyItem?.id)),
		vscode.commands.registerCommand('sourceControlGraphPlus.reset', (sourceControl, historyItem) =>
			resetBranch(sourceControl?.rootUri?.fsPath, historyItem?.id)),
		// Branch label in the graph: (source control, history item, ref id such as refs/heads/main).
		vscode.commands.registerCommand('sourceControlGraphPlus.renameBranch', (sourceControl, historyItem, ref) =>
			renameRef(sourceControl?.rootUri?.fsPath, ref)),
		vscode.commands.registerCommand('sourceControlGraphPlus.pushBranch', (sourceControl, historyItem, ref) =>
			pushRef(sourceControl?.rootUri?.fsPath, ref)),
		vscode.commands.registerCommand('sourceControlGraphPlus.fetchBranch', (sourceControl, historyItem, ref) =>
			fetchRef(sourceControl?.rootUri?.fsPath, ref)),
		vscode.commands.registerCommand('sourceControlGraphPlus.pushTag', (sourceControl, historyItem, ref) =>
			pushTagRef(sourceControl?.rootUri?.fsPath, ref)),
		vscode.commands.registerCommand('sourceControlGraphPlus.copyBranchName', (sourceControl, historyItem, ref) => copyRefName(ref)),
		vscode.commands.registerCommand('sourceControlGraphPlus.copyTagName', (sourceControl, historyItem, ref) => copyRefName(ref)),
		vscode.commands.registerCommand('sourceControlGraphPlus.fixup', (sourceControl, historyItem) =>
			fixupCommit(sourceControl?.rootUri?.fsPath, historyItem?.id)),
		vscode.commands.registerCommand('sourceControlGraphPlus.squash', (sourceControl, historyItem) =>
			amendCommit(context, sourceControl?.rootUri?.fsPath, historyItem?.id, true)),
		vscode.commands.registerCommand('sourceControlGraphPlus.drop', (sourceControl, historyItem) =>
			dropCommit(sourceControl?.rootUri?.fsPath, historyItem?.id)),
		vscode.commands.registerCommand('sourceControlGraphPlus.revert', (sourceControl, historyItem) =>
			revertCommit(sourceControl?.rootUri?.fsPath, historyItem?.id)),
		vscode.commands.registerCommand('sourceControlGraphPlus.merge', (sourceControl, historyItem) =>
			mergeCommit(sourceControl?.rootUri?.fsPath, historyItem?.id)),
		vscode.commands.registerCommand('sourceControlGraphPlus.rebase', (sourceControl, historyItem) =>
			rebaseOnCommit(sourceControl?.rootUri?.fsPath, historyItem?.id)),
		// Timeline: (git timeline item, file uri). The item's ref is the commit hash.
		vscode.commands.registerCommand('sourceControlGraphPlus.amendFromTimeline', async (item, uri) => {
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
		vscode.commands.registerCommand('sourceControlGraphPlus.pick', async sourceControl => {
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
