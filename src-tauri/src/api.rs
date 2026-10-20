//! HTTP 接口层：路由与 handler，响应结构与旧版 Node 后端保持一致。

use axum::{
    extract::Query,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use include_dir::{include_dir, Dir};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use crate::config;
use crate::git::{self, DiffQuery, SearchQuery, SearchResult};

static PUBLIC: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../public");

type Q = HashMap<String, String>;
type ApiError = (StatusCode, Json<Value>);

fn bad(msg: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({ "ok": false, "error": msg.into() })))
}

fn okj<T: Serialize>(v: T) -> Json<Value> {
    let mut val = serde_json::to_value(v).unwrap_or(Value::Null);
    if let Value::Object(ref mut m) = val {
        m.insert("ok".into(), Value::Bool(true));
    }
    Json(val)
}

fn qs(q: &Q, key: &str) -> String {
    q.get(key).cloned().unwrap_or_default()
}

fn repo_param(q: &Q) -> String {
    qs(q, "path")
}

/* ------------------------------- 配置类 ------------------------------- */

async fn api_config() -> Json<Value> {
    let cfg = config::load();
    okj(json!({
        "roots": cfg.roots,
        "pins": cfg.pins,
        "lastRepo": cfg.last_repo,
        "hidden": cfg.hidden,
    }))
}

async fn api_repos() -> Json<Value> {
    let cfg = config::load();
    let scanned = git::scan_roots(&cfg.roots).await;

    // 置顶的按 pins 顺序排最前；即使它本来就在扫描结果里，也要提到前面
    let mut repos: Vec<git::RepoMeta> = Vec::new();
    for pin in &cfg.pins {
        if let Some(found) = scanned.iter().find(|r| &r.path == pin) {
            let mut m = found.clone();
            m.pinned = true;
            repos.push(m);
        } else if let Ok(top) = git::resolve_repo(pin).await {
            let mut m = git::repo_meta(&top).await;
            m.pinned = true;
            repos.push(m);
        }
    }
    let pinned_paths: HashSet<&String> = cfg.pins.iter().collect();
    for r in scanned {
        if !pinned_paths.contains(&r.path) {
            repos.push(r);
        }
    }
    okj(json!({
        "roots": cfg.roots,
        "pins": cfg.pins,
        "repos": repos,
        "lastRepo": cfg.last_repo,
    }))
}

async fn api_toggle_pin(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let raw = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let want = body.get("pinned").and_then(|v| v.as_bool()).unwrap_or(true);
    let abs = git::resolve_repo(raw).await.map_err(bad)?;

    let mut cfg = config::load();
    cfg.pins.retain(|p| p != &abs);
    if want {
        // 新置顶的排在最前面
        cfg.pins.insert(0, abs.clone());
    }
    config::save(&cfg);

    // 取消置顶后，如果它不在任何扫描根目录下，就会从列表里消失
    let under_root = cfg
        .roots
        .iter()
        .any(|r| std::path::Path::new(&abs).starts_with(r));

    Ok(okj(json!({
        "pins": cfg.pins,
        "path": abs,
        "pinned": want,
        "removedFromList": !want && !under_root,
    })))
}

async fn api_add_root(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let raw = body.get("root").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if raw.trim().is_empty() {
        return Err(bad("缺少目录路径"));
    }
    let abs = git::expand_path(&raw);
    if !std::path::Path::new(&abs).is_dir() {
        return Err(bad(format!("目录不存在: {abs}")));
    }
    let mut cfg = config::load();
    let mut added = json!(null);
    match git::resolve_repo(&abs).await {
        Ok(top) => {
            if !cfg.pins.contains(&top) {
                cfg.pins.push(top.clone());
            }
            added = json!({ "type": "repo", "path": top });
        }
        Err(_) => {
            if !cfg.roots.contains(&abs) {
                cfg.roots.push(abs.clone());
            }
            added = json!({ "type": "root", "path": abs });
        }
    }
    config::save(&cfg);
    Ok(okj(json!({ "roots": cfg.roots, "pins": cfg.pins, "added": added })))
}

