var http = require('http');
var spawnSync = require('child_process').spawnSync;
var fs = require('fs');
var url = require('url');

var SRC = '/app/src/frontend';
var WORKDIR = '/app/workdir/frontend';
var WORKDIR_ROOT = '/app/workdir';
var PORT = 8081;

function json(res, data, status) {
    res.writeHead(status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function workdirExists() {
    try {
        fs.accessSync(WORKDIR, fs.constants.F_OK);
        return true;
    } catch (e) {
        return false;
    }
}

function activeSession() {
    try {
        return fs.readFileSync('/app/.active-session', 'utf8').trim();
    } catch (e) {
        return '';
    }
}

function getBaseCommit() {
    var session = activeSession();
    var basePath = session ? '/app/.branch-base-' + session : '/app/.branch-base';
    try {
        return fs.readFileSync(basePath, 'utf8').trim();
    } catch (e) {
        return null;
    }
}

function getChangedFiles() {
    if (!workdirExists()) return [];

    var base = getBaseCommit();
    if (base) {
        // Git diff against base commit — shows cumulative changes across all rounds
        var result = spawnSync('git', ['diff', '--name-status', base, '--', 'frontend/'], {
            cwd: WORKDIR_ROOT, encoding: 'utf8'
        });
        var out = result.stdout || '';
        var files = [];
        var statusMap = { 'A': 'added', 'D': 'deleted', 'M': 'modified', 'R': 'modified' };
        out.split('\n').forEach(function (line) {
            line = line.trim();
            if (!line) return;
            var parts = line.split('\t');
            if (parts.length < 2) return;
            var file = parts[parts.length - 1].replace(/^frontend\//, '');
            files.push({ file: file, status: statusMap[parts[0].charAt(0)] || 'modified' });
        });
        return files;
    }

    // Fallback: file-level diff
    var result = spawnSync('diff', ['-rq', SRC, WORKDIR], { encoding: 'utf8' });
    var out = (result.stdout || '') + (result.stderr || '');
    var files = [];
    out.split('\n').forEach(function (line) {
        line = line.trim();
        if (!line) return;
        var differMatch = line.match(/^Files\s+.*?\/frontend\/(\S+)\s+and\s+.*?\/frontend\/(\S+)\s+differ$/);
        if (differMatch) {
            files.push({ file: differMatch[1], status: 'modified' });
            return;
        }
        var onlyWorkdir = line.match(/^Only in \/app\/workdir\/frontend\/?(.*):\s+(.+)$/);
        if (onlyWorkdir) {
            var dir = onlyWorkdir[1] ? onlyWorkdir[1] + '/' : '';
            files.push({ file: dir + onlyWorkdir[2], status: 'added' });
            return;
        }
        var onlySrc = line.match(/^Only in \/app\/src\/frontend\/?(.*):\s+(.+)$/);
        if (onlySrc) {
            var dir2 = onlySrc[1] ? onlySrc[1] + '/' : '';
            files.push({ file: dir2 + onlySrc[2], status: 'deleted' });
        }
    });
    return files;
}

function getDiff(file) {
    if (!workdirExists()) return '';

    var base = getBaseCommit();
    if (base) {
        // Git diff against base — cumulative
        var result = spawnSync('git', ['diff', base, '--', 'frontend/' + file], {
            cwd: WORKDIR_ROOT, encoding: 'utf8'
        });
        return result.stdout || '';
    }

    // Fallback: file-level diff
    var srcFile = SRC + '/' + file;
    var workFile = WORKDIR + '/' + file;
    var result = spawnSync('diff', ['-uN', srcFile, workFile], { encoding: 'utf8' });
    return result.stdout || '';
}

function getAllDiffs() {
    var files = getChangedFiles();
    return files.map(function (f) {
        return { file: f.file, status: f.status, diff: getDiff(f.file) };
    });
}

function isCommitted() {
    if (!workdirExists()) return false;
    // Check if there are any commits on the feature branch beyond the branch point
    var result = spawnSync('git', ['log', '--oneline', '-1', '--format=%s'], {
        cwd: WORKDIR_ROOT, encoding: 'utf8'
    });
    var msg = (result.stdout || '').trim();
    // If the last commit message contains our commit marker, it's committed
    return msg.indexOf('[reviewed]') !== -1;
}

function commitAll(message) {
    if (!workdirExists()) return { ok: false, error: 'No worktree found' };

    // Stage all changes
    var addResult = spawnSync('git', ['add', '-A'], { cwd: WORKDIR_ROOT, encoding: 'utf8' });
    if (addResult.status !== 0) {
        return { ok: false, error: 'git add failed: ' + (addResult.stderr || '') };
    }

    // Check if there's anything to commit
    var statusResult = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: WORKDIR_ROOT });
    if (statusResult.status === 0) {
        return { ok: false, error: 'No changes to commit' };
    }

    // Commit with the message + marker
    var commitMsg = message + ' [reviewed]';
    var commitResult = spawnSync('git', ['commit', '-m', commitMsg], {
        cwd: WORKDIR_ROOT, encoding: 'utf8'
    });
    if (commitResult.status !== 0) {
        return { ok: false, error: 'git commit failed: ' + (commitResult.stderr || '') };
    }

    return { ok: true, message: commitMsg };
}

function runDeploy() {
    // Merges feature branch to main, removes worktree, rebuilds site
    var result = spawnSync('bash', ['/app/scripts/git-worktree.sh', 'deploy'], {
        cwd: '/app', encoding: 'utf8', timeout: 60000
    });
    var output = (result.stdout || '') + (result.stderr || '');
    if (result.status !== 0) {
        return { ok: false, error: 'deploy failed (exit ' + result.status + ')', output: output };
    }
    return { ok: true, output: output };
}

function runDiscard() {
    var result = spawnSync('bash', ['/app/scripts/git-worktree.sh', 'discard'], {
        cwd: '/app', encoding: 'utf8', timeout: 15000
    });
    var output = (result.stdout || '') + (result.stderr || '');
    return { ok: true, output: output };
}

function readBody(req, callback) {
    var body = '';
    req.on('data', function (chunk) { body += chunk; });
    req.on('end', function () { callback(body); });
}

var server = http.createServer(function (req, res) {
    var parsed = url.parse(req.url, true);
    var path = parsed.pathname;

    if (req.method === 'GET' && path === '/files') {
        json(res, getChangedFiles());
    } else if (req.method === 'GET' && path === '/diff') {
        var file = parsed.query.file;
        if (!file) return json(res, { error: 'file parameter required' }, 400);
        if (file.indexOf('..') !== -1) return json(res, { error: 'invalid path' }, 400);
        json(res, { file: file, diff: getDiff(file) });
    } else if (req.method === 'GET' && path === '/diff-all') {
        json(res, getAllDiffs());
    } else if (req.method === 'GET' && path === '/status') {
        json(res, { worktree: workdirExists(), committed: isCommitted() });
    } else if (req.method === 'POST' && path === '/deploy') {
        var result = runDeploy();
        json(res, result, result.ok ? 200 : 500);
    } else if (req.method === 'POST' && path === '/discard') {
        var result = runDiscard();
        json(res, result);
    } else if (req.method === 'POST' && path === '/activate') {
        readBody(req, function (body) {
            var data = {};
            try { data = JSON.parse(body); } catch (e) {}
            var session = data.session || '';
            if (!session) return json(res, { error: 'session required' }, 400);
            var result = spawnSync('bash', ['/app/scripts/git-worktree.sh', 'activate', session], {
                cwd: '/app', encoding: 'utf8', timeout: 5000
            });
            json(res, { ok: true, session: session, output: (result.stdout || '').trim() });
        });
    } else if (req.method === 'POST' && path === '/commit') {
        readBody(req, function (body) {
            var data = {};
            try { data = JSON.parse(body); } catch (e) {}
            var message = data.message || 'Dev agent changes';
            var result = commitAll(message);
            json(res, result, result.ok ? 200 : 400);
        });
    } else {
        json(res, { error: 'not found' }, 404);
    }
});

server.listen(PORT, '127.0.0.1', function () {
    console.log('[diff-api] Listening on 127.0.0.1:' + PORT);
});
