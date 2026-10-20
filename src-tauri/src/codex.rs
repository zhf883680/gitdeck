//! 调用本地 codex CLI，把差异解释以 SSE 流式推给前端。
//!
//! codex 的输出分两路：最终消息在 stdout，完整过程（含模型正文、工具调用）在 stderr。
//! 这里以 stderr 的 `codex` 段落作为流式正文，结束时用 `-o` 落盘文件做权威校正。

use axum::response::sse::{Event, KeepAlive, Sse};
use serde_json::{json, Value};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

fn codex_bin() -> PathBuf {
    if let Ok(p) = std::env::var("GITDECK_CODEX") {
        if Path::new(&p).exists() {
            return PathBuf::from(p);
        }
    }

    // 顺着 PATH 找（GUI 启动的 .app 已在启动时补全 PATH）
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in ["codex", "codex.exe", "codex.cmd"] {
                let c = dir.join(name);
                if c.is_file() {
                    return c;
                }
            }
        }
    }

    // 常见安装位置兜底
    let mut guesses: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let h = PathBuf::from(home);
        guesses.push(h.join(".local/bin/codex"));
        guesses.push(h.join(".bun/bin/codex"));
        guesses.push(h.join(".volta/bin/codex"));
        guesses.push(h.join(".npm-global/bin/codex"));
        guesses.push(h.join(".asdf/shims/codex"));
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            guesses.insert(0, PathBuf::from(appdata).join("npm").join("codex.cmd"));
        }
    }
    for g in guesses {
        if g.is_file() {
            return g;
        }
    }
    PathBuf::from("codex")
}

fn build_prompt(body: &Value) -> String {
    let s = |k: &str| body.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mode = s("mode");
    let repo = s("repo");
    let base = s("base");
    let head = s("head");
    let sha = s("sha");
    let file = s("file");
    let question = s("question");

    let mut lines: Vec<String> = Vec::new();
    lines.push("你是一名资深代码审查者，正在帮助工程师快速理解一次代码变更。".into());
    lines.push(format!("仓库路径：{repo}"));
    lines.push("你可以用只读的 git / shell 命令进一步查看细节（例如 git diff、git log、读源文件）。".into());
    lines.push(String::new());

    match mode.as_str() {
        "branch" => lines.push(format!(
            "任务：解释分支 {head} 相对基准分支 {base} 的差异（等价于 git diff {base}...{head}）。"
        )),
        "commit" => lines.push(format!("任务：解释提交 {sha} 改了什么、为什么可能这样改。")),
        "file" => lines.push(format!("任务：解释 {file} 在 {base}...{head} 之间的差异。")),
        _ => lines.push("任务：回答工程师的问题。".into()),
    }
    lines.push(String::new());

    if let Some(stats) = body.get("stats") {
        let n = |k: &str| stats.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
        lines.push(format!(
            "变更规模：{} 个文件，+{} / -{}。",
            n("files"),
            n("adds"),
            n("dels")
        ));
    }
    if let Some(commits) = body.get("commits").and_then(|v| v.as_array()) {
        if !commits.is_empty() {
            lines.push(String::new());
            lines.push("提交列表（新→旧）：".into());
            for c in commits.iter().take(40) {
                let g = |k: &str| c.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
                lines.push(format!("- {} {}: {}", g("short"), g("author"), g("subject")));
            }
            if commits.len() > 40 {
                lines.push(format!("- …另有 {} 个提交", commits.len() - 40));
            }
        }
    }
    if let Some(files) = body.get("files").and_then(|v| v.as_array()) {
        if !files.is_empty() {
            lines.push(String::new());
            lines.push("改动文件：".into());
            for f in files.iter().take(80) {
                let g = |k: &str| f.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
                let adds = f.get("adds").and_then(|v| v.as_i64());
                let dels = f.get("dels").and_then(|v| v.as_i64());
                lines.push(format!(
                    "- [{}] {} (+{}/-{})",
                    g("status"),
                    g("path"),
                    adds.map(|v| v.to_string()).unwrap_or_else(|| "?".into()),
                    dels.map(|v| v.to_string()).unwrap_or_else(|| "?".into())
                ));
            }
            if files.len() > 80 {
                lines.push(format!("- …另有 {} 个文件", files.len() - 80));
            }
        }
    }

    if !question.is_empty() {
        lines.push(String::new());
        lines.push("工程师的问题：".into());
        lines.push(question);
        lines.push(String::new());
        lines.push("请先给出直接结论，再展开依据。用简体中文回答。".into());
    } else {
        lines.push(String::new());
        lines.push("请用简体中文输出 Markdown，严格按以下结构，不要用代码块包裹整段回答：".into());
        lines.push("## 一句话结论".into());
        lines.push("## 这个分支做了什么（3-6 条要点）".into());
        lines.push("## 关键改动（按文件/模块说明，指出重要函数或逻辑）".into());
        lines.push("## 风险与可疑点（边界条件、兼容性、安全、性能、缺失的测试）".into());
        lines.push("## 建议的审查动作（具体到该看哪几个文件）".into());
    }
    lines.join("\n")
}

