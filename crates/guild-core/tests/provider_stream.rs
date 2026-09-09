use futures::StreamExt;
use guild_core::provider::anthropic::AnthropicProvider;
use guild_core::provider::openai::OpenAiProvider;
use guild_core::provider::{ModelProvider, ProviderRequest};
use protocol::api::Message;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn sse(body: &str) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .insert_header("content-type", "text/event-stream")
        .set_body_string(body)
}

#[tokio::test]
async fn openai_stream_yields_deltas_then_usage() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(sse(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}\n\n\
             data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n\
             data: [DONE]\n\n",
        ))
        .mount(&server)
        .await;

    let p = OpenAiProvider::new();
    let msgs = vec![Message::user("hi")];
    let req = ProviderRequest {
        model: "gpt-test",
        system: None,
        messages: &msgs,
        api_key: "sk-test",
        base_url: &server.uri(),
        tools: None,
    };
    let stream = p.chat_stream(req).await.unwrap();
    let chunks: Vec<_> = stream
        .map(|r| match r.unwrap() {
            guild_core::provider::ProviderChunk::Text(c) => c,
            other => panic!("unexpected chunk {other:?}"),
        })
        .collect()
        .await;
    let text: String = chunks.iter().map(|c| c.text_delta.as_str()).collect();
    assert_eq!(text, "Hello");
    assert_eq!(chunks.last().unwrap().tokens_in, Some(3));
    assert_eq!(chunks.last().unwrap().tokens_out, Some(2));
}

#[tokio::test]
async fn anthropic_stream_yields_deltas_then_usage() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .respond_with(sse(
            "event: message_start\n\
             data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":4}}}\n\n\
             event: content_block_delta\n\
             data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Salut\"}}\n\n\
             event: message_delta\n\
             data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":6}}\n\n",
        ))
        .mount(&server)
        .await;

    let p = AnthropicProvider::new();
    let msgs = vec![Message::user("hi")];
    let req = ProviderRequest {
        model: "claude-test",
        system: Some("be brief"),
        messages: &msgs,
        api_key: "ak-test",
        base_url: &server.uri(),
        tools: None,
    };
    let stream = p.chat_stream(req).await.unwrap();
    let chunks: Vec<_> = stream
        .map(|r| match r.unwrap() {
            guild_core::provider::ProviderChunk::Text(c) => c,
            other => panic!("unexpected chunk {other:?}"),
        })
        .collect()
        .await;
    let text: String = chunks.iter().map(|c| c.text_delta.as_str()).collect();
    assert_eq!(text, "Salut");
    assert_eq!(chunks[0].tokens_in, Some(4));
    assert_eq!(chunks.last().unwrap().tokens_out, Some(6));
}

#[tokio::test]
async fn provider_auth_error_is_mapped() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(401).set_body_string("bad key"))
        .mount(&server)
        .await;
    let p = OpenAiProvider::new();
    let msgs = vec![Message::user("hi")];
    let req = ProviderRequest {
        model: "m",
        system: None,
        messages: &msgs,
        api_key: "bad",
        base_url: &server.uri(),
        tools: None,
    };
    let err = p.chat_stream(req).await.err().unwrap();
    assert!(matches!(err, guild_core::ProviderError::Auth));
}
