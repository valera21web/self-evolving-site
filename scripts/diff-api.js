var http = require('http');
var spawnSync = require('child_process').spawnSync;
var fs = require('fs');
var url = require('url');

var SRC = '/app/src/frontend';
var SESSIONS_DIR = '/app/sessions';
var WORKDIR_SYMLINK = '/app/workdir';
var PORT = 8081;

function json(res, data, status) {
    res.writeHead(status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function activeSession() {
    try {
        return fs.readFileSync('/app/.active-session', 'utf8').trim();
    } catch (e) {
        return '';
    }
}

function sessionWorkdir(sessionId) {
    var sid = sessionId || activeSession();
    if (!sid) return '';
    return SESSIONS_DIR + '/' + sid;
}

function sessionFrontend(sessionId) {
    var root = sessionWorkdir(sessionId);
    return root ? root + '/frontend' : '';
}

function workdirExists(sessionId) {
    var dir = sessionFrontend(sessionId);
    if (!dir) return false;
    try {
        fs.accessSync(dir, fs.constants.F_OK);
        return true;
    } catch (e) {
        return false;
    }
}

function getBaseCommit(sessionId) {
    var root = sessionWorkdir(sessionId);
    if (!root) return null;
    var basePath = root + '/.branch-base';
    try {
        return fs.readFileSync(basePath, 'utf8').trim();
    } catch (e) {
        return null;
    }
}

function getChangedFiles(sessionId) {
    if (!workdirExists(sessionId)) return [];

    var root = sessionWorkdir(sessionId);
    var base = getBaseCommit(sessionId);
    if (base) {
        var result = spawnSync('git', ['diff', '--name-status', base, '--', 'frontend/'], {
            cwd: root, encoding: 'utf8'
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
    var frontend = sessionFrontend(sessionId);
    var result = spawnSync('diff', ['-rq', SRC, frontend], { encoding: 'utf8' });
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
        var onlyWorkdir = line.match(/^Only in .*?\/sessions\/[^/]+\/frontend\/?(.*):\s+(.+)$/);
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

function getDiff(file, sessionId) {
    if (!workdirExists(sessionId)) return '';

    var root = sessionWorkdir(sessionId);
    var base = getBaseCommit(sessionId);
    if (base) {
        var result = spawnSync('git', ['diff', base, '--', 'frontend/' + file], {
            cwd: root, encoding: 'utf8'
        });
        return result.stdout || '';
    }

    // Fallback: file-level diff
    var srcFile = SRC + '/' + file;
    var workFile = sessionFrontend(sessionId) + '/' + file;
    var result = spawnSync('diff', ['-uN', srcFile, workFile], { encoding: 'utf8' });
    return result.stdout || '';
}

function getAllDiffs(sessionId) {
    var files = getChangedFiles(sessionId);
    return files.map(function (f) {
        return { file: f.file, status: f.status, diff: getDiff(f.file, sessionId) };
    });
}

function isCommitted(sessionId) {
    if (!workdirExists(sessionId)) return false;
    var root = sessionWorkdir(sessionId);
    var result = spawnSync('git', ['log', '--oneline', '-1', '--format=%s'], {
        cwd: root, encoding: 'utf8'
    });
    var msg = (result.stdout || '').trim();
    return msg.indexOf('[reviewed]') !== -1;
}

function commitAll(message, sessionId) {
    var root = sessionWorkdir(sessionId);
    if (!root || !workdirExists(sessionId)) return { ok: false, error: 'No worktree found' };

    var addResult = spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8' });
    if (addResult.status !== 0) {
        return { ok: false, error: 'git add failed: ' + (addResult.stderr || '') };
    }

    var statusResult = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: root });
    if (statusResult.status === 0) {
        return { ok: false, error: 'No changes to commit' };
    }

    var commitMsg = message + ' [reviewed]';
    var commitResult = spawnSync('git', ['commit', '-m', commitMsg], {
        cwd: root, encoding: 'utf8'
    });
    if (commitResult.status !== 0) {
        return { ok: false, error: 'git commit failed: ' + (commitResult.stderr || '') };
    }

    return { ok: true, message: commitMsg };
}

function runDeploy() {
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
    return { ok: result.status === 0, output: output };
}

function runCreate(sessionId) {
    if (!sessionId) return { ok: false, error: 'session required' };
    var result = spawnSync('bash', ['/app/scripts/git-worktree.sh', 'create', sessionId], {
        cwd: '/app', encoding: 'utf8', timeout: 15000
    });
    var output = (result.stdout || '') + (result.stderr || '');
    if (result.status !== 0) {
        return { ok: false, error: 'create failed (exit ' + result.status + ')', output: output };
    }
    return { ok: true, session: sessionId, output: output };
}

function runDelete(sessionId) {
    if (!sessionId) return { ok: false, error: 'session required' };
    var result = spawnSync('bash', ['/app/scripts/git-worktree.sh', 'delete', sessionId], {
        cwd: '/app', encoding: 'utf8', timeout: 15000
    });
    var output = (result.stdout || '') + (result.stderr || '');
    if (result.status !== 0) {
        return { ok: false, error: 'delete failed (exit ' + result.status + ')', session: sessionId, output: output };
    }
    return { ok: true, session: sessionId, output: output };
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
    } else if (req.method === 'POST' && path === '/create') {
        readBody(req, function (body) {
            var data = {};
            try { data = JSON.parse(body); } catch (e) {}
            var session = data.session || '';
            if (!session) return json(res, { error: 'session required' }, 400);
            var result = runCreate(session);
            json(res, result, result.ok ? 200 : 500);
        });
    } else if (req.method === 'POST' && path === '/deploy') {
        var result = runDeploy();
        json(res, result, result.ok ? 200 : 500);
    } else if (req.method === 'POST' && path === '/discard') {
        var result = runDiscard();
        json(res, result);
    } else if (req.method === 'POST' && path === '/delete') {
        readBody(req, function (body) {
            var data = {};
            try { data = JSON.parse(body); } catch (e) {}
            var session = data.session || '';
            if (!session) return json(res, { error: 'session required' }, 400);
            var result = runDelete(session);
            json(res, result);
        });
    } else if (req.method === 'POST' && path === '/activate') {
        readBody(req, function (body) {
            var data = {};
            try { data = JSON.parse(body); } catch (e) {}
            var session = data.session || '';
            if (!session) return json(res, { error: 'session required' }, 400);

            // If create flag is set and worktree doesn't exist, create it first
            if (data.create) {
                var sdir = SESSIONS_DIR + '/' + session;
                var exists = false;
                try { fs.accessSync(sdir, fs.constants.F_OK); exists = true; } catch (e) {}
                if (!exists) {
                    var createResult = runCreate(session);
                    if (!createResult.ok) {
                        return json(res, { ok: false, error: 'create failed: ' + (createResult.error || ''), output: createResult.output }, 500);
                    }
                }
            }

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
