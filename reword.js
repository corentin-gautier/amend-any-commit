const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// Runs git in the repository and resolves with its trimmed stdout.
function git(cwd, args, { input, env } = {}) {
	return new Promise((resolve, reject) => {
		const child = execFile('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				error.stderr = stderr.trim();
				reject(error);
			} else {
				resolve(stdout.replace(/\n+$/, ''));
			}
		});
		if (input !== undefined) {
			child.stdin.end(input);
		}
	});
}

async function succeeds(cwd, args) {
	try {
		await git(cwd, args);
		return true;
	} catch {
		return false;
	}
}

class RewordError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}

// Everything the user needs to see before rewording, or a RewordError saying why it can't be done.
// `allowDirty` skips the clean tree check, for operations that leave the working tree alone.
async function inspect(cwd, commit, { allowDirty = false } = {}) {
	const sha = await git(cwd, ['rev-parse', '--verify', `${commit}^{commit}`]);
	const head = await git(cwd, ['rev-parse', 'HEAD']);
	if (!await succeeds(cwd, ['merge-base', '--is-ancestor', sha, head])) {
		throw new RewordError('notInHead');
	}
	if (await operationInProgress(cwd)) {
		throw new RewordError('operationInProgress');
	}
	// Untracked files are fine: the rebase replays the same trees, so it never writes over them.
	if (!allowDirty && await hasLocalChanges(cwd)) {
		throw new RewordError('dirty');
	}
	const parents = (await git(cwd, ['rev-list', '--parents', '-n', '1', sha])).split(' ').slice(1);
	// A plain rebase would flatten merges, so the commit and everything after it must be linear.
	if (parents.length > 1 || await git(cwd, ['rev-list', '--merges', `${sha}..${head}`]) !== '') {
		throw new RewordError('merges');
	}
	const message = await git(cwd, ['log', '-1', '--format=%B', sha]);
	// The raw date keeps the exact timestamp; the ISO one is what the user reads and edits.
	const [name, email, date, isoDate] = (await git(cwd, ['log', '-1', '--format=%an%x00%ae%x00%ad%x00%ai', '--date=raw', sha])).split('\0');
	const author = { name, email, date, isoDate };
	// Rewriting a commit the upstream already has means a force push afterwards.
	let pushed = false;
	let upstream;
	const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => undefined);
	if (branch && await succeeds(cwd, ['rev-parse', '--verify', '@{upstream}'])) {
		upstream = {
			remote: await git(cwd, ['config', `branch.${branch}.remote`]),
			ref: await git(cwd, ['config', `branch.${branch}.merge`]),
			sha: await git(cwd, ['rev-parse', '@{upstream}']),
		};
		pushed = await succeeds(cwd, ['merge-base', '--is-ancestor', sha, upstream.sha]);
	}
	return { sha, head, parents, message, author, pushed, upstream };
}

// Pushes the rewritten branch, but only if the remote still points where it did before the reword,
// so commits someone else pushed in between are never lost.
async function forcePush(cwd, info) {
	const { remote, ref, sha } = info.upstream;
	await git(cwd, ['push', '--porcelain', `--force-with-lease=${ref}:${sha}`, remote, `HEAD:${ref}`]);
}

// Replaces the message and author of `info.sha` (from inspect) and replays the commits after it.
// `author` is { name, email, date }, the date in any format git accepts; it defaults to the current author.
async function reword(cwd, info, message, author = info.author) {
	const { sha, head, parents } = info;
	// The new commit keeps the tree and parents of the old one; only the message and author can change.
	const { name, email, date } = author;
	const args = ['commit-tree', `${sha}^{tree}`, ...parents.flatMap(parent => ['-p', parent]), '-F', '-'];
	const rewritten = await git(cwd, args, {
		input: message.endsWith('\n') ? message : `${message}\n`,
		env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date },
	});
	if (sha === head) {
		await git(cwd, ['update-ref', '-m', 'reword: edit commit', 'HEAD', rewritten, head]);
	} else {
		// Same tree as the old commit, so replaying the later commits onto it cannot conflict.
		await git(cwd, ['rebase', '--no-autosquash', '--reapply-cherry-picks', '--onto', rewritten, sha], {
			env: { GIT_REFLOG_ACTION: 'reword' },
		});
	}
	return rewritten;
}

// Moves the current branch (or a detached HEAD) to `commit`, like `git reset --soft|--mixed|--hard`.
async function resetTo(cwd, commit, mode) {
	if (!['soft', 'mixed', 'hard'].includes(mode)) {
		throw new Error(`Unknown reset mode: ${mode}`);
	}
	const sha = await resolveCommit(cwd, commit);
	await git(cwd, ['reset', '--quiet', `--${mode}`, sha]);
	return sha;
}

