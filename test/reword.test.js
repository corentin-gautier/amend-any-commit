// Exercises reword.js on throwaway repos: HEAD, middle, root, dirty tree, merges, pushed detection,
// author edits, force push, commit listing. Run with `npm test`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { fixup, drop, squashInfo, squash, commitParents, revert, splitRemoteRef, branchUpstream, pushBranch, pushTag, fetchInto, inspect, reword, forcePush, resetTo, checkBranchName, renameBranch, mergeInfo, merge, rebaseInfo, rebase, abort, hasLocalChanges, currentBranch, identity, repositoryRoot, listCommits } = require('../reword.js');

const base = fs.mkdtempSync(path.join(require('os').tmpdir(), 'source-control-graph-plus-'));
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function repo(name) {
	const dir = path.join(base, name);
	fs.mkdirSync(dir);
	sh(dir, 'init', '-q', '-b', 'main');
	sh(dir, 'config', 'user.name', 'Test');
	sh(dir, 'config', 'user.email', 't@example.com');
	for (const n of [1, 2, 3]) {
		fs.writeFileSync(path.join(dir, `f${n}`), `${n}\n`);
		sh(dir, 'add', '.');
		sh(dir, 'commit', '-q', '-m', `commit ${n}`, '-m', `body ${n}`, '--date', `2020-01-0${n}T10:00:00`);
	}
	return dir;
}
const subjects = dir => sh(dir, 'log', '--format=%s').split('\n');

