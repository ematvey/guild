#[tokio::main]
async fn main() -> anyhow::Result<()> {
    guild_server::main_entry().await
}