// Which of these files exist in the git directory.
async function gitDirHas(cwd, names) {
	const gitDir = await git(cwd, ['rev-parse', '--absolute-git-dir']);
	return names.filter(name => fs.existsSync(path.join(gitDir, name)));
}

async function operationInProgress(cwd) {
	return (await gitDirHas(cwd, ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'])).length > 0;
}

const isAncestor = (cwd, ancestor, commit) => succeeds(cwd, ['merge-base', '--is-ancestor', ancestor, commit]);

// What merging `commit` into HEAD means: the name to merge (a branch pointing at the commit, local first,
// so the merge message names it; else the commit itself), whether there is anything to merge, and whether
// the branch could just move forward.
async function mergeInfo(cwd, commit) {
	const sha = await resolveCommit(cwd, commit);
	const head = await git(cwd, ['rev-parse', 'HEAD']);
	const branch = await currentBranch(cwd);
	const refs = (await git(cwd, ['for-each-ref', '--points-at', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes']))
		.split('\n').filter(ref => ref && !ref.endsWith('/HEAD') && ref !== `refs/heads/${branch}`);
	const ref = refs.find(ref => ref.startsWith('refs/heads/')) ?? refs[0];
	return {
		sha,
		target: ref ? ref.replace(/^refs\/(heads|remotes)\//, '') : sha,
		upToDate: await isAncestor(cwd, sha, head),
		canFastForward: await isAncestor(cwd, head, sha),
	};
}

// Merges `target` into HEAD. `mode` is 'noff' (always a merge commit), 'ff' (fast-forward when possible)
// or 'squash' (changes staged, nothing committed). Throws a RewordError 'conflicts' when the merge stopped on
// conflicts, which are then left in the working tree to resolve.
async function merge(cwd, target, mode) {
	const flags = { noff: ['--no-ff'], ff: ['--ff'], squash: ['--squash'] }[mode];
	if (!flags) {
		throw new Error(`Unknown merge mode: ${mode}`);
	}
	if (await operationInProgress(cwd)) {
		throw new RewordError('operationInProgress');
	}
	try {
		await git(cwd, ['merge', '--no-edit', ...flags, target]);
	} catch (error) {
		if (await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '') !== '') {
			throw new RewordError('conflicts');
		}
		throw error;
	}
}

// What rebasing HEAD on `commit` means: how many commits are replayed, whether HEAD already sits on it,
// and whether some of the replayed commits are already pushed (so a force push will be needed).
async function rebaseInfo(cwd, commit) {
	const sha = await resolveCommit(cwd, commit);
	const base = await git(cwd, ['merge-base', sha, 'HEAD']);
	const count = Number(await git(cwd, ['rev-list', '--count', `${base}..HEAD`]));
	let pushed = false;
	if (count > 0 && await succeeds(cwd, ['rev-parse', '--verify', '@{upstream}'])) {
		const shared = await git(cwd, ['merge-base', 'HEAD', '@{upstream}']).catch(() => undefined);
		pushed = !!shared && Number(await git(cwd, ['rev-list', '--count', `${base}..${shared}`])) > 0;
	}
	return { sha, count, upToDate: base === sha, pushed };
}

// Runs a rebase without any editor; a stop on conflicts becomes a RewordError 'conflicts'.
async function runRebase(cwd, args) {
	try {
		await git(cwd, ['rebase', ...args], { env: { GIT_SEQUENCE_EDITOR: ':', GIT_EDITOR: ':' } });
	} catch (error) {
		if ((await gitDirHas(cwd, ['rebase-merge', 'rebase-apply'])).length > 0) {
			throw new RewordError('conflicts');
		}
		throw error;
	}
}

// Replays the commits of HEAD on top of `commit`, like `git rebase <commit>`. Throws a RewordError
// 'conflicts' when the rebase stopped on conflicts: it is then in progress, to continue or abort.
async function rebase(cwd, commit) {
	if (await operationInProgress(cwd)) {
		throw new RewordError('operationInProgress');
	}
	if (await hasLocalChanges(cwd)) {
		throw new RewordError('dirty');
	}
	await runRebase(cwd, [await resolveCommit(cwd, commit)]);
}

async function hasStagedChanges(cwd) {
	return !await succeeds(cwd, ['diff', '--cached', '--quiet']);
}

// Folds the staged changes into `info.sha` (from inspect with allowDirty), then replays the commits after it.
// Unstaged changes are set aside during the rebase and put back after. On conflicts the rebase is left in
// progress; abort(cwd, 'rebase', info.head) puts everything back, the changes staged again.
async function fixup(cwd, info) {
	if (!await hasStagedChanges(cwd)) {
		throw new RewordError('nothingStaged');
	}
	if (info.sha === info.head) {
		await git(cwd, ['commit', '--quiet', '--amend', '--no-edit', '--no-verify']);
		return;
	}
	await git(cwd, ['commit', '--quiet', '--no-verify', `--fixup=${info.sha}`]);
	// The rebase starts at the commit, so it is the first one autosquash can match.
	await runRebase(cwd, ['-i', '--autosquash', '--autostash', '--no-update-refs', info.parents[0] ?? '--root']);
}

// Removes `info.sha` (from inspect) from the branch and replays the commits after it.
async function drop(cwd, info) {
	if (info.parents.length === 0) {
		throw new RewordError('root');
	}
	await runRebase(cwd, ['--no-update-refs', '--onto', info.parents[0], info.sha]);
}

// The commits from `info.sha` to HEAD, oldest first, and their messages put together as git's squash does.
async function squashInfo(cwd, info) {
	const range = info.parents.length ? [`${info.sha}^..HEAD`] : ['HEAD'];
	const messages = (await git(cwd, ['log', '--reverse', '--format=%B%x00', ...range]))
		.split('\0').map(message => message.trim()).filter(Boolean);
	return { count: messages.length, message: messages.join('\n\n') };
}

// Replaces the commits from `info.sha` to HEAD by one commit, with the content of HEAD and the given message
// and author. The working tree and the index are left as they are.
async function squash(cwd, info, message, author = info.author) {
	const { name, email, date } = author;
	const squashed = await git(cwd, ['commit-tree', 'HEAD^{tree}', ...info.parents.flatMap(parent => ['-p', parent]), '-F', '-'], {
		input: message.endsWith('\n') ? message : `${message}\n`,
		env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date },
	});
	await git(cwd, ['update-ref', '-m', 'squash: squash commits', 'HEAD', squashed, info.head]);
	return squashed;
}

// The parents of a commit, with their subjects, to choose the mainline when reverting a merge.
async function commitParents(cwd, commit) {
	const parents = (await git(cwd, ['log', '-1', '--format=%P', commit])).split(' ').filter(Boolean);
	return Promise.all(parents.map(async sha => ({ sha, subject: await git(cwd, ['log', '-1', '--format=%s', sha]) })));
}

// Creates a commit that undoes `commit`, like `git revert`; `parent` (1-based) is the mainline of a merge.
// Throws a RewordError 'conflicts' when it stopped on conflicts, then left in progress.
async function revert(cwd, commit, parent) {
	if (await operationInProgress(cwd)) {
		throw new RewordError('operationInProgress');
	}
	try {
		await git(cwd, ['revert', '--no-edit', ...parent ? ['-m', String(parent)] : [], await resolveCommit(cwd, commit)]);
	} catch (error) {
		if ((await gitDirHas(cwd, ['REVERT_HEAD'])).length > 0) {
			throw new RewordError('conflicts');
		}
		throw error;
	}
}

async function remotes(cwd) {
	return (await git(cwd, ['remote'])).split('\n').filter(Boolean);
}

// Splits a remote branch ref (refs/remotes/<remote>/<branch>) into { remote, branch }; remote names may have slashes.
async function splitRemoteRef(cwd, ref) {
	const remote = (await remotes(cwd))
		.filter(remote => ref.startsWith(`refs/remotes/${remote}/`))
		.sort((a, b) => b.length - a.length)[0];
	return remote ? { remote, branch: ref.slice(`refs/remotes/${remote}/`.length) } : undefined;
}

// The upstream of a local branch, as { remote, ref }, or undefined.
async function branchUpstream(cwd, branch) {
	const remote = await git(cwd, ['config', `branch.${branch}.remote`]).catch(() => '');
	const ref = await git(cwd, ['config', `branch.${branch}.merge`]).catch(() => '');
	return remote && ref ? { remote, ref } : undefined;
}

// Pushes a local branch to its upstream, or to `remote` under the same name, then set as its upstream.
// `force` uses --force-with-lease: only if the remote branch is still where we last fetched it.
async function pushBranch(cwd, branch, { remote, force = false } = {}) {
	const upstream = await branchUpstream(cwd, branch);
	const lease = force ? ['--force-with-lease'] : [];
	if (upstream) {
		await git(cwd, ['push', '--porcelain', ...lease, upstream.remote, `refs/heads/${branch}:${upstream.ref}`]);
	} else {
		await git(cwd, ['push', '--porcelain', ...lease, '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
	}
}

async function pushTag(cwd, tag, remote) {
	await git(cwd, ['push', '--porcelain', remote, `refs/tags/${tag}:refs/tags/${tag}`]);
}

// Updates (or creates) the local branch `local` from a remote branch, fast-forward only, without checking it out.
async function fetchInto(cwd, remote, branch, local) {
	if (local === await currentBranch(cwd)) {
		throw new RewordError('currentBranch');
	}
	if (!local || local.startsWith('-') || !await succeeds(cwd, ['check-ref-format', '--branch', local])) {
		throw new RewordError('invalidName');
	}
	await git(cwd, ['fetch', '--quiet', remote, `refs/heads/${branch}:refs/heads/${local}`]);
}

// Gives up a merge, rebase or revert stopped on conflicts and puts things back as they were before it.
// `restore`, for a rebase, is a commit to go back to after it, keeping the changes staged.
async function abort(cwd, operation, restore) {
	if (operation === 'rebase') {
		await git(cwd, ['rebase', '--abort']);
		if (restore) {
			await git(cwd, ['reset', '--quiet', '--soft', restore]);
		}
	} else if (operation === 'revert') {
		await git(cwd, ['revert', '--abort']);
	} else if ((await gitDirHas(cwd, ['MERGE_HEAD'])).length > 0) {
		await git(cwd, ['merge', '--abort']);
	} else {
		// A squash merge leaves no MERGE_HEAD; this is what `merge --abort` does.
		await git(cwd, ['reset', '--merge']);
	}
}

// Whether `name` can be a new branch: a valid branch name, not taken. Resolves with a RewordError code
// ('invalidName' or 'branchExists'), or undefined when it is fine.
async function checkBranchName(cwd, name) {
	if (!name || name.startsWith('-') || !await succeeds(cwd, ['check-ref-format', '--branch', name])) {
		return 'invalidName';
	}
	if (await succeeds(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])) {
		return 'branchExists';
	}
	return undefined;
}

// Renames a local branch, like `git branch -m`: its upstream and reflog follow it.
async function renameBranch(cwd, from, to) {
	const problem = await checkBranchName(cwd, to);
	if (problem) {
		throw new RewordError(problem);
	}
	await git(cwd, ['branch', '-m', '--', from, to]);
}

function commitSubject(cwd, commit) {
	return git(cwd, ['log', '-1', '--format=%s', commit]);
}

function resolveCommit(cwd, commit) {
	return git(cwd, ['rev-parse', '--verify', `${commit}^{commit}`]);
}

// The checked out branch, or undefined on a detached HEAD.
function currentBranch(cwd) {
	return git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => undefined);
}

// Whether tracked files have changes, staged or not, that a hard reset would discard.
async function hasLocalChanges(cwd) {
	return await git(cwd, ['status', '--porcelain', '--untracked-files=no']) !== '';
}

// The identity git would use for a new commit in this repository (user.name, user.email), if set.
async function identity(cwd) {
	const name = await git(cwd, ['config', 'user.name']).catch(() => '');
	const email = await git(cwd, ['config', 'user.email']).catch(() => '');
	return name && email ? { name, email } : undefined;
}

function repositoryRoot(dir) {
	return git(dir, ['rev-parse', '--show-toplevel']);
}

// The commits that can be reworded, newest first: the current branch back to its first merge commit,
// since everything at or after a merge is refused anyway.
async function listCommits(cwd, limit = 200) {
	const out = await git(cwd, ['log', '--first-parent', '-n', String(limit), '--format=%H%x1f%s%x1f%an%x1f%ar%x1f%P']).catch(() => '');
	const commits = [];
	for (const line of out.split('\n').filter(Boolean)) {
		const [sha, subject, author, date, parents] = line.split('\x1f');
		if (parents.split(' ').length > 1) {
			break;
		}
		commits.push({ sha, subject, author, date });
	}
	return commits;
}

module.exports = { commitSubject, fixup, drop, squashInfo, squash, commitParents, revert, remotes, splitRemoteRef, branchUpstream, pushBranch, pushTag, fetchInto, inspect, reword, forcePush, resetTo, checkBranchName, renameBranch, mergeInfo, merge, rebaseInfo, rebase, abort, hasLocalChanges, resolveCommit, currentBranch, identity, repositoryRoot, listCommits, RewordError };
