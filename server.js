#!/usr/bin/env node
'use strict';

/**
 * gitdeck — 面向「分支清理 / 差异阅读 / AI 解释」的本地 Git 工作台
 * 零依赖：仅使用 Node 标准库 + 系统 git + 本地 codex CLI
 */

const http = require('http');
const { execFile, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { URL } = require('url');

const PORT = Number(process.env.GITDECK_PORT || 7317);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_PATH = path.join(os.homedir(), '.gitdeck.json');

const MAX_DIFF = 800 * 1024;

/* ------------------------------------------------------------------ */
/* 通用工具                                                            */
/* ------------------------------------------------------------------ */

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fail(res, message, code = 400) {
  json(res, { ok: false, error: String(message || 'unknown error') }, code);
}

const IS_WIN = process.platform === 'win32';

/** 解析外部命令：环境变量 > PATH > 常见安装位置 */
function resolveBin(name, candidates) {
  const override = process.env['GITDECK_' + name.toUpperCase()];
  if (override && fs.existsSync(override)) return override;
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', [name], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    const first = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch (_) {}
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return name;
}

const GIT_BIN = resolveBin('git', [
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe') : '',
  '/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git',
]);

const CODEX_BIN = resolveBin('codex', [
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd'),
  path.join(os.homedir(), '.local', 'bin', 'codex'),
  '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
]);

const GIT_PREFIX = ['-c', 'core.quotepath=false', '-c', 'color.ui=never', '-c', 'log.showSignature=false'];

function git(repo, args, opts = {}) {
  return new Promise((resolve) => {
    const full = repo ? GIT_PREFIX.concat(['-C', repo], args) : GIT_PREFIX.concat(args);
    execFile(
      GIT_BIN,
      full,
      {
        maxBuffer: 128 * 1024 * 1024,
        encoding: 'utf8',
        timeout: opts.timeout || 45000,
        env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }),
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout || '',
          stderr: (stderr || '') + (err && !stderr ? err.message : ''),
          code: err ? err.code : 0,
        });
      }
    );
  });
}

async function gitOrThrow(repo, args, opts) {
  const r = await git(repo, args, opts);
  if (!r.ok) throw new Error(cleanGitErr(r.stderr) || 'git 命令失败');
  return r.stdout;
}

function cleanGitErr(s) {
  return String(s || '')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('hint:'))
    .slice(0, 4)
    .join(' ')
    .trim();
}

function cap(text, limit = MAX_DIFF) {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true, total: text.length };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 8 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* 配置：仓库根目录                                                    */
/* ------------------------------------------------------------------ */

const DEFAULT_ROOTS = ['code', 'Projects', 'Documents/GitHub', 'dev', 'workspace', 'git', 'repos'];

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {}
  const roots = Array.isArray(cfg.roots) ? cfg.roots.filter((r) => typeof r === 'string') : [];
  if (!roots.length) {
    for (const r of DEFAULT_ROOTS) {
      const p = path.join(os.homedir(), r);
      if (fs.existsSync(p)) roots.push(p);
    }
    if (!roots.length) roots.push(os.homedir());
  }
  const pins = Array.isArray(cfg.pins) ? cfg.pins.filter((x) => typeof x === 'string') : [];
  return { roots, pins, lastRepo: cfg.lastRepo || null, hidden: cfg.hidden || [] };
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (_) {}
}


/* ------------------------------------------------------------------ */
/* 原生目录选择框                                                      */
/* ------------------------------------------------------------------ */

