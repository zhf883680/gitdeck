fn main() {
    // 前端资源通过 include_dir! 编进二进制，改动后需要重新编译
    println!("cargo:rerun-if-changed=../public");
    tauri_build::build()
}
