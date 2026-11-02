//! The `chat.send` completion stream: consumes the gateway workflow's
//! `StreamEvent` frames for a plain (tool-less) completion and maps them
//! onto the engine protocol's `chat.*` events for the CLI's `chat` verb.

use crate::cloud::CloudError;
use futures::{Stream, StreamExt};
use protocol::api::StreamEvent;
use protocol::rpc::Event;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use uuid::Uuid;

/// Drives one plain completion: deltas accumulate into one `chat.delta`
/// carrying the full text, emitted with `chat.done` when the Done frame
/// arrives; the Done info comes back for the RPC reply.
pub(crate) async fn drive_chat(
    events: broadcast::Sender<Value>,
    stream: impl Stream<Item = Result<StreamEvent, CloudError>>,
) -> Result<(Uuid, f64, u32, u32), CloudError> {
    let mut stream = std::pin::pin!(stream);
    let mut text = String::new();
    while let Some(item) = stream.next().await {
        match item? {
            StreamEvent::Delta { content } => text.push_str(&content),
            StreamEvent::Done {
                message_id,
                cost_usd,
                tokens_in,
                tokens_out,
            } => {
                let _ = events.send(
                    serde_json::to_value(Event::new("chat.delta", json!({ "content": text })))
                        .expect("event serializes"),
                );
                let _ = events.send(
                    serde_json::to_value(Event::new(
                        "chat.done",
                        json!({
                            "message_id": message_id,
                            "cost_usd": cost_usd,
                            "tokens_in": tokens_in,
                            "tokens_out": tokens_out,
                        }),
                    ))
                    .expect("event serializes"),
                );
                return Ok((message_id, cost_usd, tokens_in, tokens_out));
            }
            StreamEvent::Error { code, message } => {
                return Err(CloudError::Request(format!(
                    "stream error [{code}]: {message}"
                )))
            }
            // Plain completions request no tools; the remaining frame kinds
            // (reasoning, argument deltas, attach idle marker, approval
            // lifecycle) are not part of this surface.
            _ => {}
        }
    }
    Err(CloudError::Request(
        "stream ended without done event".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream;

    /// drive_chat (chat.send's completion path): deltas accumulate into one
    /// chat.delta (the full text — the plain-completion surface), Done maps
    /// to chat.done and comes back for the RPC reply, non-chat frames are
    /// ignored, and an Error frame (or a stream that ends without Done) is
    /// an error.
    #[tokio::test]
    async fn drive_chat_accumulates_text_and_returns_the_done_info() {
        let (events, mut events_rx) = broadcast::channel(64);
        let mid = Uuid::now_v7();
        let frames: Vec<Result<StreamEvent, CloudError>> = vec![
            Ok(StreamEvent::Delta {
                content: "hi ".into(),
            }),
            Ok(StreamEvent::ThinkingDelta {
                content: "hmm".into(),
            }),
            Ok(StreamEvent::Delta {
                content: "there".into(),
            }),
            Ok(StreamEvent::Done {
                message_id: mid,
                cost_usd: 0.02,
                tokens_in: 5,
                tokens_out: 3,
            }),
        ];
        let (message_id, cost_usd, tokens_in, tokens_out) =
            drive_chat(events, stream::iter(frames)).await.unwrap();
        assert_eq!(message_id, mid);
        assert_eq!(cost_usd, 0.02);
        assert_eq!((tokens_in, tokens_out), (5, 3));

        let first = events_rx.recv().await.unwrap();
        assert_eq!(first["event"], "chat.delta");
        assert_eq!(first["payload"]["content"], "hi there");
        let second = events_rx.recv().await.unwrap();
        assert_eq!(second["event"], "chat.done");
        assert_eq!(second["payload"]["message_id"], json!(mid.to_string()));
        assert_eq!(second["payload"]["tokens_out"], 3);
    }

    #[tokio::test]
    async fn drive_chat_maps_error_frames_and_stream_without_done() {
        let (events, _events_rx) = broadcast::channel(64);
        let frames: Vec<Result<StreamEvent, CloudError>> = vec![Ok(StreamEvent::Error {
            code: "model".into(),
            message: "boom".into(),
        })];
        let err = drive_chat(events.clone(), stream::iter(frames))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("boom"), "{err}");

        let frames: Vec<Result<StreamEvent, CloudError>> = vec![Ok(StreamEvent::Delta {
            content: "partial".into(),
        })];
        let err = drive_chat(events, stream::iter(frames)).await.unwrap_err();
        assert!(err.to_string().contains("without done"), "{err}");
    }
}