function pickDirectory() {
  return new Promise((resolve) => {
    const done = (r) => resolve(r);

    if (process.platform === 'darwin') {
      const script = 'POSIX path of (choose folder with prompt "选择代码根目录或 Git 仓库")';
      execFile('osascript', ['-e', script], { timeout: 300000 }, (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || '') + String(err.message || '');
          if (/User canceled|-128/i.test(msg)) return done({ canceled: true });
          return done({ error: '无法打开目录选择框：' + cleanGitErr(msg) });
        }
        const dir = String(stdout || '').trim().replace(/\/+$/, '');
        done(dir ? { path: dir } : { canceled: true });
      });
      return;
    }

    if (IS_WIN) {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null;',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
        "$d.Description = '选择代码根目录或 Git 仓库';",
        '$d.ShowNewFolderButton = $true;',
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath } else { Write-Output '' }",
      ].join(' ');
      const tries = [['powershell.exe', ['-NoProfile', '-STA', '-Command', ps]], ['pwsh', ['-NoProfile', '-Command', ps]]];
      const attempt = (i) => {
        if (i >= tries.length) return done({ error: '无法打开目录选择框，请手动输入路径' });
        const [cmd, args] = tries[i];
        execFile(cmd, args, { timeout: 300000, windowsHide: false }, (err, stdout) => {
          if (err && err.code === 'ENOENT') return attempt(i + 1);
          if (err) return done({ error: '无法打开目录选择框，请手动输入路径' });
          const dir = String(stdout || '').trim().replace(/\\+$/, '');
          done(dir ? { path: dir } : { canceled: true });
        });
      };
      attempt(0);
      return;
    }

    execFile('zenity', ['--file-selection', '--directory', '--title=选择代码根目录或 Git 仓库'], { timeout: 300000 }, (err, stdout) => {
      if (err) {
        if (err.code === 'ENOENT') return done({ error: '没有找到 zenity，请手动输入路径' });
        return done({ canceled: true });
      }
      const dir = String(stdout || '').trim().replace(/\/+$/, '');
      done(dir ? { path: dir } : { canceled: true });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 仓库发现                                                            */
/* ------------------------------------------------------------------ */

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'Library', '.Trash', '.cache', 'dist', 'build', '.next',
  'Pods', 'venv', '.venv', '__pycache__', '.idea', 'target', '.gradle', 'vendor',
  'Applications', 'Pictures', 'Music', 'Movies', 'Downloads',
  'AppData', 'Application Data', 'OneDrive', 'python', 'Python', 'anaconda3', 'miniconda3',
]);

let scanCache = { at: 0, key: '', repos: [] };

async function scanRoots(roots) {
  const key = roots.join('|');
  if (scanCache.key === key && Date.now() - scanCache.at < 20000) return scanCache.repos;
  const found = [];
  const seen = new Set();

  async function walk(dir, depth) {
    if (depth > 3 || found.length > 300) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    const hasGit = entries.some((e) => e.name === '.git');
    if (hasGit) {
      const real = dir;
      if (!seen.has(real)) {
        seen.add(real);
        found.push(real);
      }
      return; // 不在仓库内部继续下钻
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  }

  for (const r of roots) await walk(r, 1);

  const repos = await mapLimit(found, 6, repoMeta);

  repos.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  scanCache = { at: Date.now(), key, repos };
  return repos;
}

async function repoMeta(dir) {
  const r = await git(dir, ['log', '-1', '--date=iso-strict', '--format=%H%x00%h%x00%cI%x00%an%x00%s'], { timeout: 8000 });
  const br = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 8000 });
  const head = r.ok ? r.stdout.split('\x00') : [];
  return {
    path: dir,
    name: path.basename(dir),
    parent: path.basename(path.dirname(dir)),
    branch: (br.stdout || '').trim() || '—',
    sha: head[1] || '',
    date: head[2] || '',
    author: head[3] || '',
    subject: (head[4] || '').trim(),
    empty: !r.ok,
    pinned: false,
  };
}

async function resolveRepo(p) {
  if (!p) throw new Error('缺少仓库路径');
  const abs = path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()));
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error('目录不存在: ' + abs);
  const top = await git(abs, ['rev-parse', '--show-toplevel'], { timeout: 8000 });
  if (!top.ok) throw new Error('不是 Git 仓库: ' + abs);
  return top.stdout.trim();
}

/* ------------------------------------------------------------------ */
/* 分支                                                                */
/* ------------------------------------------------------------------ */

const BR_FMT = [
  '%(refname:short)', '%(objectname:short)', '%(committerdate:iso-strict)',
  '%(authorname)', '%(authoremail)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(subject)',
  '%(refname)', '%(symref)',
].join('%00');

const C_FMT = '%H%x00%h%x00%cI%x00%an%x00%ae%x00%s%x00%P%x00%D';
const LOG_ARGS = ['--format=' + C_FMT];

function parseCommits(out) {
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const f = line.split('\x00');
    if (f.length < 8) continue;
    const refs = f[7] ? f[7].split(', ').map((s) => s.trim()).filter(Boolean) : [];
    rows.push({
      sha: f[0], short: f[1], date: f[2], author: f[3], email: f[4],
      subject: f[5], parents: f[6] ? f[6].split(' ').filter(Boolean) : [], refs,
      isMerge: f[6] ? f[6].split(' ').filter(Boolean).length > 1 : false,
    });
  }
  return rows;
}

async function currentBranch(repo) {
  const r = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 8000 });
  return (r.stdout || '').trim();
}

