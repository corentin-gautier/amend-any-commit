// Exercises reword.js on throwaway repos: HEAD, middle, root, dirty tree, merges, pushed detection,
// force push, commit listing. Run with `npm test`.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { inspect, reword, forcePush, repositoryRoot, listCommits } = require('../reword.js');

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

	fs.rmSync(base, { recursive: true });
	console.log('all good');
})().catch(error => { console.error(error); process.exit(1); });
