// Exercises reword.js on throwaway repos: HEAD, middle, root, dirty tree, merges, pushed detection,
// author edits, force push, commit listing. Run with `npm test`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { inspect, reword, forcePush, resetTo, hasLocalChanges, currentBranch, identity, repositoryRoot, listCommits } = require('../reword.js');

const base = fs.mkdtempSync(path.join(require('os').tmpdir(), 'amend-any-commit-'));
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

	fs.rmSync(base, { recursive: true });
	console.log('all good');
})().catch(error => { console.error(error); process.exit(1); });