async fn api_remove_root(Json(body): Json<Value>) -> Json<Value> {
    let raw = body.get("root").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut cfg = config::load();
    cfg.roots.retain(|r| r != &raw);
    cfg.pins.retain(|r| r != &raw);
    config::save(&cfg);
    okj(json!({ "roots": cfg.roots, "pins": cfg.pins }))
}

async fn api_pick_dir() -> Result<Json<Value>, ApiError> {
    match config::pick_directory().await {
        Ok(Some(p)) => Ok(okj(json!({ "path": p }))),
        Ok(None) => Ok(okj(json!({ "canceled": true }))),
        Err(e) => Err(bad(e)),
    }
}

/* ------------------------------- 仓库类 ------------------------------- */

async fn api_repo(Query(q): Query<Q>) -> Result<Json<Value>, ApiError> {
    let repo = git::resolve_repo(&repo_param(&q)).await.map_err(bad)?;
    let mut cfg = config::load();
    cfg.last_repo = Some(repo.clone());
    config::save(&cfg);

    let base = q.get("base").cloned().filter(|b| !b.is_empty());
    let report = git::branch_report(&repo, base.as_deref()).await;
    let st = git::status(&repo).await;
    let mut val = serde_json::to_value(&report).unwrap_or(Value::Null);
    if let Value::Object(ref mut m) = val {
        m.insert("status".into(), serde_json::to_value(&st).unwrap_or(Value::Null));
    }
    Ok(okj(val))
}

async fn api_branches(Query(q): Query<Q>) -> Result<Json<Value>, ApiError> {
    let repo = git::resolve_repo(&repo_param(&q)).await.map_err(bad)?;
    let base = q.get("base").cloned().filter(|b| !b.is_empty());
    let report = git::branch_report(&repo, base.as_deref()).await;
    Ok(okj(report))
}

async fn api_compare(Query(q): Query<Q>) -> Result<Json<Value>, ApiError> {
    let repo = git::resolve_repo(&repo_param(&q)).await.map_err(bad)?;
    let out = git::compare(&repo, &qs(&q, "base"), &qs(&q, "head")).await.map_err(bad)?;
    Ok(okj(out))
}

async fn api_diff(Query(q): Query<Q>) -> Result<Json<Value>, ApiError> {
    let repo = git::resolve_repo(&repo_param(&q)).await.map_err(bad)?;
    let dq = DiffQuery {
        base: qs(&q, "base"),
        head: qs(&q, "head"),
        sha: qs(&q, "sha"),
        file: qs(&q, "file"),
        mode: qs(&q, "mode"),
    };
    let out = git::get_diff(&repo, &dq).await.map_err(bad)?;
    Ok(okj(out))
}

async fn api_log(Query(q): Query<Q>) -> Result<Json<Value>, ApiError> {
    let repo = git::resolve_repo(&repo_param(&q)).await.map_err(bad)?;
    let limit: usize = qs(&q, "limit").parse().unwrap_or(200).clamp(1, 1000);
    let sq = SearchQuery {
        r#ref: qs(&q, "ref"),
        keyword: qs(&q, "keyword"),
        mode: {
            let m = qs(&q, "mode");
            if m.is_empty() { "message".into() } else { m }
        },
        author: qs(&q, "author"),
        path_filter: qs(&q, "pathFilter"),
        limit,
    };
    let mode = sq.mode.clone();
    let r = sq.r#ref.clone();
    let kw = sq.keyword.clone();
    match git::search_log(&repo, &sq).await.map_err(bad)? {
        SearchResult::Commits(cs) => Ok(okj(json!({
            "mode": mode, "ref": if r.is_empty() { "HEAD".to_string() } else { r },
            "keyword": kw, "commits": cs, "count": cs.len(),
        }))),
        SearchResult::Matches(ms) => Ok(okj(json!({
            "mode": mode, "ref": r, "keyword": kw,
            "matches": ms, "count": ms.len(), "overflow": ms.len() >= 500,
        }))),
    }
}