async function refExists(repo, ref) {
  const r = await git(repo, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'], { timeout: 8000 });
  return r.ok;
}

async function detectBase(repo) {
  const sym = await git(repo, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { timeout: 8000 });
  const remoteBase = (sym.stdout || '').trim();
  if (remoteBase) {
    const local = remoteBase.replace(/^[^/]+\//, '');
    if (await refExists(repo, local)) return local;
    if (await refExists(repo, remoteBase)) return remoteBase;
  }
  for (const c of ['main', 'master', 'develop', 'dev', 'trunk']) {
    if (await refExists(repo, c)) return c;
  }
  const cur = await currentBranch(repo);
  return cur && cur !== 'HEAD' ? cur : 'HEAD';
}

const PROTECTED = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'release']);

async function listRemotes(repo) {
  const r = await git(repo, ['remote'], { timeout: 8000 });
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

async function branchReport(repo, baseOverride) {
  const base = baseOverride || (await detectBase(repo));
  const cur = await currentBranch(repo);
  const remotes = await listRemotes(repo);

  const refOut = await gitOrThrow(repo, ['for-each-ref', '--sort=-committerdate', '--format=' + BR_FMT, 'refs/heads', 'refs/remotes']);

  const raw = [];
  for (const line of refOut.split('\n')) {
    if (!line) continue;
    const f = line.split('\x00');
    if (f.length < 8) continue;
    const name = f[0];
    if (f[9]) continue; // 跳过 origin/HEAD 这类符号引用
    if (/\/HEAD$/.test(name)) continue;
    const isRemote = /^[^/]+\//.test(name) && remotes.some((r) => name.startsWith(r + '/'));
    raw.push({
      name,
      shortName: isRemote ? name.replace(/^[^/]+\//, '') : name,
      remote: isRemote ? remotes.find((r) => name.startsWith(r + '/')) : null,
      isRemote,
      sha: f[1],
      date: f[2],
      author: f[3],
      email: f[4],
      upstream: f[5],
      track: f[6],
      subject: f[7],
    });
  }

  // 已合并进基准的分支集合
  const mergedOut = await git(repo, ['branch', '--merged', base, '--format=%(refname:short)'], { timeout: 20000 });
  const mergedSet = new Set((mergedOut.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean));

  const locals = raw.filter((b) => !b.isRemote);

  const enriched = await mapLimit(locals, 6, async (b) => {
    const ab = await git(repo, ['rev-list', '--left-right', '--count', `${base}...${b.name}`], { timeout: 20000 });
    let behind = 0, ahead = 0;
    if (ab.ok) {
      const p = ab.stdout.trim().split(/\s+/);
      behind = Number(p[0] || 0);
      ahead = Number(p[1] || 0);
    }
    const merged = mergedSet.has(b.name);
    const reasons = [];
    if (b.name === cur) reasons.push('当前分支');
    if (b.name === base) reasons.push('基准分支');
    if (PROTECTED.has(b.name)) reasons.push('受保护名称');
    return Object.assign(b, {
      isCurrent: b.name === cur,
      isBase: b.name === base,
      merged,
      ahead,
      behind,
      aheadOfUpstream: trackNum(b.track, 'ahead'),
      behindUpstream: trackNum(b.track, 'behind'),
      upstreamGone: /gone/i.test(b.track || ''),
      unmerged: merged ? 0 : ahead,
      deletable: reasons.length === 0,
      blockedBy: reasons,
    });
  });

  const localsSorted = enriched.sort((a, b) => {
    // 未合并的、上游消失的排前面
    const score = (x) => (x.upstreamGone ? 2 : 0) + (x.merged ? 1 : 0) + (x.isCurrent ? -5 : 0);
    const d = score(b) - score(a);
    return d !== 0 ? d : (b.date || '').localeCompare(a.date || '');
  });

  const remoteBranches = raw
    .filter((b) => b.isRemote)
    .filter((b) => !remotes.some((r) => b.name === r + '/HEAD'))
    .map((b) => Object.assign(b, {
      isCurrent: false,
      isBase: b.name === base,
      merged: false,
      ahead: 0,
      behind: 0,
      unmerged: 0,
      upstreamGone: false,
      deletable: !PROTECTED.has(b.shortName) && b.name !== base,
    }));

  const stats = {
    total: locals.length,
    merged: localsSorted.filter((b) => b.merged && !b.isCurrent).length,
    gone: localsSorted.filter((b) => b.upstreamGone && !b.isCurrent).length,
    unmerged: localsSorted.filter((b) => !b.merged && !b.isCurrent).length,
    recent30: localsSorted.filter((b) => b.date && Date.now() - Date.parse(b.date) < 30 * 864e5).length,
  };

  return { repo, base, current: cur, remotes, branches: localsSorted, remotes_branches: remoteBranches, stats };
}

function trackNum(track, word) {
  if (!track) return 0;
  const m = String(track).match(new RegExp(word + '\\s+(\\d+)', 'i'));
  return m ? Number(m[1]) : 0;
}

/* ------------------------------------------------------------------ */
/* 对比 / diff                                                         */
/* ------------------------------------------------------------------ */

function parseNameStatusZ(out) {
  const parts = out.split('\x00');
  const res = [];
  let i = 0;
  while (i < parts.length) {
    const st = parts[i];
    if (!st) { i++; continue; }
    if (st[0] === 'R' || st[0] === 'C') {
      res.push({ status: st[0], oldPath: parts[i + 1] || '', path: parts[i + 2] || '' });
      i += 3;
    } else {
      res.push({ status: st[0], path: parts[i + 1] || '' });
      i += 2;
    }
  }
  return res;
}

function parseNumstatZ(out) {
  const parts = out.split('\x00');
  const res = [];
  let i = 0;
  while (i < parts.length) {
    const head = parts[i];
    if (!head) { i++; continue; }
    const f = head.split('\t');
    if (f.length < 3) { i++; continue; }
    if (f[2] === '') {
      res.push({ path: parts[i + 2] || '', oldPath: parts[i + 1] || '', adds: num(f[0]), dels: num(f[1]) });
      i += 3;
    } else {
      res.push({ path: f.slice(2).join('\t'), adds: num(f[0]), dels: num(f[1]) });
      i += 1;
    }
  }
  return res;
}

function num(v) {
  return v === '-' ? null : Number(v);
}

async function fileStats(repo, rangeArgs, cmd = 'diff') {
  const common = cmd === 'diff-tree' ? ['--no-commit-id', '-r', '--root', '-M', '-z'] : ['-M', '-z'];
  const ns = await git(repo, [cmd, '--numstat'].concat(common, rangeArgs), { timeout: 40000 });
  const st = await git(repo, [cmd, '--name-status'].concat(common, rangeArgs), { timeout: 40000 });
  const stats = parseNumstatZ(ns.stdout);
  const status = parseNameStatusZ(st.stdout);
  const byPath = new Map(status.map((s) => [s.path, s]));
  const files = stats.map((f) => {
    const s = byPath.get(f.path) || {};
    return {
      path: f.path,
      oldPath: f.oldPath || s.oldPath || null,
      adds: f.adds,
      dels: f.dels,
      status: s.status || 'M',
      binary: f.adds === null,
    };
  });
  for (const s of status) {
    if (!files.find((f) => f.path === s.path)) {
      files.push({ path: s.path, oldPath: s.oldPath || null, adds: null, dels: null, status: s.status, binary: false });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function compare(repo, base, head) {
  if (!base || !head) throw new Error('需要 base 与 head');
  const counts = await git(repo, ['rev-list', '--left-right', '--count', `${base}...${head}`], { timeout: 30000 });
  const p = (counts.stdout || '0\t0').trim().split(/\s+/);
  const behind = Number(p[0] || 0);
  const ahead = Number(p[1] || 0);
  const mb = await git(repo, ['merge-base', base, head], { timeout: 20000 });
  const commits = parseCommits((await git(repo, ['log'].concat(LOG_ARGS, ['-n', '400', `${base}..${head}`]), { timeout: 30000 })).stdout);
  const baseOnlyCommits = parseCommits((await git(repo, ['log'].concat(LOG_ARGS, ['-n', '60', `${head}..${base}`]), { timeout: 30000 })).stdout);
  const files = await fileStats(repo, [`${base}...${head}`]);
  const adds = files.reduce((s, f) => s + (f.adds || 0), 0);
  const dels = files.reduce((s, f) => s + (f.dels || 0), 0);
  return {
    base, head,
    mergeBase: (mb.stdout || '').trim(),
    ahead, behind,
    commits, baseOnlyCommits,
    files, totals: { files: files.length, adds, dels },
  };
}

async function getDiff(repo, { base, head, sha, file, mode }) {
  let args;
  if (mode === 'commit' || (sha && !base)) {
    if (!sha) throw new Error('需要 commit sha');
    args = ['show', '--format=', '-M', '--patch', sha];
  } else if (mode === 'two') {
    args = ['diff', '-M', base, head];
  } else {
    args = ['diff', '-M', `${base}...${head}`];
  }
  if (file) args = args.concat(['--', file]);
  const out = await gitOrThrow(repo, args, { timeout: 60000 });
  const c = cap(out);
  return { patch: c.text, truncated: c.truncated, total: c.total || out.length, args: args.join(' ') };
}

/* ------------------------------------------------------------------ */
/* 历史 / 搜索                                                         */
/* ------------------------------------------------------------------ */

async function searchLog(repo, q) {
  const {
    ref = 'HEAD', keyword = '', mode = 'message', author = '', pathFilter = '',
    since = '', until = '', limit = '200',
  } = q;

  const n = Math.max(1, Math.min(1000, Number(limit) || 200));

  if (mode === 'content') {
    // 搜索代码内容（在某分支的当前快照里）
    if (!keyword) return { mode, ref, keyword, matches: [], count: 0 };
    const target = String(ref).startsWith('-') ? 'HEAD' : ref;
    const args = ['grep', '-n', '-I', '-F', '--no-color', '-e', keyword, target];
    if (pathFilter) args.push('--', pathFilter);
    const r = await git(repo, args, { timeout: 30000 });
    const lines = r.stdout.split('\n').filter(Boolean).slice(0, 500);
    const matches = lines.map((l) => {
      const p = l.split(':');
      return { file: p[0], line: p[1], text: p.slice(2).join(':') };
    });
    return { mode, ref: target, keyword, matches, count: matches.length, overflow: r.stdout.split('\n').filter(Boolean).length > 500 };
  }

  const args = ['log', ref, '-n', String(n)].concat(LOG_ARGS);
  if (mode === 'message' && keyword) args.push('-i', '-F', '--grep=' + keyword);
  if (mode === 'code' && keyword) args.push('-S' + keyword);
  if (author) args.push('-i', '--author=' + author);
  if (since) args.push('--since=' + since);
  if (until) args.push('--until=' + until);
  if (pathFilter) args.push('--', pathFilter);

  const out = await gitOrThrow(repo, args, { timeout: 45000 });
  const commits = parseCommits(out);

  if (mode === 'code' && keyword && commits.length) {
    // 附上每个提交里命中关键词的文件
    await mapLimit(commits.slice(0, 40), 5, async (c) => {
      const r = await git(repo, ['show', '--format=', '-M', '--name-only', c.sha], { timeout: 20000 });
      c.files = r.stdout.split('\n').filter(Boolean).slice(0, 40);
    });
  }
  return { mode, ref, keyword, commits, count: commits.length };
}

async function commitDetail(repo, sha) {
  if (!sha) throw new Error('缺少 commit sha');
  const meta = await gitOrThrow(repo, ['show', '-s', '--format=' + C_FMT + '%x00%B%x00%N', sha], { timeout: 20000 });
  const f = meta.split('\x00');
  const parents = f[6] ? f[6].split(' ').filter(Boolean) : [];
  const isMerge = parents.length > 1;
  let files = [];
  try {
    files = isMerge
      ? await fileStats(repo, [parents[0], sha], 'diff')
      : await fileStats(repo, [sha], 'diff-tree');
  } catch (_) {}
  const diff = isMerge
    ? await getDiff(repo, { base: parents[0], head: sha, mode: 'two' })
    : await getDiff(repo, { sha, mode: 'commit' });
  return {
    sha: f[0], short: f[1], date: f[2], author: f[3], email: f[4], subject: f[5],
    parents, isMerge,
    refs: f[7] ? f[7].split(', ').map((s) => s.trim()).filter(Boolean) : [],
    body: f[8] || '', notes: f[9] || '',
    files, ...diff,
  };
}

async function fileHistory(repo, file, ref) {
  const out = await gitOrThrow(repo, ['log', '--follow', '-n', '80'].concat(LOG_ARGS, [ref || 'HEAD', '--', file]), { timeout: 40000 });
  return { file, commits: parseCommits(out) };
}

async function authors(repo, ref) {
  const r = await git(repo, ['shortlog', '-sne', ref || 'HEAD'], { timeout: 30000 });
  return r.stdout
    .split('\n')
    .map((l) => {
      const m = l.match(/^\s*(\d+)\s+(.*?)\s*<([^>]*)>\s*$/);
      return m ? { count: Number(m[1]), name: m[2], email: m[3] } : null;
    })
    .filter(Boolean);
}

async function status(repo) {
  const r = await git(repo, ['status', '--porcelain=v1', '-uno', '--branch'], { timeout: 20000 });
  const lines = r.stdout.split('\n').filter(Boolean);
  const files = lines.filter((l) => !l.startsWith('##')).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
  const head = lines.find((l) => l.startsWith('##')) || '';
  const stash = await git(repo, ['stash', 'list', '--format=%gd%x00%gs'], { timeout: 10000 });
  return {
    head,
    files,
    stashes: stash.stdout.split('\n').filter(Boolean).map((l) => l.split('\x00')),
  };
}

/* ------------------------------------------------------------------ */
/* 删除分支                                                            */
/* ------------------------------------------------------------------ */

async function deleteBranches(repo, { branches = [], force = false, deleteRemote = false }) {
  const cur = await currentBranch(repo);
  const remotes = await listRemotes(repo);
  const base = await detectBase(repo);
  const results = [];

  for (const item of branches) {
    const name = typeof item === 'string' ? item : item.name;
    if (!name) continue;
    const isRemote = typeof item === 'object' && item.remote;

    if (isRemote) {
      if (!deleteRemote) {
        results.push({ name, ok: false, error: '未勾选删除远端分支' });
        continue;
      }
      const remote = remotes.find((r) => name.startsWith(r + '/'));
      if (!remote) {
        results.push({ name, ok: false, error: '无法识别远端' });
        continue;
      }
      const branch = name.slice(remote.length + 1);
      if (branch === base.replace(/^[^/]+\//, '') || PROTECTED.has(branch)) {
        results.push({ name, ok: false, error: '受保护分支，拒绝删除' });
        continue;
      }
      const r = await git(repo, ['push', remote, '--delete', branch], { timeout: 60000 });
      results.push({ name, ok: r.ok, error: r.ok ? '' : cleanGitErr(r.stderr) });
      continue;
    }

    if (name === cur) {
      results.push({ name, ok: false, error: '当前所在分支，不能删除' });
      continue;
    }
    if (name === base || PROTECTED.has(name)) {
      results.push({ name, ok: false, error: '受保护分支，拒绝删除' });
      continue;
    }
    const r = await git(repo, ['branch', force ? '-D' : '-d', name], { timeout: 30000 });
    results.push({ name, ok: r.ok, error: r.ok ? '' : cleanGitErr(r.stderr) });
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Codex                                                              */
/* ------------------------------------------------------------------ */

function buildPrompt(ctx) {
  const {
    mode, repo, base, head, sha, file, question, files, commits, stats,
  } = ctx;
  const lines = [];
  lines.push('你是一名资深代码审查者，正在帮助工程师快速理解一次代码变更。');
  lines.push(`仓库路径：${repo}`);
  lines.push('你可以用只读的 git / shell 命令进一步查看细节（例如 git diff、git log、读源文件）。');
  lines.push('');

  if (mode === 'branch') {
    lines.push(`任务：解释分支 ${head} 相对基准分支 ${base} 的差异（等价于 git diff ${base}...${head}）。`);
  } else if (mode === 'commit') {
    lines.push(`任务：解释提交 ${sha} 改了什么、为什么可能这样改。`);
  } else if (mode === 'file') {
    lines.push(`任务：解释 ${file} 在 ${base}...${head} 之间的差异。`);
  } else {
    lines.push(`任务：回答工程师的问题。`);
  }
  lines.push('');

  if (stats) {
    lines.push(`变更规模：${stats.files} 个文件，+${stats.adds} / -${stats.dels}。`);
  }
  if (commits && commits.length) {
    lines.push('');
    lines.push('提交列表（新→旧）：');
    for (const c of commits.slice(0, 40)) lines.push(`- ${c.short} ${c.author}: ${c.subject}`);
    if (commits.length > 40) lines.push(`- …另有 ${commits.length - 40} 个提交`);
  }
  if (files && files.length) {
    lines.push('');
    lines.push('改动文件：');
    for (const f of files.slice(0, 80)) {
      lines.push(`- [${f.status}] ${f.path} (+${f.adds ?? '?'}/-${f.dels ?? '?'})`);
    }
    if (files.length > 80) lines.push(`- …另有 ${files.length - 80} 个文件`);
  }

  if (question) {
    lines.push('');
    lines.push('工程师的问题：');
    lines.push(question);
    lines.push('');
    lines.push('请先给出直接结论，再展开依据。用简体中文回答。');
  } else {
    lines.push('');
    lines.push('请用简体中文输出 Markdown，严格按以下结构，不要用代码块包裹整段回答：');
    lines.push('## 一句话结论');
    lines.push('## 这个分支做了什么（3-6 条要点）');
    lines.push('## 关键改动（按文件/模块说明，指出重要函数或逻辑）');
    lines.push('## 风险与可疑点（边界条件、兼容性、安全、性能、缺失的测试）');
    lines.push('## 建议的审查动作（具体到该看哪几个文件）');
  }
  return lines.join('\n');
}

function handleCodex(req, res, body) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const prompt = body.prompt || buildPrompt(body);
  const tmpOut = path.join(os.tmpdir(), `gitdeck-codex-${Date.now()}.txt`);
  // 提示词走 stdin（末尾的 -），避免 Windows 命令行引号/编码问题
  const args = [
    'exec', '--color', 'never', '-s', 'read-only', '--ephemeral',
    '-C', body.repo, '-o', tmpOut, '-',
  ];

  send('status', { text: '正在调用本地 codex…', cmd: 'codex exec -s read-only' });

  const env = Object.assign({}, process.env, { NO_COLOR: '1', TERM: 'dumb' });
  const isShim = IS_WIN && /\.(cmd|bat)$/i.test(CODEX_BIN);
  let child;
  if (isShim) {
    const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
    const line = [CODEX_BIN].concat(args).map(q).join(' ');
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
      cwd: body.repo, env, stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: true, windowsHide: true,
    });
  } else {
    child = spawn(CODEX_BIN, args, {
      cwd: body.repo, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
  }

  try {
    child.stdin.write(prompt);
    child.stdin.end();
  } catch (_) {}

  // codex 的行为：最终消息写到 stdout，完整过程（含模型输出）写到 stderr。
  // 因此以 stderr 的 codex 段落作为流式正文，结束时用 -o 落盘文件做权威校正。
  let phase = 'banner'; // banner -> prompt -> body -> done
  let sawBody = false;
  let finished = false;
  let stdoutBuf = '';

  const NOISE = /^(OpenAI Codex v|--------$|workdir:|model:|provider:|approval:|sandbox:|reasoning effort|reasoning summaries|session id:|user$|exec$|tokens used$|^\d{1,3}(,\d{3})*$)/;

  const onStderrLine = (line) => {
    const raw = line.replace(/\r$/, '');
    const t = raw.trim();
    if (!t) {
      if (phase === 'body') send('delta', { text: '' });
      return;
    }
    if (phase === 'banner') {
      if (t === 'user') phase = 'prompt';
      return;
    }
    if (phase === 'prompt') {
      // 跳过提示词回显，直到 agent 段落标记
      if (t === 'codex') { phase = 'body'; sawBody = true; }
      return;
    }
    if (phase !== 'body') return;

    if (/^hook: /.test(t)) return;
    if (t === 'codex') return;                       // 多轮时重复出现的角色标记
    if (/^tokens used$/.test(t) || /^--------$/.test(t)) { phase = 'done'; return; }

    // 工具/命令调用类噪音走 log，不污染正文
    if (/^(exec |mcp:|apply_patch|shell\b|thinking|Thinking|tool:)/.test(t)) {
      send('log', { text: t });
      return;
    }
    send('delta', { text: raw });
  };

  let buf = '';
  const onStderrData = (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      onStderrLine(line);
    }
  };

  child.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString('utf8'); });
  child.stderr.on('data', onStderrData);

  child.on('error', (e) => {
    const hint = e.code === 'ENOENT'
      ? '没有找到 codex 命令。请先安装并登录：\n\n  npm i -g @openai/codex\n  codex login\n\n若已安装，可用环境变量 GITDECK_CODEX=/path/to/codex 指定路径。'
      : e.message;
    send('error', { text: '无法启动 codex：' + hint });
    res.end();
  });

  const finish = async (code) => {
    if (finished) return;
    finished = true;
    if (buf) onStderrLine(buf);
    let finalText = '';
    try {
      finalText = await fsp.readFile(tmpOut, 'utf8');
    } catch (_) {}
    try { fs.unlinkSync(tmpOut); } catch (_) {}
    if (!finalText.trim() && stdoutBuf.trim()) finalText = stdoutBuf;
    if (finalText.trim()) {
      send('final', { text: finalText.trim(), code });
    } else if (!sawBody) {
      send('error', { text: `codex 没有返回内容（退出码 ${code}）。检查一下是否已登录：codex login` });
    } else {
      send('final', { text: '', code });
    }
    send('done', { code });
    res.end();
  };

  child.on('close', (code) => finish(code));
  req.on('close', () => {
    if (!finished) {
      try { child.kill('SIGTERM'); } catch (_) {}
      finished = true;
    }
  });
}

/* ------------------------------------------------------------------ */
/* 路由                                                               */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 'forbidden', 403);
  fs.readFile(file, (err, data) => {
    if (err) return fail(res, 'not found', 404);
    const ext = path.extname(file);
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.json': 'application/json; charset=utf-8',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  const q = Object.fromEntries(u.searchParams.entries());

  try {
    if (!p.startsWith('/api/')) return serveStatic(req, res, p);

    if (p === '/api/config' && req.method === 'GET') {
      return json(res, loadConfig());
    }

    if (p === '/api/pick-dir' && req.method === 'POST') {
      const r = await pickDirectory();
      if (r.error) return fail(res, r.error);
      if (!r.path) return json(res, { ok: true, canceled: true });
      return json(res, { ok: true, path: r.path });
    }

    if (p === '/api/config/roots' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = loadConfig();
      const root = path.resolve(String(body.root || '').replace(/^~(?=$|\/)/, os.homedir()));
      if (!fs.existsSync(root)) return fail(res, '目录不存在: ' + root);
      let added = null;
      try {
        const top = await resolveRepo(root);
        if (!cfg.pins.includes(top)) cfg.pins.push(top);
        added = { type: 'repo', path: top };
      } catch (_) {
        if (!cfg.roots.includes(root)) cfg.roots.push(root);
        added = { type: 'root', path: root };
      }
      saveConfig(cfg);
      scanCache = { at: 0, key: '', repos: [] };
      return json(res, { ok: true, roots: cfg.roots, pins: cfg.pins, added });
    }

    if (p === '/api/config/roots/remove' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = loadConfig();
      cfg.roots = cfg.roots.filter((r) => r !== body.root);
      cfg.pins = (cfg.pins || []).filter((r) => r !== body.root);
      saveConfig(cfg);
      scanCache = { at: 0, key: '', repos: [] };
      return json(res, { ok: true, roots: cfg.roots });
    }

    if (p === '/api/repos' && req.method === 'GET') {
      const cfg = loadConfig();
      const scanned = await scanRoots(cfg.roots);
      const seen = new Set(scanned.map((r) => r.path));
      const pinned = [];
      for (const pin of cfg.pins) {
        try {
          const top = await resolveRepo(pin);
          if (seen.has(top)) continue;
          seen.add(top);
          pinned.push(Object.assign(await repoMeta(top), { pinned: true }));
        } catch (_) {}
      }
      const repos = pinned.concat(scanned);
      return json(res, { roots: cfg.roots, pins: cfg.pins, repos, lastRepo: cfg.lastRepo });
    }

    if (p === '/api/repo' && req.method === 'GET') {
      const repo = await resolveRepo(q.path);
      const cfg = loadConfig();
      cfg.lastRepo = repo;
      saveConfig(cfg);
      const report = await branchReport(repo, q.base || null);
      const st = await status(repo);
      return json(res, Object.assign({ ok: true }, report, { status: st }));
    }

    if (p === '/api/branches' && req.method === 'GET') {
      const repo = await resolveRepo(q.path);
      return json(res, Object.assign({ ok: true }, await branchReport(repo, q.base || null)));
    }

    if (p === '/api/compare' && req.method === 'GET') {
      const repo = await resolveRepo(q.path);
      return json(res, Object.assign({ ok: true }, await compare(repo, q.base, q.head)));
    }

    if (p === '/api/diff' && req.method === 'GET') {
      const repo = await resolveRepo(q.path);
      const out = await getDiff(repo, q);
      return json(res, Object.assign({ ok: true }, out));
    }

    if (p === '/api/log' && req.method === 'GET') {
      const repo = await resolveRepo(q.path);
      return json(res, Object.assign({ ok: true }, await searchLog(repo, q)));
    }

    if (p === '/api/commit' && req.method === 'GET') {
      const repo = await resolveRepo(q.path);
      return json(res, Object.assign({ ok: true }, await commitDetail(repo, q.sha)));
    }

    if (p === '/api/filelog' && req.method === 'GET') {
      const repo = await resolveRepo(q.path);
      return json(res, Object.assign({ ok: true }, await fileHistory(repo, q.file, q.ref)));
    }

    if (p === '/api/authors' && req.method === 'GET') {
      const repo = await resolveRepo(q.path);
      return json(res, { ok: true, authors: await authors(repo, q.ref) });
    }

    if (p === '/api/status' && req.method === 'GET') {
      const repo = await resolveRepo(q.path);
      return json(res, Object.assign({ ok: true }, await status(repo)));
    }

    if (p === '/api/branch/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const repo = await resolveRepo(body.path);
      const results = await deleteBranches(repo, body);
      return json(res, { ok: true, results });
    }

    if (p === '/api/codex' && req.method === 'POST') {
      const body = await readBody(req);
      body.repo = await resolveRepo(body.repo);
      return handleCodex(req, res, body);
    }

    return fail(res, '未知接口: ' + p, 404);
  } catch (e) {
    if (p === '/api/codex') return;
    return fail(res, e.message || 'internal error', 500);
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  gitdeck 已启动 →  ${url}\n`);
  console.log(`  仓库根目录: ${loadConfig().roots.join(', ')}`);
  console.log(`  按 Ctrl+C 退出\n`);
});
