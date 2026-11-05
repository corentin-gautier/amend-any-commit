const { execFile } = require('child_process');

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
async function inspect(cwd, commit) {
	const sha = await git(cwd, ['rev-parse', '--verify', `${commit}^{commit}`]);
	const head = await git(cwd, ['rev-parse', 'HEAD']);
	if (!await succeeds(cwd, ['merge-base', '--is-ancestor', sha, head])) {
		throw new RewordError('notInHead');
	}
	const gitDir = await git(cwd, ['rev-parse', '--absolute-git-dir']);
	const fs = require('fs');
	if (['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'].some(name => fs.existsSync(`${gitDir}/${name}`))) {
		throw new RewordError('operationInProgress');
	}
	// Untracked files are fine: the rebase replays the same trees, so it never writes over them.
	if (await git(cwd, ['status', '--porcelain', '--untracked-files=no']) !== '') {
		throw new RewordError('dirty');
	}
	const parents = (await git(cwd, ['rev-list', '--parents', '-n', '1', sha])).split(' ').slice(1);
	// A plain rebase would flatten merges, so the commit and everything after it must be linear.
	if (parents.length > 1 || await git(cwd, ['rev-list', '--merges', `${sha}..${head}`]) !== '') {
		throw new RewordError('merges');
	}
	const message = await git(cwd, ['log', '-1', '--format=%B', sha]);
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
	return { sha, head, parents, message, pushed, upstream };
}

// Pushes the rewritten branch, but only if the remote still points where it did before the reword,
// so commits someone else pushed in between are never lost.
async function forcePush(cwd, info) {
	const { remote, ref, sha } = info.upstream;
	await git(cwd, ['push', '--porcelain', `--force-with-lease=${ref}:${sha}`, remote, `HEAD:${ref}`]);
}

// Replaces the message of `info.sha` (from inspect) and replays the commits after it.
async function reword(cwd, info, message) {
	const { sha, head, parents } = info;
	// The new commit keeps the tree, parents and author of the old one; only the message changes.
	const author = await git(cwd, ['log', '-1', '--format=%an%x00%ae%x00%ad', '--date=raw', sha]);
	const [name, email, date] = author.split('\0');
	const args = ['commit-tree', `${sha}^{tree}`, ...parents.flatMap(parent => ['-p', parent]), '-F', '-'];
	const rewritten = await git(cwd, args, {
		input: message.endsWith('\n') ? message : `${message}\n`,
		env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date },
	});
	if (sha === head) {
		await git(cwd, ['update-ref', '-m', 'reword: change commit message', 'HEAD', rewritten, head]);
	} else {
		// Same tree as the old commit, so replaying the later commits onto it cannot conflict.
		await git(cwd, ['rebase', '--no-autosquash', '--reapply-cherry-picks', '--onto', rewritten, sha], {
			env: { GIT_REFLOG_ACTION: 'reword' },
		});
	}
	return rewritten;
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

module.exports = { inspect, reword, forcePush, repositoryRoot, listCommits, RewordError };