async fn api_commit(Query(q): Query<Q>) -> Result<Json<Value>, ApiError> {
    let repo = git::resolve_repo(&repo_param(&q)).await.map_err(bad)?;
    let out = git::commit_detail(&repo, &qs(&q, "sha")).await.map_err(bad)?;
    Ok(okj(out))
}

async fn api_filelog(Query(q): Query<Q>) -> Result<Json<Value>, ApiError> {
    let repo = git::resolve_repo(&repo_param(&q)).await.map_err(bad)?;
    let commits = git::file_history(&repo, &qs(&q, "file"), &qs(&q, "ref")).await.map_err(bad)?;
    Ok(okj(json!({ "file": qs(&q, "file"), "commits": commits })))
}

async fn api_authors(Query(q): Query<Q>) -> Result<Json<Value>, ApiError> {
    let repo = git::resolve_repo(&repo_param(&q)).await.map_err(bad)?;
    let rows = git::authors(&repo, &qs(&q, "ref")).await;
    Ok(okj(json!({ "authors": rows })))
}

async fn api_status(Query(q): Query<Q>) -> Result<Json<Value>, ApiError> {
    let repo = git::resolve_repo(&repo_param(&q)).await.map_err(bad)?;
    Ok(okj(git::status(&repo).await))
}

/* ------------------------------- 删除分支 ------------------------------- */

async fn api_delete_branch(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let path = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let repo = git::resolve_repo(path).await.map_err(bad)?;
    let force = body.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
    let delete_remote = body.get("deleteRemote").and_then(|v| v.as_bool()).unwrap_or(false);
    let remove_worktrees = body.get("removeWorktrees").and_then(|v| v.as_bool()).unwrap_or(false);
    let items: Vec<git::DeleteItem> = body
        .get("branches")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| {
                    let name = x.get("name").and_then(|v| v.as_str())?.to_string();
                    let remote = x.get("remote").and_then(|v| v.as_bool()).unwrap_or(false);
                    Some(git::DeleteItem { name, remote })
                })
                .collect()
        })
        .unwrap_or_default();

    if items.is_empty() {
        return Err(bad("没有要删除的分支"));
    }
    let results = git::delete_branches(&repo, &items, force, delete_remote, remove_worktrees).await;
    Ok(okj(json!({ "results": results })))
}

/* ------------------------------- 静态资源 ------------------------------- */

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

async fn static_handler(uri: Uri) -> Response {
    let raw = uri.path().trim_start_matches('/');
    let rel = if raw.is_empty() { "index.html" } else { raw };
    match PUBLIC.get_file(rel) {
        Some(f) => (
            [
                (header::CONTENT_TYPE, content_type(rel)),
                (header::CACHE_CONTROL, "no-store"),
            ],
            f.contents(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn api_codex(
    Json(body): Json<Value>,
) -> Result<
    axum::response::sse::Sse<
        impl tokio_stream::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
    >,
    ApiError,
> {
    let repo = git::resolve_repo(
        body.get("repo").and_then(|v| v.as_str()).unwrap_or(""),
    )
    .await
    .map_err(bad)?;
    Ok(crate::codex::handle(repo, body).await)
}

pub fn router() -> Router {
    Router::new()
        .route("/api/config", get(api_config))
        .route("/api/config/roots", post(api_add_root))
        .route("/api/config/roots/remove", post(api_remove_root))
        .route("/api/pick-dir", post(api_pick_dir))
        .route("/api/repos", get(api_repos))
        .route("/api/repos/pin", post(api_toggle_pin))
        .route("/api/repo", get(api_repo))
        .route("/api/branches", get(api_branches))
        .route("/api/compare", get(api_compare))
        .route("/api/diff", get(api_diff))
        .route("/api/log", get(api_log))
        .route("/api/commit", get(api_commit))
        .route("/api/filelog", get(api_filelog))
        .route("/api/authors", get(api_authors))
        .route("/api/status", get(api_status))
        .route("/api/branch/delete", post(api_delete_branch))
        .route("/api/codex", post(api_codex))
        .fallback(static_handler)
}
