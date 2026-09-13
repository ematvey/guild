use futures::StreamExt;
use guild_core::provider::anthropic::AnthropicProvider;
use guild_core::provider::openai::OpenAiProvider;
use guild_core::provider::{ModelProvider, ProviderChunk, ProviderRequest};
use protocol::api::{Message, ToolSpec};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Collision-proof loopback listener: skip ports referenced in /proc/net/tcp{,6}
/// (docker-proxy wildcard binds are invisible to bind(0) with SO_REUSEADDR).
async fn standalone_listener() -> tokio::net::TcpListener {
    loop {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut ports = std::collections::HashSet::<u16>::new();
        for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(content) = std::fs::read_to_string(path) {
                for line in content.lines().skip(1) {
                    let fields: Vec<&str> = line.split_whitespace().collect();
                    if fields.len() > 1 {
                        if let Some(p) = fields[1].rsplit(':').next().and_then(|p| p.parse().ok()) {
                            ports.insert(p);
                        }
                    }
                }
            }
        }
        if !ports.contains(&port) {
            return listener;
        }
    }
}

fn sse(body: &str) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .insert_header("content-type", "text/event-stream")
        .set_body_string(body)
}

#[tokio::test]
async fn openai_tool_call_fragments_assemble() {
    let server = MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(sse(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"pa\"}}]}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"th\\\":\\\"a.rs\\\"}\"}}]}}]}\n\n\
             data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n\
             data: [DONE]\n\n",
        ))
        .mount(&server)
        .await;

    let p = OpenAiProvider::new();
    let msgs = vec![Message::user("read a.rs")];
    let req = ProviderRequest {
        model: "m",
        system: None,
        messages: &msgs,
        api_key: "k",
        base_url: &server.uri(),
        tools: Some(&[]),
        max_tokens: 0,
    };
    let stream = p.chat_stream(req).await.unwrap();
    let chunks: Vec<ProviderChunk> = stream.map(|r| r.unwrap()).collect().await;
    let done: Vec<_> = chunks
        .iter()
        .filter_map(|c| match c {
            ProviderChunk::ToolCallDone { call } => Some(call.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].id, "c1");
    assert_eq!(done[0].name, "read_file");
    assert_eq!(done[0].arguments, serde_json::json!({"path": "a.rs"}));
}

#[tokio::test]
async fn anthropic_tool_call_blocks_assemble() {
    let server = MockServer::builder()
        .listener(standalone_listener().await.into_std().unwrap())
        .start()
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(sse(
            "event: message_start\n\
             data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3}}}\n\n\
             event: content_block_start\n\
             data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t9\",\"name\":\"read_file\"}}\n\n\
             event: content_block_delta\n\
             data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\": \\\"a.rs\\\"}\"}}\n\n\
             event: content_block_stop\n\
             data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        ))
        .mount(&server)
        .await;

    let p = AnthropicProvider::new();
    let msgs = vec![Message::user("read a.rs")];
    let req = ProviderRequest {
        model: "m",
        system: None,
        messages: &msgs,
        api_key: "k",
        base_url: &server.uri(),
        tools: Some(&[ToolSpec {
            name: "read_file".into(),
            description: "d".into(),
            parameters: serde_json::json!({"type": "object"}),
        }]),
        max_tokens: 0,
    };
    let stream = p.chat_stream(req).await.unwrap();
    let chunks: Vec<ProviderChunk> = stream.map(|r| r.unwrap()).collect().await;
    let done: Vec<_> = chunks
        .iter()
        .filter_map(|c| match c {
            ProviderChunk::ToolCallDone { call } => Some(call.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].id, "t9");
    assert_eq!(done[0].arguments, serde_json::json!({"path": "a.rs"}));
    assert!(chunks
        .iter()
        .any(|c| matches!(c, ProviderChunk::Text(g) if g.tokens_in == Some(3))));
}
