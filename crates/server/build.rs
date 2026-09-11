use std::path::Path;

fn main() {
    // The web dist dir must exist at compile time (include_dir). When the
    // frontend hasn't been built, embed an empty dir and the server serves a
    // 503 hint instead.
    let chat_dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/dist");
    std::fs::create_dir_all(&chat_dist).expect("create web dist dir");
    println!("cargo:rerun-if-changed={}", chat_dist.display());
}
