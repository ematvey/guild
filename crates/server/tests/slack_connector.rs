//! Slack connector tests: wiremock fixtures with fake tokens — one happy
//! path, an auth-header assertion, and an error mapping per tool family
//! (Web API reads, chat.postMessage, incoming webhook).

use guild_server::integrations::{integration_by_name, Category};
use serde_json::json;
use wiremock::matchers::{body_json, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const FAKE_TOKEN: &str = "xoxb-fake-token";

/// Config pointing the Web API base at the mock server.
fn server_config(server: &MockServer) -> serde_json::Value {
    json!({ "base_url": server.uri() })
}

fn secrets_with(webhook: Option<&str>) -> Vec<(String, String)> {
    let mut secrets = vec![("bot_token".to_string(), FAKE_TOKEN.to_string())];
    if let Some(url) = webhook {
        secrets.push(("webhook_url".to_string(), url.to_string()));
    }
    secrets
}

#[tokio::test]
async fn conversations_list_maps_channels_and_sends_bearer() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/conversations.list"))
        .and(header("authorization", format!("Bearer {FAKE_TOKEN}")))
        .and(query_param("limit", "200"))
        .and(query_param("types", "public_channel,private_channel"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ok": true,
            "channels": [
                { "id": "C0123456789", "name": "general", "is_private": false,
                  "topic": { "value": "company-wide" } },
                { "id": "C9876543210", "name": "secret", "is_private": true,
                  "topic": { "value": "" } }
            ],
            "response_metadata": { "next_cursor": "" }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("slack").unwrap();
    assert_eq!(plugin.name(), "slack");
    assert_eq!(plugin.categories(), &[Category::Other]);

    let out = plugin
        .execute(&server_config(&server), "conversations_list", json!({}), &secrets_with(None), None)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_str(&out.content).unwrap();
    assert_eq!(body["channels"][0]["id"], "C0123456789");
    assert_eq!(body["channels"][0]["name"], "general");
    assert_eq!(body["channels"][0]["is_private"], false);
    assert_eq!(body["channels"][0]["topic"], "company-wide");
    assert_eq!(body["channels"][1]["name"], "secret");
    assert_eq!(body["channels"].as_array().unwrap().len(), 2);

    server.verify().await;
}

#[tokio::test]
async fn conversations_history_maps_messages_and_error_envelope() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/conversations.history"))
        .and(header("authorization", format!("Bearer {FAKE_TOKEN}")))
        .and(query_param("channel", "C0123456789"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ok": true,
            "messages": [
                { "ts": "1700000000.000100", "user": "U0AAA1111", "text": "hello world" },
                { "ts": "1700000001.000200", "user": "U0BBB2222", "text": "hi back" }
            ],
            "has_more": false,
            "response_metadata": { "next_cursor": "" }
        })))
        .expect(1)
        .mount(&server)
        .await;
    // Slack's error envelope rides on HTTP 200: `ok: false` maps to the
    // tool error carrying Slack's own error string.
    Mock::given(method("GET"))
        .and(path("/users.list"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "ok": false, "error": "invalid_auth" })),
        )
        .mount(&server)
        .await;

    let plugin = integration_by_name("slack").unwrap();

    let out = plugin
        .execute(
            &server_config(&server),
            "conversations_history",
            json!({ "channel": "C0123456789" }),
            &secrets_with(None), None)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_str(&out.content).unwrap();
    assert_eq!(body["messages"][0]["ts"], "1700000000.000100");
    assert_eq!(body["messages"][0]["user"], "U0AAA1111");
    assert_eq!(body["messages"][0]["text"], "hello world");
    assert_eq!(body["messages"].as_array().unwrap().len(), 2);
    assert_eq!(out.meta.as_ref().unwrap()["has_more"], false);

    let err = plugin
        .execute(&server_config(&server), "users_list", json!({}), &secrets_with(None), None)
        .await
        .unwrap_err();
    assert!(err.contains("invalid_auth"), "got: {err}");

    server.verify().await;
}

#[tokio::test]
async fn post_message_posts_json_with_bearer_and_maps_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat.postMessage"))
        .and(header("authorization", format!("Bearer {FAKE_TOKEN}")))
        .and(header("content-type", "application/json"))
        .and(body_json(json!({ "channel": "C0123456789", "text": "ship it" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ok": true,
            "channel": "C0123456789",
            "ts": "1700000002.000300"
        })))
        .expect(1)
        .mount(&server)
        .await;
    // A Slack error envelope on the write path maps to the tool error too.
    Mock::given(method("POST"))
        .and(path("/chat.postMessage"))
        .and(body_json(json!({ "channel": "C missing", "text": "x" })))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "ok": false, "error": "channel_not_found" })),
        )
        .mount(&server)
        .await;

    let plugin = integration_by_name("slack").unwrap();

    let out = plugin
        .execute(
            &server_config(&server),
            "post_message",
            json!({ "channel": "C0123456789", "text": "ship it" }),
            &secrets_with(None), None)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_str(&out.content).unwrap();
    assert_eq!(body["channel"], "C0123456789");
    assert_eq!(body["ts"], "1700000002.000300");

    let err = plugin
        .execute(
            &server_config(&server),
            "post_message",
            json!({ "channel": "C missing", "text": "x" }),
            &secrets_with(None), None)
        .await
        .unwrap_err();
    assert!(err.contains("channel_not_found"), "got: {err}");

    server.verify().await;
}