(async () => {
	// HEAD
	let dir = repo('head');
	let info = await inspect(dir, 'HEAD');
	await reword(dir, info, 'new 3\n\nbody 3');
	assert.deepStrictEqual(subjects(dir), ['new 3', 'commit 2', 'commit 1']);
	assert.strictEqual(sh(dir, 'log', '-1', '--format=%B'), 'new 3\n\nbody 3');

	// Middle commit, untracked file present, author date kept
	dir = repo('middle');
	fs.writeFileSync(path.join(dir, 'untracked'), 'x');
	const tree = sh(dir, 'rev-parse', 'HEAD^{tree}');
	info = await inspect(dir, 'HEAD~1');
	await reword(dir, info, 'new 2\n\nbody 2');
	assert.deepStrictEqual(subjects(dir), ['commit 3', 'new 2', 'commit 1']);
	assert.strictEqual(sh(dir, 'rev-parse', 'HEAD^{tree}'), tree);
	assert.strictEqual(sh(dir, 'log', '-1', '--format=%ad', '--date=short', 'HEAD~1'), '2020-01-02');
	assert.strictEqual(sh(dir, 'log', '-1', '--format=%B', 'HEAD'), 'commit 3\n\nbody 3');
	assert.strictEqual(sh(dir, 'branch', '--show-current'), 'main');

	// Root commit
	dir = repo('root');
	info = await inspect(dir, 'HEAD~2');
	await reword(dir, info, 'new 1');
	assert.deepStrictEqual(subjects(dir), ['commit 3', 'commit 2', 'new 1']);

	// Author and date changed, later commits keep theirs
	dir = repo('author');
	info = await inspect(dir, 'HEAD~1');
	assert.deepStrictEqual([info.author.name, info.author.email], ['Test', 't@example.com']);
	assert.match(info.author.isoDate, /^2020-01-02 10:00:00 [+-]\d{4}$/);
	await reword(dir, info, 'commit 2\n\nnew body', { name: 'Someone', email: 's@example.com', date: '2021-05-06 07:08:09 +0200' });
	assert.strictEqual(sh(dir, 'log', '-1', '--format=%an <%ae> %ai%n%B', 'HEAD~1'), 'Someone <s@example.com> 2021-05-06 07:08:09 +0200\ncommit 2\n\nnew body');
	assert.strictEqual(sh(dir, 'log', '-1', '--format=%an %ad', '--date=short', 'HEAD'), 'Test 2020-01-03');
	assert.deepStrictEqual(await identity(dir), { name: 'Test', email: 't@example.com' });

	// Dirty tree refused
	dir = repo('dirty');
	fs.writeFileSync(path.join(dir, 'f1'), 'changed');
	await assert.rejects(inspect(dir, 'HEAD~1'), { code: 'dirty' });

	// Merge after the commit refused
	dir = repo('merge');
	sh(dir, 'checkout', '-q', '-b', 'side', 'HEAD~1');
	fs.writeFileSync(path.join(dir, 'side'), 's');
	sh(dir, 'add', '.');
	sh(dir, 'commit', '-q', '-m', 'side');
	sh(dir, 'checkout', '-q', 'main');
	sh(dir, 'merge', '-q', '--no-edit', 'side');
	await assert.rejects(inspect(dir, 'HEAD~2'), { code: 'merges' });

	// Listing stops at the first merge; the root finds the repository from a subfolder
	fs.writeFileSync(path.join(dir, 'f9'), '9');
	sh(dir, 'add', '.');
	sh(dir, 'commit', '-q', '-m', 'after merge');
	assert.deepStrictEqual((await listCommits(dir)).map(c => c.subject), ['after merge']);
	assert.deepStrictEqual((await listCommits(repo('list'))).map(c => c.subject), ['commit 3', 'commit 2', 'commit 1']);
	fs.mkdirSync(path.join(dir, 'sub'));
	assert.strictEqual(fs.realpathSync(await repositoryRoot(path.join(dir, 'sub'))), fs.realpathSync(dir));

	// Pushed detection
	dir = repo('pushed');
	const remote = path.join(base, 'remote.git');
	sh(base, 'init', '-q', '--bare', '-b', 'main', remote);
	sh(dir, 'remote', 'add', 'origin', remote);
	sh(dir, 'push', '-q', '-u', 'origin', 'main');
	fs.writeFileSync(path.join(dir, 'f4'), '4');
	sh(dir, 'add', '.');
	sh(dir, 'commit', '-q', '-m', 'commit 4');
	assert.strictEqual((await inspect(dir, 'HEAD')).pushed, false);
	assert.strictEqual((await inspect(dir, 'HEAD~1')).pushed, true);

	// Force push rewrites the remote
	info = await inspect(dir, 'HEAD~1');
	await reword(dir, info, 'new 3');
	await forcePush(dir, info);
	assert.strictEqual(sh(remote, 'log', '-2', '--format=%s', 'main'), 'commit 4\nnew 3');
	assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), sh(dir, 'rev-parse', 'origin/main'));

	// Force push refused when someone else pushed in between
	const other = path.join(base, 'other');
	sh(base, 'clone', '-q', remote, other);
	sh(other, 'config', 'user.name', 'Other');
	sh(other, 'config', 'user.email', 'o@example.com');
	fs.writeFileSync(path.join(other, 'f5'), '5');
	sh(other, 'add', '.');
	sh(other, 'commit', '-q', '-m', 'from someone else');
	sh(other, 'push', '-q');
	info = await inspect(dir, 'HEAD~1');
	await reword(dir, info, 'new 3 again');
	await assert.rejects(forcePush(dir, info));
	assert.strictEqual(sh(remote, 'log', '-1', '--format=%s', 'main'), 'from someone else');

	// Reset: soft keeps the changes staged, mixed unstaged, hard drops them
	const status = dir => sh(dir, 'status', '--porcelain', '--untracked-files=no');
	dir = repo('reset-soft');
	assert.strictEqual(await currentBranch(dir), 'main');
	await resetTo(dir, 'HEAD~2', 'soft');
	assert.deepStrictEqual(subjects(dir), ['commit 1']);
	assert.strictEqual(status(dir), 'A  f2\nA  f3');
	assert.strictEqual(sh(dir, 'branch', '--show-current'), 'main');
	dir = repo('reset-mixed');
	await resetTo(dir, 'HEAD~1', 'mixed');
	assert.deepStrictEqual(subjects(dir), ['commit 2', 'commit 1']);
	assert.strictEqual(sh(dir, 'status', '--porcelain'), '?? f3');
	dir = repo('reset-hard');
	fs.writeFileSync(path.join(dir, 'f1'), 'changed\n');
	assert.strictEqual(await hasLocalChanges(dir), true);
	const target = sh(dir, 'rev-parse', 'HEAD~1');
	assert.strictEqual(await resetTo(dir, target, 'hard'), target);
	assert.strictEqual(await hasLocalChanges(dir), false);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'f1'), 'utf8'), '1\n');
	assert.ok(!fs.existsSync(path.join(dir, 'f3')));
	// Forward, to a commit the branch no longer has
	await resetTo(dir, 'HEAD@{1}', 'hard');
	assert.deepStrictEqual(subjects(dir), ['commit 3', 'commit 2', 'commit 1']);
	await assert.rejects(resetTo(dir, 'HEAD', 'keep'));
	await assert.rejects(resetTo(dir, 'nope', 'mixed'));
	sh(dir, 'checkout', '-q', '--detach');
	assert.strictEqual(await currentBranch(dir), undefined);

	// Merge and rebase: a `side` branch off commit 2 with one commit, main has commit 3.
	const forked = (name, file = 'side') => {
		const dir = repo(name);
		sh(dir, 'checkout', '-q', '-b', 'side', 'HEAD~1');
		fs.writeFileSync(path.join(dir, file), 'side\n');
		sh(dir, 'add', '.');
		sh(dir, 'commit', '-q', '-m', 'side');
		sh(dir, 'checkout', '-q', 'main');
		return dir;
	};
	dir = forked('merge-noff');
	let merged = await mergeInfo(dir, sh(dir, 'rev-parse', 'side'));
	assert.deepStrictEqual([merged.target, merged.upToDate, merged.canFastForward], ['side', false, false]);
	await merge(dir, merged.target, 'noff');
	assert.strictEqual(sh(dir, 'log', '-1', '--format=%s'), "Merge branch 'side'");
	assert.strictEqual((await mergeInfo(dir, 'side')).upToDate, true);
	// Fast-forward, and a commit no branch points at is merged by its hash
	dir = repo('merge-ff');
	sh(dir, 'checkout', '-q', '-b', 'old', 'HEAD~2');
	const tip = sh(dir, 'rev-parse', 'main~1');
	merged = await mergeInfo(dir, tip);
	assert.deepStrictEqual([merged.target, merged.canFastForward], [tip, true]);
	await merge(dir, merged.target, 'ff');
	assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), tip);
	await assert.rejects(merge(dir, 'main', 'octopus'));
	// Squash stages, does not commit
	dir = forked('merge-squash');
	await merge(dir, 'side', 'squash');
	assert.deepStrictEqual(subjects(dir), ['commit 3', 'commit 2', 'commit 1']);
	assert.strictEqual(status(dir), 'A  side');
	// Conflicts, then abort
	dir = forked('merge-conflict', 'f3');
	await assert.rejects(merge(dir, 'side', 'noff'), { code: 'conflicts' });
	await assert.rejects(merge(dir, 'side', 'noff'), { code: 'operationInProgress' });
	await abort(dir, 'merge');
	assert.strictEqual(status(dir), '');
	await assert.rejects(merge(dir, 'side', 'squash'), { code: 'conflicts' });
	await abort(dir, 'merge');
	assert.strictEqual(status(dir), '');

	// Rebase main on side
	dir = forked('rebase');
	let based = await rebaseInfo(dir, 'side');
	assert.deepStrictEqual([based.count, based.upToDate, based.pushed], [1, false, false]);
	await rebase(dir, 'side');
	assert.deepStrictEqual(subjects(dir), ['commit 3', 'side', 'commit 2', 'commit 1']);
	assert.strictEqual(sh(dir, 'branch', '--show-current'), 'main');
	assert.strictEqual((await rebaseInfo(dir, 'side')).upToDate, true);
	// Pushed commits are detected
	dir = forked('rebase-pushed');
	const remote2 = path.join(base, 'remote2.git');
	sh(base, 'init', '-q', '--bare', '-b', 'main', remote2);
	sh(dir, 'remote', 'add', 'origin', remote2);
	sh(dir, 'push', '-q', '-u', 'origin', 'main');
	assert.strictEqual((await rebaseInfo(dir, 'side')).pushed, true);
	// Dirty tree refused; conflicts leave the rebase in progress, abort puts it back
	dir = forked('rebase-conflict', 'f3');
	fs.writeFileSync(path.join(dir, 'f1'), 'changed\n');
	await assert.rejects(rebase(dir, 'side'), { code: 'dirty' });
	sh(dir, 'checkout', '-q', '--', 'f1');
	const before = sh(dir, 'rev-parse', 'HEAD');
	await assert.rejects(rebase(dir, 'side'), { code: 'conflicts' });
	await abort(dir, 'rebase');
	assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), before);
	assert.strictEqual(sh(dir, 'branch', '--show-current'), 'main');

	// Rename a branch, the current one too; bad or taken names refused
	dir = forked('rename');
	await renameBranch(dir, 'side', 'feature/x');
	assert.strictEqual(sh(dir, 'branch', '--format=%(refname:short)'), 'feature/x\nmain');
	await renameBranch(dir, 'main', 'trunk');
	assert.strictEqual(sh(dir, 'branch', '--show-current'), 'trunk');
	assert.strictEqual(await checkBranchName(dir, 'new'), undefined);
	assert.strictEqual(await checkBranchName(dir, 'bad..name'), 'invalidName');
	assert.strictEqual(await checkBranchName(dir, '-x'), 'invalidName');
	await assert.rejects(renameBranch(dir, 'trunk', 'feature/x'), { code: 'branchExists' });

	// Fixup: staged changes folded into an older commit, unstaged ones kept aside
	const show = (dir, rev, file) => sh(dir, 'show', `${rev}:${file}`);
	dir = repo('fixup');
	fs.writeFileSync(path.join(dir, 'f2'), 'fixed\n');
	sh(dir, 'add', 'f2');
	fs.writeFileSync(path.join(dir, 'f1'), 'unstaged\n');
	await assert.rejects(inspect(dir, 'HEAD~1'), { code: 'dirty' });
	await fixup(dir, await inspect(dir, 'HEAD~1', { allowDirty: true }));
	assert.deepStrictEqual(subjects(dir), ['commit 3', 'commit 2', 'commit 1']);
	assert.strictEqual(show(dir, 'HEAD~1', 'f2'), 'fixed');
	assert.strictEqual(sh(dir, 'log', '-1', '--format=%B', 'HEAD~1'), 'commit 2\n\nbody 2');
	assert.strictEqual(status(dir), 'M f1');
	assert.strictEqual(fs.readFileSync(path.join(dir, 'f1'), 'utf8'), 'unstaged\n');
	await assert.rejects(fixup(dir, await inspect(dir, 'HEAD~1', { allowDirty: true })), { code: 'nothingStaged' });
	// On HEAD and on the root commit
	fs.writeFileSync(path.join(dir, 'f3'), 'fixed\n');
	sh(dir, 'add', 'f3');
	await fixup(dir, await inspect(dir, 'HEAD', { allowDirty: true }));
	assert.strictEqual(show(dir, 'HEAD', 'f3'), 'fixed');
	sh(dir, 'add', 'f1');
	await fixup(dir, await inspect(dir, 'HEAD~2', { allowDirty: true }));
	assert.deepStrictEqual(subjects(dir), ['commit 3', 'commit 2', 'commit 1']);
	assert.strictEqual(show(dir, 'HEAD~2', 'f1'), 'unstaged');
	assert.strictEqual(status(dir), '');
	// Conflict with a later commit; abort gives back the staged change
	dir = repo('fixup-conflict');
	fs.writeFileSync(path.join(dir, 'f3'), 'then\n');
	sh(dir, 'commit', '-q', '-am', 'commit 4');
	fs.writeFileSync(path.join(dir, 'f3'), 'now\n');
	sh(dir, 'add', 'f3');
	let head = sh(dir, 'rev-parse', 'HEAD');
	await assert.rejects(fixup(dir, await inspect(dir, 'HEAD~2', { allowDirty: true })), { code: 'conflicts' });
	await abort(dir, 'rebase', head);
	assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), head);
	assert.strictEqual(status(dir), 'M  f3');

	// Drop a middle commit; the root is refused
	dir = repo('drop');
	await drop(dir, await inspect(dir, 'HEAD~1'));
	assert.deepStrictEqual(subjects(dir), ['commit 3', 'commit 1']);
	assert.ok(!fs.existsSync(path.join(dir, 'f2')));
	await drop(dir, await inspect(dir, 'HEAD'));
	assert.deepStrictEqual(subjects(dir), ['commit 1']);
	await assert.rejects(drop(dir, await inspect(dir, 'HEAD')), { code: 'root' });
	dir = repo('drop-conflict');
	fs.writeFileSync(path.join(dir, 'f2'), 'again\n');
	sh(dir, 'commit', '-q', '-am', 'commit 4');
	head = sh(dir, 'rev-parse', 'HEAD');
	await assert.rejects(drop(dir, await inspect(dir, 'HEAD~2')), { code: 'conflicts' });
	await abort(dir, 'rebase');
	assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), head);

	// Squash from a commit to HEAD, local changes untouched
	dir = repo('squash');
	fs.writeFileSync(path.join(dir, 'f1'), 'local\n');
	info = await inspect(dir, 'HEAD~1', { allowDirty: true });
	const squashed = await squashInfo(dir, info);
	assert.deepStrictEqual(squashed, { count: 2, message: 'commit 2\n\nbody 2\n\ncommit 3\n\nbody 3' });
	const headTree = sh(dir, 'rev-parse', 'HEAD^{tree}');
	await squash(dir, info, 'two and three');
	assert.deepStrictEqual(subjects(dir), ['two and three', 'commit 1']);
	assert.strictEqual(sh(dir, 'rev-parse', 'HEAD^{tree}'), headTree);
	assert.strictEqual(sh(dir, 'log', '-1', '--format=%ad', '--date=short'), '2020-01-02');
	assert.strictEqual(status(dir), 'M f1');
	assert.strictEqual((await squashInfo(dir, await inspect(dir, 'HEAD~1', { allowDirty: true }))).count, 2);
	await squash(dir, await inspect(dir, 'HEAD~1', { allowDirty: true }), 'all');
	assert.deepStrictEqual(subjects(dir), ['all']);

	// Revert, a merge with its mainline, and a conflict aborted
	dir = repo('revert');
	await revert(dir, 'HEAD~1');
	assert.strictEqual(sh(dir, 'log', '-1', '--format=%s'), 'Revert "commit 2"');
	assert.ok(!fs.existsSync(path.join(dir, 'f2')));
	dir = forked('revert-merge');
	sh(dir, 'merge', '-q', '--no-edit', 'side');
	assert.deepStrictEqual((await commitParents(dir, 'HEAD')).map(p => p.subject), ['commit 3', 'side']);
	await revert(dir, 'HEAD', 1);
	assert.ok(!fs.existsSync(path.join(dir, 'side')));
	dir = repo('revert-conflict');
	fs.writeFileSync(path.join(dir, 'f2'), 'again\n');
	sh(dir, 'commit', '-q', '-am', 'commit 4');
	head = sh(dir, 'rev-parse', 'HEAD');
	await assert.rejects(revert(dir, 'HEAD~2'), { code: 'conflicts' });
	await assert.rejects(revert(dir, 'HEAD~2'), { code: 'operationInProgress' });
	await abort(dir, 'revert');
	assert.strictEqual(sh(dir, 'rev-parse', 'HEAD'), head);
	assert.strictEqual(status(dir), '');

	// Push a new branch (sets the upstream), then force push it; push a tag; fetch into a local branch
	const remote3 = path.join(base, 'remote3.git');
	sh(base, 'init', '-q', '--bare', '-b', 'main', remote3);
	dir = forked('push');
	sh(dir, 'remote', 'add', 'my/origin', remote3);
	await pushBranch(dir, 'side', { remote: 'my/origin' });
	assert.deepStrictEqual(await branchUpstream(dir, 'side'), { remote: 'my/origin', ref: 'refs/heads/side' });
	assert.strictEqual(sh(remote3, 'rev-parse', 'side'), sh(dir, 'rev-parse', 'side'));
	sh(dir, 'branch', '-f', 'side', 'main');
	await assert.rejects(pushBranch(dir, 'side'));
	await pushBranch(dir, 'side', { force: true });
	assert.strictEqual(sh(remote3, 'rev-parse', 'side'), sh(dir, 'rev-parse', 'main'));
	sh(dir, 'tag', 'v1', 'HEAD~1');
	await pushTag(dir, 'v1', 'my/origin');
	assert.strictEqual(sh(remote3, 'rev-parse', 'v1'), sh(dir, 'rev-parse', 'HEAD~1'));
	assert.deepStrictEqual(await splitRemoteRef(dir, 'refs/remotes/my/origin/side'), { remote: 'my/origin', branch: 'side' });
	assert.strictEqual(await splitRemoteRef(dir, 'refs/remotes/nope/side'), undefined);
	await fetchInto(dir, 'my/origin', 'side', 'copy');
	assert.strictEqual(sh(dir, 'rev-parse', 'copy'), sh(dir, 'rev-parse', 'main'));
	await assert.rejects(fetchInto(dir, 'my/origin', 'side', 'main'), { code: 'currentBranch' });
	await assert.rejects(fetchInto(dir, 'my/origin', 'side', 'bad..name'), { code: 'invalidName' });

	fs.rmSync(base, { recursive: true });
	console.log('all good');
})().catch(error => { console.error(error); process.exit(1); });
