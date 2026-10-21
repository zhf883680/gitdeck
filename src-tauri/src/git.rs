//! git 命令封装与解析：所有数据都从 git 的机器可读输出里取，不依赖本地化文案。

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub const C_FMT: &str = "%H%x00%h%x00%cI%x00%an%x00%ae%x00%s%x00%P%x00%D";
const BR_FMT: &str = "%(refname:short)%00%(objectname:short)%00%(committerdate:iso-strict)%00%(authorname)%00%(authoremail)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(subject)%00%(refname)%00%(symref)%00%(committerdate:unix)";

const MAX_DIFF: usize = 800 * 1024;

/* ------------------------------- 基础执行 ------------------------------- */

pub struct Out {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

pub fn git_bin() -> String {
    if let Ok(p) = std::env::var("GITDECK_GIT") {
        if Path::new(&p).exists() {
            return p;
        }
    }
    #[cfg(windows)]
    {
        let guesses = [
            r"C:\Program Files\Git\cmd\git.exe",
            r"C:\Program Files (x86)\Git\cmd\git.exe",
        ];
        for g in guesses {
            if Path::new(g).exists() {
                return g.to_string();
            }
        }
    }
    "git".to_string()
}

/// Windows 下隐藏子进程控制台窗口。
/// git.exe / cmd.exe 都是控制台程序，GUI 进程直接 spawn 会弹黑窗。
#[cfg(windows)]
pub fn no_window(cmd: &mut tokio::process::Command) {
    // tokio::process::Command 自带 creation_flags（Windows 专有固有方法）
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn no_window(_cmd: &mut tokio::process::Command) {}

pub async fn run(repo: Option<&str>, args: &[String]) -> Out {
    let mut cmd = tokio::process::Command::new(git_bin());
    no_window(&mut cmd);
    cmd.args([
        "-c",
        "core.quotepath=false",
        "-c",
        "color.ui=never",
        "-c",
        "log.showSignature=false",
    ]);
    if let Some(r) = repo {
        cmd.arg("-C").arg(r);
    }
    cmd.args(args);
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    match cmd.output().await {
        Ok(o) => Out {
            ok: o.status.success(),
            stdout: String::from_utf8_lossy(&o.stdout).to_string(),
            stderr: String::from_utf8_lossy(&o.stderr).to_string(),
        },
        Err(e) => Out {
            ok: false,
            stdout: String::new(),
            stderr: format!("无法执行 git: {e}"),
        },
    }
}

/// 带超时的执行：fetch / pull 这类走网络的命令必须有上限，否则会一直挂着
pub async fn run_timeout(repo: Option<&str>, args: &[String], secs: u64) -> Out {
    match tokio::time::timeout(std::time::Duration::from_secs(secs), run(repo, args)).await {
        Ok(o) => o,
        Err(_) => Out {
            ok: false,
            stdout: String::new(),
            stderr: format!("操作超时（{secs} 秒），可能是网络或凭据问题"),
        },
    }
}

pub async fn run_ok(repo: Option<&str>, args: &[String]) -> Result<String, String> {
    let o = run(repo, args).await;
    if o.ok {
        Ok(o.stdout)
    } else {
        Err(clean_err(&o.stderr))
    }
}

pub fn clean_err(s: &str) -> String {
    s.lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with("hint:"))
        .take(4)
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn s(v: &str) -> String {
    v.to_string()
}

/* --------------------------------- 模型 --------------------------------- */

#[derive(Debug, Clone, Serialize, Default)]
pub struct Commit {
    pub sha: String,
    pub short: String,
    pub date: String,
    pub author: String,
    pub email: String,
    pub subject: String,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    #[serde(rename = "isMerge")]
    pub is_merge: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RepoMeta {
    pub path: String,
    pub name: String,
    pub parent: String,
    pub branch: String,
    pub sha: String,
    pub date: String,
    pub author: String,
    pub subject: String,
    pub empty: bool,
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Branch {
    pub name: String,
    #[serde(rename = "shortName")]
    pub short_name: String,
    pub remote: Option<String>,
    #[serde(rename = "isRemote")]
    pub is_remote: bool,
    pub sha: String,
    pub date: String,
    pub author: String,
    pub email: String,
    pub upstream: String,
    pub track: String,
    pub subject: String,
    #[serde(rename = "isCurrent")]
    pub is_current: bool,
    #[serde(rename = "isBase")]
    pub is_base: bool,
    pub merged: bool,
    pub ahead: i64,
    pub behind: i64,
    #[serde(rename = "aheadOfUpstream")]
    pub ahead_of_upstream: i64,
    #[serde(rename = "behindUpstream")]
    pub behind_upstream: i64,
    #[serde(rename = "upstreamGone")]
    pub upstream_gone: bool,
    pub unmerged: i64,
    pub deletable: bool,
    #[serde(rename = "blockedBy")]
    pub blocked_by: Vec<String>,
    /// 被某个 worktree 检出时的路径
    #[serde(rename = "worktreePath")]
    pub worktree_path: Option<String>,
    /// 该 worktree 里未提交/未跟踪的文件数
    #[serde(rename = "worktreeDirty")]
    pub worktree_dirty: usize,
    #[serde(skip)]
    pub date_unix: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct BranchStats {
    pub total: usize,
    pub merged: usize,
    pub gone: usize,
    pub unmerged: usize,
    #[serde(rename = "recent30")]
    pub recent30: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct BranchReport {
    pub repo: String,
    pub base: String,
    pub current: String,
    pub remotes: Vec<String>,
    pub branches: Vec<Branch>,
    #[serde(rename = "remotes_branches")]
    pub remotes_branches: Vec<Branch>,
    pub stats: BranchStats,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct FileStat {
    pub path: String,
    #[serde(rename = "oldPath")]
    pub old_path: Option<String>,
    pub adds: Option<i64>,
    pub dels: Option<i64>,
    pub status: String,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Totals {
    pub files: usize,
    pub adds: i64,
    pub dels: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CompareOut {
    pub base: String,
    pub head: String,
    #[serde(rename = "mergeBase")]
    pub merge_base: String,
    pub ahead: i64,
    pub behind: i64,
    pub commits: Vec<Commit>,
    #[serde(rename = "baseOnlyCommits")]
    pub base_only_commits: Vec<Commit>,
    pub files: Vec<FileStat>,
    pub totals: Totals,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct DiffOut {
    pub patch: String,
    pub truncated: bool,
    pub total: usize,
    pub args: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct StatusFile {
    pub status: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct StatusOut {
    pub head: String,
    pub files: Vec<StatusFile>,
    pub stashes: Vec<(String, String)>,
}

/* -------------------------------- 解析器 -------------------------------- */

pub fn parse_commits(out: &str) -> Vec<Commit> {
    let mut rows = Vec::new();
    for line in out.split('\n') {
        if line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\0').collect();
        if f.len() < 8 {
            continue;
        }
        let parents: Vec<String> = f[6].split(' ').filter(|x| !x.is_empty()).map(|x| x.to_string()).collect();
        let refs: Vec<String> = if f[7].trim().is_empty() {
            Vec::new()
        } else {
            f[7].split(", ").map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
        };
        rows.push(Commit {
            sha: s(f[0]),
            short: s(f[1]),
            date: s(f[2]),
            author: s(f[3]),
            email: s(f[4]),
            subject: s(f[5]),
            is_merge: parents.len() > 1,
            parents,
            refs,
            files: None,
        });
    }
    rows
}

fn num(v: &str) -> Option<i64> {
    if v == "-" {
        None
    } else {
        v.parse::<i64>().ok()
    }
}

fn parse_numstat_z(out: &str) -> Vec<FileStat> {
    let parts: Vec<&str> = out.split('\0').collect();
    let mut res = Vec::new();
    let mut i = 0usize;
    while i < parts.len() {
        let head = parts[i];
        if head.is_empty() {
            i += 1;
            continue;
        }
        let f: Vec<&str> = head.split('\t').collect();
        if f.len() < 3 {
            i += 1;
            continue;
        }
        if f[2].is_empty() {
            let old = parts.get(i + 1).copied().unwrap_or("");
            let new = parts.get(i + 2).copied().unwrap_or("");
            res.push(FileStat {
                path: s(new),
                old_path: Some(s(old)),
                adds: num(f[0]),
                dels: num(f[1]),
                status: String::new(),
                binary: num(f[0]).is_none(),
            });
            i += 3;
        } else {
            res.push(FileStat {
                path: f[2].to_string(),
                old_path: None,
                adds: num(f[0]),
                dels: num(f[1]),
                status: String::new(),
                binary: num(f[0]).is_none(),
            });
            i += 1;
        }
    }
    res
}

fn parse_name_status_z(out: &str) -> Vec<(String, String, Option<String>)> {
    let parts: Vec<&str> = out.split('\0').collect();
    let mut res = Vec::new();
    let mut i = 0usize;
    while i < parts.len() {
        let st = parts[i];
        if st.is_empty() {
            i += 1;
            continue;
        }
        let letter = st.chars().next().unwrap_or('M').to_string();
        if letter == "R" || letter == "C" {
            let old = parts.get(i + 1).copied().unwrap_or("");
            let new = parts.get(i + 2).copied().unwrap_or("");
            res.push((letter, s(new), Some(s(old))));
            i += 3;
        } else {
            let p = parts.get(i + 1).copied().unwrap_or("");
            res.push((letter, s(p), None));
            i += 2;
        }
    }
    res
}

/* ------------------------------- 仓库发现 ------------------------------- */

pub async fn repo_meta(dir: &str) -> RepoMeta {
    let log = run(
        Some(dir),
        &[
            s("log"),
            s("-1"),
            s("--date=iso-strict"),
            s("--format=%H%x00%h%x00%cI%x00%an%x00%s"),
        ],
    )
    .await;
    let br = run(Some(dir), &[s("rev-parse"), s("--abbrev-ref"), s("HEAD")]).await;
    let head: Vec<&str> = if log.ok { log.stdout.split('\0').collect() } else { Vec::new() };
    RepoMeta {
        path: s(dir),
        name: Path::new(dir).file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default(),
        parent: Path::new(dir)
            .parent()
            .and_then(|p| p.file_name())
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_default(),
        branch: {
            let b = br.stdout.trim();
            if b.is_empty() { "—".into() } else { b.into() }
        },
        sha: head.get(1).map(|x| x.to_string()).unwrap_or_default(),
        date: head.get(2).map(|x| x.to_string()).unwrap_or_default(),
        author: head.get(3).map(|x| x.to_string()).unwrap_or_default(),
        subject: head.get(4).map(|x| x.trim().to_string()).unwrap_or_default(),
        empty: !log.ok,
        pinned: false,
    }
}

const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "Library", ".Trash", ".cache", "dist", "build", ".next", "Pods", "venv",
    ".venv", "__pycache__", ".idea", "target", ".gradle", "vendor", "Applications", "Pictures",
    "Music", "Movies", "Downloads", "AppData", "Application Data", "OneDrive", "python", "Python",
    "anaconda3", "miniconda3",
];

fn find_repos_sync(root: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > 3 || out.len() > 300 {
        return;
    }
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut dirs = Vec::new();
    let mut has_git = false;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name == ".git" {
            has_git = true;
        }
        let ft = match e.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            dirs.push(name);
        }
    }
    if has_git {
        out.push(root.to_string_lossy().to_string());
        return;
    }
    for name in dirs {
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        find_repos_sync(&root.join(&name), depth + 1, out);
    }
}

pub async fn scan_roots(roots: &[String]) -> Vec<RepoMeta> {
    let roots = roots.to_vec();
    let found = tokio::task::spawn_blocking(move || {
        let mut acc = Vec::new();
        for r in roots {
            find_repos_sync(Path::new(&r), 1, &mut acc);
        }
        acc
    })
    .await
    .unwrap_or_default();

    let mut metas = Vec::new();
    for chunk in found.chunks(6) {
        let mut set = tokio::task::JoinSet::new();
        for dir in chunk {
            let d = dir.clone();
            set.spawn(async move { repo_meta(&d).await });
        }
        while let Some(res) = set.join_next().await {
            if let Ok(m) = res {
                metas.push(m);
            }
        }
    }
    metas.sort_by(|a, b| b.date.cmp(&a.date));
    metas
}

pub async fn resolve_repo(p: &str) -> Result<String, String> {
    let abs = expand_path(p);
    if !Path::new(&abs).is_dir() {
        return Err(format!("目录不存在: {abs}"));
    }
    let top = run_ok(Some(&abs), &[s("rev-parse"), s("--show-toplevel")]).await?;
    let t = top.trim().to_string();
    if t.is_empty() {
        return Err(format!("不是 Git 仓库: {abs}"));
    }
    Ok(t)
}

pub fn expand_path(p: &str) -> String {
    let trimmed = p.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return Path::new(&home).join(rest).to_string_lossy().to_string();
        }
    }
    if trimmed == "~" {
        if let Some(home) = std::env::var_os("HOME") {
            return home.to_string_lossy().to_string();
        }
    }
    trimmed.to_string()
}

/* -------------------------------- 分支查询 -------------------------------- */

pub async fn current_branch(repo: &str) -> String {
    run(Some(repo), &[s("rev-parse"), s("--abbrev-ref"), s("HEAD")])
        .await
        .stdout
        .trim()
        .to_string()
}

async fn ref_exists(repo: &str, r: &str) -> bool {
    run(Some(repo), &[s("rev-parse"), s("--verify"), s("--quiet"), format!("{r}^{{commit}}")])
        .await
        .ok
}

pub async fn detect_base(repo: &str) -> String {
    let sym = run(Some(repo), &[s("symbolic-ref"), s("--short"), s("-q"), s("refs/remotes/origin/HEAD")]).await;
    let remote_base = sym.stdout.trim().to_string();
    if !remote_base.is_empty() {
        let local = remote_base.splitn(2, '/').nth(1).unwrap_or("").to_string();
        if !local.is_empty() && ref_exists(repo, &local).await {
            return local;
        }
        if ref_exists(repo, &remote_base).await {
            return remote_base;
        }
    }
    for c in ["main", "master", "develop", "dev", "trunk"] {
        if ref_exists(repo, c).await {
            return c.to_string();
        }
    }
    let cur = current_branch(repo).await;
    if cur.is_empty() || cur == "HEAD" {
        "HEAD".into()
    } else {
        cur
    }
}

#[derive(Debug, Clone, Default)]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub main: bool,
    pub prunable: bool,
}

pub async fn list_worktrees(repo: &str) -> Vec<Worktree> {
    let out = run(Some(repo), &[s("worktree"), s("list"), s("--porcelain")]).await.stdout;
    let main_path = run(Some(repo), &[s("rev-parse"), s("--show-toplevel")])
        .await
        .stdout
        .trim()
        .to_string();
    let mut list: Vec<Worktree> = Vec::new();
    let mut cur: Option<Worktree> = None;
    for line in out.split('\n') {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            cur = Some(Worktree {
                path: p.trim().to_string(),
                main: p.trim() == main_path,
                ..Default::default()
            });
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            if let Some(w) = cur.as_mut() {
                w.branch = b.trim().to_string();
            }
        } else if line.trim() == "prunable" || line.starts_with("prunable ") {
            if let Some(w) = cur.as_mut() {
                w.prunable = true;
            }
        }
    }
    if let Some(w) = cur.take() {
        list.push(w);
    }
    list
}

/// worktree 里未提交改动的条数（含未跟踪文件）
pub async fn worktree_dirty_count(path: &str) -> usize {
    if !Path::new(path).exists() {
        return 0;
    }
    run(Some(path), &[s("status"), s("--porcelain=v1")])
        .await
        .stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count()
}

pub async fn list_remotes(repo: &str) -> Vec<String> {
    run(Some(repo), &[s("remote")])
        .await
        .stdout
        .split('\n')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

fn track_num(track: &str, word: &str) -> i64 {
    if track.is_empty() {
        return 0;
    }
    for piece in track.split(',') {
        let p = piece.trim();
        if let Some(rest) = p.strip_prefix(word) {
            if let Ok(n) = rest.trim().parse::<i64>() {
                return n;
            }
        }
    }
    0
}

fn is_protected(name: &str) -> bool {
    matches!(name, "main" | "master" | "develop" | "dev" | "trunk" | "release")
}

async fn ahead_behind(repo: &str, base: &str, name: &str) -> (i64, i64) {
    let o = run(Some(repo), &[s("rev-list"), s("--left-right"), s("--count"), format!("{base}...{name}")]).await;
    if !o.ok {
        return (0, 0);
    }
    let parts: Vec<i64> = o.stdout.trim().split_whitespace().filter_map(|x| x.parse().ok()).collect();
    (parts.get(1).copied().unwrap_or(0), parts.first().copied().unwrap_or(0))
}

pub async fn branch_report(repo: &str, base_override: Option<&str>) -> BranchReport {
    let base = match base_override {
        Some(b) if !b.is_empty() => b.to_string(),
        _ => detect_base(repo).await,
    };
    let cur = current_branch(repo).await;
    let remotes = list_remotes(repo).await;

    let refs = run(
        Some(repo),
        &[
            s("for-each-ref"),
            s("--sort=-committerdate"),
            format!("--format={BR_FMT}"),
            s("refs/heads"),
            s("refs/remotes"),
        ],
    )
    .await
    .stdout;

    let mut raw: Vec<Branch> = Vec::new();
    for line in refs.split('\n') {
        if line.is_empty() {
            continue;
        }
        let f: Vec<&str> = line.split('\0').collect();
        if f.len() < 10 {
            continue;
        }
        if !f[9].is_empty() {
            continue; // origin/HEAD 之类的符号引用
        }
        let name = f[0].to_string();
        if name.ends_with("/HEAD") {
            continue;
        }
        let remote = remotes.iter().find(|r| name.starts_with(&format!("{r}/"))).cloned();
        let is_remote = remote.is_some();
        raw.push(Branch {
            short_name: if is_remote {
                name.splitn(2, '/').nth(1).unwrap_or(&name).to_string()
            } else {
                name.clone()
            },
            remote: remote.clone(),
            is_remote,
            sha: s(f[1]),
            date: s(f[2]),
            author: s(f[3]),
            email: s(f[4]),
            upstream: s(f[5]),
            track: s(f[6]),
            subject: f[7].trim().to_string(),
            date_unix: f[10].trim().parse().unwrap_or(0),
            name,
            ..Default::default()
        });
    }

    let merged_out = run(
        Some(repo),
        &[s("branch"), s("--merged"), base.clone(), s("--format=%(refname:short)")],
    )
    .await
    .stdout;
    let merged_set: HashSet<String> = merged_out
        .split('\n')
        .map(|x| x.trim().to_string())
        .filter(|x| !x.is_empty())
        .collect();

    // 哪些分支被 worktree 检出（含该 worktree 的脏改动数）
    let worktrees = list_worktrees(repo).await;
    let mut wt_map: HashMap<String, (String, usize)> = HashMap::new();
    let mut set = tokio::task::JoinSet::new();
    for w in worktrees.iter().filter(|w| !w.branch.is_empty()).cloned().collect::<Vec<_>>() {
        set.spawn(async move {
            let n = worktree_dirty_count(&w.path).await;
            (w.branch, w.path, n)
        });
    }
    while let Some(res) = set.join_next().await {
        if let Ok((branch, path, n)) = res {
            wt_map.insert(branch, (path, n));
        }
    }

    let locals: Vec<Branch> = raw.iter().filter(|b| !b.is_remote).cloned().collect();
    let mut enriched: Vec<Branch> = Vec::new();
    for chunk in locals.chunks(8) {
        let mut set = tokio::task::JoinSet::new();
        for b in chunk {
            let repo_s = repo.to_string();
            let base_s = base.clone();
            let b2 = b.clone();
            set.spawn(async move {
                let (ahead, behind) = ahead_behind(&repo_s, &base_s, &b2.name).await;
                (b2, ahead, behind)
            });
        }
        while let Some(res) = set.join_next().await {
            if let Ok((mut b, ahead, behind)) = res {
                let merged = merged_set.contains(&b.name);
                let mut blocked = Vec::new();
                if b.name == cur {
                    blocked.push("当前分支".to_string());
                }
                if b.name == base {
                    blocked.push("基准分支".to_string());
                }
                if is_protected(&b.name) {
                    blocked.push("受保护名称".to_string());
                }
                b.is_current = b.name == cur;
                b.is_base = b.name == base;
                b.merged = merged;
                b.ahead = ahead;
                b.behind = behind;
                b.ahead_of_upstream = track_num(&b.track, "ahead");
                b.behind_upstream = track_num(&b.track, "behind");
                b.upstream_gone = b.track.to_lowercase().contains("gone");
                b.unmerged = if merged { 0 } else { ahead };
                b.deletable = blocked.is_empty();
                b.blocked_by = blocked;
                if let Some((path, dirty)) = wt_map.get(&b.name) {
                    b.worktree_path = Some(path.clone());
                    b.worktree_dirty = *dirty;
                }
                enriched.push(b);
            }
        }
    }

    let score = |x: &Branch| -> i32 {
        (if x.upstream_gone { 2 } else { 0 })
            + (if x.merged { 1 } else { 0 })
            + (if x.is_current { -5 } else { 0 })
    };
    enriched.sort_by(|a, b| {
        let d = score(b) - score(a);
        if d != 0 {
            d.cmp(&0)
        } else {
            b.date.cmp(&a.date)
        }
    });

    let mut remotes_branches: Vec<Branch> = raw
        .into_iter()
        .filter(|b| b.is_remote)
        .filter(|b| !remotes.iter().any(|r| b.name == format!("{r}/HEAD")))
        .map(|mut b| {
            b.is_base = b.name == base;
            b.deletable = !is_protected(&b.short_name) && b.name != base;
            b
        })
        .collect();

    // 远端分支同样算出相对基准分支的 ahead/behind，方便和本地分支放在一起看
    let names: Vec<String> = remotes_branches.iter().map(|b| b.name.clone()).collect();
    let mut ab: HashMap<String, (i64, i64)> = HashMap::new();
    for chunk in names.chunks(8) {
        let mut set = tokio::task::JoinSet::new();
        for n in chunk {
            let repo_s = repo.to_string();
            let base_s = base.clone();
            let n2 = n.clone();
            set.spawn(async move {
                let (a, b) = ahead_behind(&repo_s, &base_s, &n2).await;
                (n2, a, b)
            });
        }
        while let Some(res) = set.join_next().await {
            if let Ok((n, a, b)) = res {
                ab.insert(n, (a, b));
            }
        }
    }
    for b in remotes_branches.iter_mut() {
        if let Some((a, be)) = ab.get(&b.name) {
            b.ahead = *a;
            b.behind = *be;
        }
    }

    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let cutoff = now_unix - 30 * 86400;
    let stats = BranchStats {
        total: enriched.len(),
        merged: enriched.iter().filter(|b| b.merged && !b.is_current).count(),
        gone: enriched.iter().filter(|b| b.upstream_gone && !b.is_current).count(),
        unmerged: enriched.iter().filter(|b| !b.merged && !b.is_current).count(),
        recent30: enriched
            .iter()
            .filter(|b| b.date_unix > 0 && b.date_unix >= cutoff)
            .count(),
    };

    BranchReport {
        repo: repo.to_string(),
        base,
        current: cur,
        remotes,
        branches: enriched,
        remotes_branches,
        stats,
    }
}

/* ------------------------------- 文件级差异 ------------------------------- */

pub async fn file_stats(repo: &str, range: &[String], diff_tree: bool) -> Vec<FileStat> {
    let (cmd, common) = if diff_tree {
        ("diff-tree", vec![s("--no-commit-id"), s("-r"), s("--root"), s("-M"), s("-z")])
    } else {
        ("diff", vec![s("-M"), s("-z")])
    };

    let mut ns_args = vec![s(cmd), s("--numstat")];
    ns_args.extend(common.clone());
    ns_args.extend(range.iter().cloned());
    let ns = run(Some(repo), &ns_args).await;

    let mut st_args = vec![s(cmd), s("--name-status")];
    st_args.extend(common);
    st_args.extend(range.iter().cloned());
    let st = run(Some(repo), &st_args).await;

    let mut files = parse_numstat_z(&ns.stdout);
    let statuses = parse_name_status_z(&st.stdout);
    let mut by_path: HashMap<String, (String, Option<String>)> = HashMap::new();
    for (letter, path, old) in statuses {
        by_path.insert(path, (letter, old));
    }
    for f in files.iter_mut() {
        if let Some((letter, old)) = by_path.get(&f.path) {
            f.status = letter.clone();
            if f.old_path.is_none() {
                f.old_path = old.clone();
            }
        } else {
            f.status = "M".into();
        }
    }
    for (path, (letter, old)) in by_path.iter() {
        if !files.iter().any(|f| &f.path == path) {
            files.push(FileStat {
                path: path.clone(),
                old_path: old.clone(),
                adds: None,
                dels: None,
                status: letter.clone(),
                binary: false,
            });
        }
    }
    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    files
}

pub async fn compare(repo: &str, base: &str, head: &str) -> Result<CompareOut, String> {
    if base.is_empty() || head.is_empty() {
        return Err("需要 base 与 head".into());
    }
    let counts = run(
        Some(repo),
        &[s("rev-list"), s("--left-right"), s("--count"), format!("{base}...{head}")],
    )
    .await;
    let parts: Vec<i64> = counts.stdout.trim().split_whitespace().filter_map(|x| x.parse().ok()).collect();
    let behind = parts.first().copied().unwrap_or(0);
    let ahead = parts.get(1).copied().unwrap_or(0);
    let merge_base = run(Some(repo), &[s("merge-base"), s(base), s(head)])
        .await
        .stdout
        .trim()
        .to_string();

    let commits = parse_commits(
        &run(
            Some(repo),
            &[s("log"), format!("--format={C_FMT}"), s("-n"), s("400"), format!("{base}..{head}")],
        )
        .await
        .stdout,
    );
    let base_only = parse_commits(
        &run(
            Some(repo),
            &[s("log"), format!("--format={C_FMT}"), s("-n"), s("60"), format!("{head}..{base}")],
        )
        .await
        .stdout,
    );
    let files = file_stats(repo, &[format!("{base}...{head}")], false).await;
    let adds = files.iter().map(|f| f.adds.unwrap_or(0)).sum();
    let dels = files.iter().map(|f| f.dels.unwrap_or(0)).sum();
    Ok(CompareOut {
        base: base.to_string(),
        head: head.to_string(),
        merge_base,
        ahead,
        behind,
        commits,
        base_only_commits: base_only,
        totals: Totals {
            files: files.len(),
            adds,
            dels,
        },
        files,
    })
}

pub struct DiffQuery {
    pub base: String,
    pub head: String,
    pub sha: String,
    pub file: String,
    pub mode: String,
}

pub async fn get_diff(repo: &str, q: &DiffQuery) -> Result<DiffOut, String> {
    let mut args: Vec<String>;
    if q.mode == "commit" || (!q.sha.is_empty() && q.base.is_empty()) {
        if q.sha.is_empty() {
            return Err("需要 commit sha".into());
        }
        // 合并提交 git show 默认不输出 diff，退化为「与第一父提交比较」
        let parents = run(
            Some(repo),
            &[s("rev-list"), s("--parents"), s("-n"), s("1"), s(&q.sha)],
        )
        .await
        .stdout;
        let ids: Vec<&str> = parents.split_whitespace().collect();
        if ids.len() > 2 {
            args = vec![s("diff"), s("-M"), s(ids[1]), s(&q.sha)];
        } else {
            args = vec![s("show"), s("--format="), s("-M"), s("--patch"), s(&q.sha)];
        }
    } else if q.mode == "two" {
        args = vec![s("diff"), s("-M"), s(&q.base), s(&q.head)];
    } else {
        args = vec![s("diff"), s("-M"), format!("{}...{}", q.base, q.head)];
    }
    if !q.file.is_empty() {
        args.push(s("--"));
        args.push(s(&q.file));
    }
    let patch = run_ok(Some(repo), &args).await?;
    let total = patch.chars().count();
    let (text, truncated) = if total > MAX_DIFF {
        (patch.chars().take(MAX_DIFF).collect::<String>(), true)
    } else {
        (patch, false)
    };
    Ok(DiffOut {
        patch: text,
        truncated,
        total,
        args: args.join(" "),
    })
}

/* -------------------------------- 历史搜索 -------------------------------- */

pub struct SearchQuery {
    pub r#ref: String,
    pub keyword: String,
    pub mode: String,
    pub author: String,
    pub path_filter: String,
    pub limit: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct GrepMatch {
    pub file: String,
    pub line: String,
    pub text: String,
}

pub enum SearchResult {
    Commits(Vec<Commit>),
    Matches(Vec<GrepMatch>),
}

pub async fn search_log(repo: &str, q: &SearchQuery) -> Result<SearchResult, String> {
    if q.mode == "content" {
        if q.keyword.is_empty() {
            return Ok(SearchResult::Matches(Vec::new()));
        }
        let target = if q.r#ref.starts_with('-') { "HEAD".to_string() } else { q.r#ref.clone() };
        let mut args = vec![
            s("grep"), s("-n"), s("-I"), s("-F"), s("--no-color"), s("-e"), q.keyword.clone(), target,
        ];
        if !q.path_filter.is_empty() {
            args.push(s("--"));
            args.push(s(&q.path_filter));
        }
        let out = run(Some(repo), &args).await.stdout;
        let mut matches = Vec::new();
        for line in out.split('\n').filter(|l| !l.is_empty()).take(500) {
            let mut it = line.splitn(3, ':');
            let file = it.next().unwrap_or("").to_string();
            let no = it.next().unwrap_or("").to_string();
            let text = it.next().unwrap_or("").to_string();
            matches.push(GrepMatch { file, line: no, text });
        }
        return Ok(SearchResult::Matches(matches));
    }

    let mut args = vec![
        s("log"),
        if q.r#ref.is_empty() { s("HEAD") } else { q.r#ref.clone() },
        s("-n"),
        q.limit.to_string(),
        format!("--format={C_FMT}"),
    ];
    if q.mode == "message" && !q.keyword.is_empty() {
        args.push(s("-i"));
        args.push(s("-F"));
        args.push(format!("--grep={}", q.keyword));
    }
    if q.mode == "code" && !q.keyword.is_empty() {
        args.push(format!("-S{}", q.keyword));
    }
    if !q.author.is_empty() {
        args.push(s("-i"));
        args.push(format!("--author={}", q.author));
    }
    if !q.path_filter.is_empty() {
        args.push(s("--"));
        args.push(s(&q.path_filter));
    }
    let out = run_ok(Some(repo), &args).await?;
    let mut commits = parse_commits(&out);

    if q.mode == "code" && !q.keyword.is_empty() {
        for c in commits.iter_mut().take(40) {
            let o = run(
                Some(repo),
                &[s("show"), s("--format="), s("-M"), s("--name-only"), s(&c.sha)],
            )
            .await;
            c.files = Some(
                o.stdout
                    .split('\n')
                    .filter(|x| !x.is_empty())
                    .take(40)
                    .map(|x| x.to_string())
                    .collect(),
            );
        }
    }
    Ok(SearchResult::Commits(commits))
}

/* -------------------------------- 提交详情 -------------------------------- */

#[derive(Debug, Clone, Serialize, Default)]
pub struct CommitDetail {
    pub sha: String,
    pub short: String,
    pub date: String,
    pub author: String,
    pub email: String,
    pub subject: String,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    #[serde(rename = "isMerge")]
    pub is_merge: bool,
    pub body: String,
    pub notes: String,
    pub files: Vec<FileStat>,
    pub patch: String,
    pub truncated: bool,
    pub total: usize,
    pub args: String,
}

pub async fn commit_detail(repo: &str, sha: &str) -> Result<CommitDetail, String> {
    if sha.is_empty() {
        return Err("缺少 commit sha".into());
    }
    let meta = run_ok(
        Some(repo),
        &[s("show"), s("-s"), format!("--format={C_FMT}%x00%B%x00%N"), s(sha)],
    )
    .await?;
    let f: Vec<&str> = meta.split('\0').collect();
    let parents: Vec<String> = f
        .get(6)
        .map(|p| p.split(' ').filter(|x| !x.is_empty()).map(|x| x.to_string()).collect())
        .unwrap_or_default();
    let is_merge = parents.len() > 1;

    let files = if is_merge {
        file_stats(repo, &[parents[0].clone(), s(sha)], false).await
    } else {
        file_stats(repo, &[s(sha)], true).await
    };

    let diff = if is_merge {
        get_diff(
            repo,
            &DiffQuery {
                base: parents[0].clone(),
                head: s(sha),
                sha: String::new(),
                file: String::new(),
                mode: "two".into(),
            },
        )
        .await?
    } else {
        get_diff(
            repo,
            &DiffQuery {
                base: String::new(),
                head: String::new(),
                sha: s(sha),
                file: String::new(),
                mode: "commit".into(),
            },
        )
        .await?
    };

    let refs = f
        .get(7)
        .map(|x| x.split(", ").map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).collect())
        .unwrap_or_default();

    Ok(CommitDetail {
        sha: f.first().map(|x| x.to_string()).unwrap_or_default(),
        short: f.get(1).map(|x| x.to_string()).unwrap_or_default(),
        date: f.get(2).map(|x| x.to_string()).unwrap_or_default(),
        author: f.get(3).map(|x| x.to_string()).unwrap_or_default(),
        email: f.get(4).map(|x| x.to_string()).unwrap_or_default(),
        subject: f.get(5).map(|x| x.to_string()).unwrap_or_default(),
        parents,
        refs,
        is_merge,
        body: f.get(8).map(|x| x.to_string()).unwrap_or_default(),
        notes: f.get(9).map(|x| x.to_string()).unwrap_or_default(),
        files,
        patch: diff.patch,
        truncated: diff.truncated,
        total: diff.total,
        args: diff.args,
    })
}

pub async fn file_history(repo: &str, file: &str, r#ref: &str) -> Result<Vec<Commit>, String> {
    let target = if r#ref.is_empty() { "HEAD" } else { r#ref };
    let out = run_ok(
        Some(repo),
        &[
            s("log"),
            s("--follow"),
            s("-n"),
            s("80"),
            format!("--format={C_FMT}"),
            s(target),
            s("--"),
            s(file),
        ],
    )
    .await?;
    Ok(parse_commits(&out))
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthorRow {
    pub count: i64,
    pub name: String,
    pub email: String,
}

pub async fn authors(repo: &str, r#ref: &str) -> Vec<AuthorRow> {
    let target = if r#ref.is_empty() { "HEAD" } else { r#ref };
    let out = run(Some(repo), &[s("shortlog"), s("-sne"), s(target)]).await.stdout;
    let mut rows = Vec::new();
    for line in out.split('\n') {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        // 形如:   123\tName <mail@example.com>
        let (count_s, rest) = match t.split_once('\t') {
            Some(v) => v,
            None => match t.split_once(' ') {
                Some(v) => v,
                None => continue,
            },
        };
        let count: i64 = count_s.trim().parse().unwrap_or(0);
        let (name, email) = if let Some(i) = rest.rfind('<') {
            let name = rest[..i].trim().to_string();
            let email = rest[i + 1..].trim_end_matches('>').trim().to_string();
            (name, email)
        } else {
            (rest.trim().to_string(), String::new())
        };
        rows.push(AuthorRow { count, name, email });
    }
    rows
}

pub async fn status(repo: &str) -> StatusOut {
    let r = run(Some(repo), &[s("status"), s("--porcelain=v1"), s("-uno"), s("--branch")]).await;
    let mut head = String::new();
    let mut files = Vec::new();
    for line in r.stdout.split('\n').filter(|l| !l.is_empty()) {
        if line.starts_with("## ") {
            head = line.to_string();
        } else if line.len() > 3 {
            files.push(StatusFile {
                status: line[..2].trim().to_string(),
                path: line[3..].to_string(),
            });
        }
    }
    let stash = run(Some(repo), &[s("stash"), s("list"), s("--format=%gd%x00%gs")]).await.stdout;
    let stashes = stash
        .split('\n')
        .filter(|l| !l.is_empty())
        .map(|l| {
            let mut it = l.splitn(2, '\0');
            (
                it.next().unwrap_or("").to_string(),
                it.next().unwrap_or("").to_string(),
            )
        })
        .collect();
    StatusOut { head, files, stashes }
}

/* -------------------------------- 同步远端 -------------------------------- */

pub async fn fetch_all(repo: &str) -> Result<(), String> {
    let out = run_timeout(
        Some(repo),
        &[s("fetch"), s("--all"), s("--prune"), s("--no-tags")],
        180,
    )
    .await;
    if out.ok {
        Ok(())
    } else {
        Err(clean_err(&out.stderr))
    }
}

/// 只做快进拉取（--ff-only），绝不产生合并提交或冲突
pub async fn pull_ff(repo: &str) -> Result<String, String> {
    let up = run(
        Some(repo),
        &[
            s("rev-parse"),
            s("--abbrev-ref"),
            s("--symbolic-full-name"),
            s("@{upstream}"),
        ],
    )
    .await;
    let upstream = up.stdout.trim().to_string();
    if !up.ok || upstream.is_empty() {
        return Err("当前分支没有设置上游分支，无法拉取".into());
    }

    let branch = current_branch(repo).await;
    let before = run(Some(repo), &[s("rev-parse"), s("HEAD")])
        .await
        .stdout
        .trim()
        .to_string();
    let out = run_timeout(Some(repo), &[s("pull"), s("--ff-only"), s("--no-edit")], 180).await;
    if !out.ok {
        let err = clean_err(&out.stderr);
        let hint = if err.contains("Not possible to fast-forward") || err.contains("diverging") {
            "本地有未推送的提交，无法快进；请先处理本地提交"
        } else if err.contains("local changes") || err.contains("would be overwritten") {
            "工作区有未提交改动，可能被覆盖；先提交或 stash 再拉取"
        } else {
            ""
        };
        return Err(if hint.is_empty() { err } else { format!("{hint}（{err}）") });
    }

    let after = run(Some(repo), &[s("rev-parse"), s("HEAD")])
        .await
        .stdout
        .trim()
        .to_string();
    if before == after {
        Ok(format!("{branch} 已是最新（{}）", &upstream))
    } else {
        let short = if after.len() >= 7 { &after[..7] } else { &after };
        Ok(format!("{branch} 已快进到 {short}"))
    }
}

/* -------------------------------- 删除分支 -------------------------------- */

#[derive(Debug, Clone)]
pub struct DeleteItem {
    pub name: String,
    pub remote: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeleteResult {
    pub name: String,
    pub ok: bool,
    pub error: String,
}

pub async fn delete_branches(
    repo: &str,
    items: &[DeleteItem],
    force: bool,
    delete_remote: bool,
    remove_worktrees: bool,
) -> Vec<DeleteResult> {
    let cur = current_branch(repo).await;
    let remotes = list_remotes(repo).await;
    let base = detect_base(repo).await;
    let mut out = Vec::new();

    for item in items {
        let name = item.name.clone();
        if item.remote {
            if !delete_remote {
                out.push(DeleteResult { name, ok: false, error: "未勾选删除远端分支".into() });
                continue;
            }
            let remote = remotes.iter().find(|r| name.starts_with(&format!("{r}/"))).cloned();
            let Some(remote) = remote else {
                out.push(DeleteResult { name, ok: false, error: "无法识别远端".into() });
                continue;
            };
            let branch = name[remote.len() + 1..].to_string();
            let base_short = base.rsplit('/').next().unwrap_or(&base).to_string();
            if branch == base_short || is_protected(&branch) {
                out.push(DeleteResult { name, ok: false, error: "受保护分支，拒绝删除".into() });
                continue;
            }
            let r = run(Some(repo), &[s("push"), s(&remote), s("--delete"), s(&branch)]).await;
            out.push(DeleteResult {
                name,
                ok: r.ok,
                error: if r.ok { String::new() } else { clean_err(&r.stderr) },
            });
            continue;
        }

        if name == cur {
            out.push(DeleteResult { name, ok: false, error: "当前所在分支，不能删除".into() });
            continue;
        }
        if name == base || is_protected(&name) {
            out.push(DeleteResult { name, ok: false, error: "受保护分支，拒绝删除".into() });
            continue;
        }
        let flag = if force { "-D" } else { "-d" };
        let mut r = run(Some(repo), &[s("branch"), s(flag), s(&name)]).await;

        // 分支被某个 worktree 检出时，git 会拒绝删除：按需先移除 worktree 再重试
        if !r.ok && r.stderr.to_lowercase().contains("used by worktree") {
            let wts = list_worktrees(repo).await;
            let target = wts.iter().find(|w| w.branch == name).cloned();
            match target {
                None => {}
                Some(w) if w.main => {
                    out.push(DeleteResult {
                        name,
                        ok: false,
                        error: "该分支在主工作区检出，无法删除".into(),
                    });
                    continue;
                }
                Some(w) => {
                    if !remove_worktrees {
                        out.push(DeleteResult {
                            name,
                            ok: false,
                            error: format!("被 worktree 占用：{}；勾选「同时移除 worktree」后可删除", w.path),
                        });
                        continue;
                    }
                    let wp = w.path.clone();
                    let exists = std::path::Path::new(&wp).exists();
                    if exists {
                        let rm = run(
                            Some(repo),
                            &[s("worktree"), s("remove"), s("--force"), s(&wp)],
                        )
                        .await;
                        if !rm.ok {
                            out.push(DeleteResult {
                                name,
                                ok: false,
                                error: format!("移除 worktree 失败：{}", clean_err(&rm.stderr)),
                            });
                            continue;
                        }
                    } else {
                        let _ = run(Some(repo), &[s("worktree"), s("prune")]).await;
                    }
                    r = run(Some(repo), &[s("branch"), s(flag), s(&name)]).await;
                }
            }
        }

        out.push(DeleteResult {
            name,
            ok: r.ok,
            error: if r.ok { String::new() } else { clean_err(&r.stderr) },
        });
    }
    out
}