fn make_command(repo: &str, tmp: &Path, prompt_len: usize) -> tokio::process::Command {
    let bin = codex_bin();
    let args: Vec<String> = vec![
        "exec".into(),
        "--color".into(),
        "never".into(),
        "-s".into(),
        "read-only".into(),
        "--ephemeral".into(),
        "-C".into(),
        repo.to_string(),
        "-o".into(),
        tmp.to_string_lossy().to_string(),
        "-".into(),
    ];
    let _ = prompt_len;

    // Windows 上 npm 全局安装的是 codex.cmd，需要用 cmd /C 启动
    #[cfg(windows)]
    {
        let is_shim = bin
            .extension()
            .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
            .unwrap_or(false);
        let mut c = if is_shim {
            let mut c = tokio::process::Command::new("cmd.exe");
            c.arg("/C").arg(&bin);
            c
        } else {
            tokio::process::Command::new(&bin)
        };
        c.args(&args);
        c.current_dir(repo);
        crate::git::no_window(&mut c);
        return c;
    }

    #[cfg(not(windows))]
    {
        let mut c = tokio::process::Command::new(&bin);
        c.args(&args);
        c.current_dir(repo);
        c
    }
}

async fn send(tx: &mpsc::Sender<Event>, event: &str, data: Value) -> bool {
    tx.send(Event::default().event(event).json_data(data).unwrap_or_default())
        .await
        .is_ok()
}

