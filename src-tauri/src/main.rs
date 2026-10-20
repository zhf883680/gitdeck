// gitdeck 桌面外壳：内置 Rust HTTP 服务（axum）+ 系统 WebView，无外部运行时依赖。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod codex;
mod config;
mod git;

#[cfg(unix)]
use std::process::Stdio;
#[cfg(unix)]
use std::time::Duration;
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// 从登录 shell 取回完整 PATH。
/// 从 Finder 启动的 .app 只继承 launchd 的最小 PATH（/usr/bin:/bin:...），
/// 不含 /opt/homebrew/bin 等目录，会导致找不到 codex / 新版 git。
fn fix_path_from_login_shell() {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            for flag in ["-lic", "-lc"] {
                if let Ok(out) = std::process::Command::new(&shell)
                    .args([flag, "printf %s \"$PATH\""])
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .output()
                {
                    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if p.contains("/bin") {
                        let _ = tx.send(p);
                        return;
                    }
                }
            }
            let _ = tx.send(String::new());
        });

        if let Ok(login_path) = rx.recv_timeout(Duration::from_secs(3)) {
            if login_path.is_empty() {
                return;
            }
            let current = std::env::var("PATH").unwrap_or_default();
            let mut seen = std::collections::HashSet::new();
            let mut parts: Vec<&str> = Vec::new();
            for p in login_path.split(':').chain(current.split(':')) {
                if !p.is_empty() && seen.insert(p.to_string()) {
                    parts.push(p);
                }
            }
            std::env::set_var("PATH", parts.join(":"));
        }
    }
}

fn main() {
    fix_path_from_login_shell();
    // `gitdeck --serve 7318`：只跑接口服务，便于用 curl 调试 / 对拍
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--serve") {
        let port: u16 = args.get(i + 1).and_then(|p| p.parse().ok()).unwrap_or(7318);
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("无法创建 runtime");
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
                .await
                .expect("端口占用");
            println!("gitdeck server → http://127.0.0.1:{port}");
            let _ = axum::serve(listener, api::router()).await;
        });
        return;
    }

    tauri::Builder::default()
        .setup(|app| {
            let port = tauri::async_runtime::block_on(async {
                let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
                let port = listener.local_addr()?.port();
                tauri::async_runtime::spawn(async move {
                    let _ = axum::serve(listener, api::router()).await;
                });
                Ok::<u16, std::io::Error>(port)
            })?;

            let url: tauri::Url = format!("http://127.0.0.1:{port}")
                .parse()
                .expect("端口地址异常");

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("gitdeck")
                .inner_size(1460.0, 940.0)
                .min_inner_size(1040.0, 620.0)
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("gitdeck 启动失败")
        .run(|_app, _event| {});
}
