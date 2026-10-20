//! 配置读写 + 原生目录选择框

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Config {
    #[serde(default)]
    pub roots: Vec<String>,
    #[serde(default)]
    pub pins: Vec<String>,
    #[serde(default, rename = "lastRepo")]
    pub last_repo: Option<String>,
    #[serde(default)]
    pub hidden: Vec<String>,
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn config_path() -> PathBuf {
    home().join(".gitdeck.json")
}

const DEFAULT_ROOTS: &[&str] = &[
    "code",
    "Projects",
    "Documents/GitHub",
    "dev",
    "workspace",
    "git",
    "repos",
];

pub fn load() -> Config {
    let raw = std::fs::read_to_string(config_path()).unwrap_or_default();
    let mut cfg: Config = serde_json::from_str(&raw).unwrap_or_default();
    cfg.roots.retain(|r| !r.trim().is_empty());
    if cfg.roots.is_empty() {
        for r in DEFAULT_ROOTS {
            let p = home().join(r);
            if p.exists() {
                cfg.roots.push(p.to_string_lossy().to_string());
            }
        }
        if cfg.roots.is_empty() {
            cfg.roots.push(home().to_string_lossy().to_string());
        }
    }
    // 去重
    let mut seen = std::collections::HashSet::new();
    cfg.roots.retain(|r| seen.insert(r.clone()));
    let mut seen2 = std::collections::HashSet::new();
    cfg.pins.retain(|r| seen2.insert(r.clone()));
    cfg
}

pub fn save(cfg: &Config) {
    if let Ok(text) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::create_dir_all(home());
        let _ = std::fs::write(config_path(), text);
    }
}

/// 弹系统文件夹选择框；返回 Ok(None) 表示用户取消。
pub async fn pick_directory() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let out = tokio::process::Command::new("osascript")
            .arg("-e")
            .arg("POSIX path of (choose folder with prompt \"选择代码根目录或 Git 仓库\")")
            .output()
            .await
            .map_err(|e| format!("无法打开目录选择框：{e}"))?;
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().trim_end_matches('/').to_string();
            return Ok(if p.is_empty() { None } else { Some(p) });
        }
        let msg = String::from_utf8_lossy(&out.stderr).to_string();
        if msg.contains("User canceled") || msg.contains("-128") {
            return Ok(None);
        }
        return Err(format!("无法打开目录选择框：{}", msg.trim()));
    }

    #[cfg(windows)]
    {
        let script = [
            "Add-Type -AssemblyName System.Windows.Forms | Out-Null;",
            "$d = New-Object System.Windows.Forms.FolderBrowserDialog;",
            "$d.Description = '选择代码根目录或 Git 仓库';",
            "$d.ShowNewFolderButton = $true;",
            "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath } else { Write-Output '' }",
        ]
        .join(" ");
        for (exe, extra) in [("powershell.exe", vec!["-NoProfile", "-STA"]), ("pwsh", vec!["-NoProfile"])] {
            let mut cmd = tokio::process::Command::new(exe);
            crate::git::no_window(&mut cmd);
            cmd.args(&extra).arg("-Command").arg(&script);
            match cmd.output().await {
                Ok(out) => {
                    if !out.status.success() {
                        continue;
                    }
                    let p = String::from_utf8_lossy(&out.stdout).trim().trim_end_matches('\\').to_string();
                    return Ok(if p.is_empty() { None } else { Some(p) });
                }
                Err(_) => continue,
            }
        }
        return Err("无法打开目录选择框，请手动输入路径".into());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let out = tokio::process::Command::new("zenity")
            .args(["--file-selection", "--directory", "--title=选择代码根目录或 Git 仓库"])
            .output()
            .await;
        match out {
            Ok(o) if o.status.success() => {
                let p = String::from_utf8_lossy(&o.stdout).trim().trim_end_matches('/').to_string();
                Ok(if p.is_empty() { None } else { Some(p) })
            }
            Ok(_) => Ok(None),
            Err(_) => Err("没有找到 zenity，请手动输入路径".into()),
        }
    }
}