async fn run_codex(repo: String, prompt: String, tx: mpsc::Sender<Event>) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("gitdeck-codex-{stamp}.txt"));

    let mut cmd = make_command(&repo, &tmp, prompt.len());
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .kill_on_drop(true);

    if !send(&tx, "status", json!({"text": "正在调用本地 codex…", "cmd": "codex exec -s read-only"})).await {
        return;
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let hint = if e.kind() == std::io::ErrorKind::NotFound {
                "没有找到 codex 命令。请先安装并登录：\n\n  npm i -g @openai/codex\n  codex login\n\n若已安装，可用环境变量 GITDECK_CODEX=/path/to/codex 指定路径。"
            } else {
                "无法启动 codex"
            };
            send(&tx, "error", json!({ "text": format!("{hint}（{e}）") })).await;
            return;
        }
    };

    // 提示词走 stdin，避开命令行引号/长度问题
    if let Some(mut si) = child.stdin.take() {
        let data = prompt.into_bytes();
        tokio::spawn(async move {
            let _ = si.write_all(&data).await;
            let _ = si.shutdown().await;
        });
    }

    // stdout 只承载最终消息，单独抽干避免管道阻塞
    let stdout_task = child.stdout.take().map(|mut out| {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut out, &mut buf).await;
            String::from_utf8_lossy(&buf).to_string()
        })
    });

    let stderr = match child.stderr.take() {
        Some(e) => e,
        None => {
            send(&tx, "error", json!({"text": "无法读取 codex 输出"})).await;
            return;
        }
    };

    let mut lines = BufReader::new(stderr).lines();
    let mut phase = "banner"; // banner -> prompt -> body -> done
    let mut saw_body = false;
    let mut closed = false;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(900);
    // 前端断开（关闭抽屉/点停止）时 tx 会被 drop，这里立刻感知并杀掉 codex，
    // 否则 codex 在思考期间不写 stderr，要等下一次输出才发现连接没了。
    let closed_fut = tx.closed();
    tokio::pin!(closed_fut);

    loop {
        let next = tokio::select! {
            _ = &mut closed_fut => {
                closed = true;
                break;
            }
            r = tokio::time::timeout_at(deadline, lines.next_line()) => r,
        };
        let line = match next {
            Ok(Ok(Some(l))) => l,
            Ok(Ok(None)) => break,
            Ok(Err(_)) => break,
            Err(_) => {
                let _ = send(&tx, "error", json!({"text": "codex 运行超时（15 分钟），已终止"})).await;
                let _ = child.kill().await;
                closed = true;
                break;
            }
        };

        let raw = line.strip_suffix('\r').unwrap_or(&line).to_string();
        let t = raw.trim().to_string();

        if phase == "banner" {
            if t == "user" {
                phase = "prompt";
            }
            continue;
        }
        if phase == "prompt" {
            if t == "codex" {
                phase = "body";
                saw_body = true;
            }
            continue;
        }
        if phase != "body" {
            continue;
        }

        if t.is_empty() {
            if !send(&tx, "delta", json!({"text": ""})).await {
                closed = true;
                break;
            }
            continue;
        }
        if t.starts_with("hook: ") {
            continue;
        }
        if t == "tokens used" || t == "--------" {
            phase = "done";
            continue;
        }
        if t == "codex" {
            continue;
        }
        if t.starts_with("exec ")
            || t.starts_with("mcp:")
            || t.starts_with("apply_patch")
            || t.starts_with("shell")
            || t.to_lowercase().starts_with("thinking")
            || t.starts_with("tool:")
        {
            if !send(&tx, "log", json!({ "text": t })).await {
                closed = true;
                break;
            }
            continue;
        }
        if !send(&tx, "delta", json!({ "text": raw })).await {
            closed = true;
            break;
        }
    }

    if closed {
        // 前端已断开：别让 codex 继续跑
        let _ = child.kill().await;
        let _ = tokio::fs::remove_file(&tmp).await;
        return;
    }

    let code = child.wait().await.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    let mut final_text = tokio::fs::read_to_string(&tmp).await.unwrap_or_default();
    if final_text.trim().is_empty() {
        if let Some(t) = stdout_task {
            final_text = t.await.unwrap_or_default();
        }
    }
    let _ = tokio::fs::remove_file(&tmp).await;

    if !final_text.trim().is_empty() {
        send(&tx, "final", json!({ "text": final_text.trim(), "code": code })).await;
    } else if !saw_body {
        send(
            &tx,
            "error",
            json!({ "text": format!("codex 没有返回内容（退出码 {code}）。检查一下是否已登录：codex login") }),
        )
        .await;
    } else {
        send(&tx, "final", json!({ "text": "", "code": code })).await;
    }
    send(&tx, "done", json!({ "code": code })).await;
}

pub async fn handle(
    repo: String,
    body: Value,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let prompt = body
        .get("prompt")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| build_prompt(&body));

    let (tx, rx) = mpsc::channel::<Event>(128);
    tokio::spawn(run_codex(repo, prompt, tx));

    let stream = ReceiverStream::new(rx).map(Ok::<_, Infallible>);
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}
