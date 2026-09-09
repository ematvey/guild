//! JSON-RPC stdio loop: the UI-facing surface of the local engine (spec §3.2,
//! §6). M1 methods: `login`, `chat.send`; streaming arrives as `chat.delta` /
//! `chat.done` events before the response.

use crate::cloud::{collect_turn, CloudClient};
use crate::session_store::{save, StoredSession};
use anyhow::Context as _;
use protocol::api::Message;
use protocol::rpc::{Connection, Event, Message as RpcMessage, Request, Response, RpcError};
use std::io::{BufRead, Write};

#[derive(Default)]
pub struct Session {
    pub cloud: Option<CloudClient>,
    pub chat_id: Option<uuid::Uuid>,
    pub model: String,
    pub email: Option<String>,
}

/// Reads requests until EOF, handles them, writes responses/events to the
/// writer. Returns the (mutated) session and the writer back to the caller.
pub fn serve<R: BufRead, W: Write>(
    reader: R,
    writer: W,
    mut session: Session,
) -> anyhow::Result<(Session, W)> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let mut conn = Connection::new(reader, writer);
    loop {
        match conn.read_message() {
            None => break,
            Some(Err(e)) => {
                // Cannot attribute an id; emit an event so the UI can show it.
                conn.write_line(&Event::new(
                    "rpc.error",
                    serde_json::json!({"message": e.message}),
                ))?;
            }
            Some(Ok(RpcMessage::Request(req))) => {
                if !req.is_valid() {
                    conn.write_line(&Response::err(
                        req.id,
                        RpcError::new(RpcError::INVALID_REQUEST, "bad jsonrpc/protocol/version"),
                    ))?;
                    continue;
                }
                let resp = rt.block_on(handle(&conn, &mut session, &req));
                match resp {
                    Ok(resp) => conn.write_line(&resp)?,
                    Err(e) => conn.write_line(&Response::err(
                        req.id,
                        RpcError::new(RpcError::APP_BASE, e.to_string()),
                    ))?,
                }
            }
            Some(Ok(_)) => {
                conn.write_line(&Event::new(
                    "rpc.error",
                    serde_json::json!({"message": "unexpected message type"}),
                ))?;
            }
        }
    }
    let (_reader, writer_mutex) = conn.into_parts();
    let writer = writer_mutex.into_inner().expect("writer mutex");
    Ok((session, writer))
}

async fn handle<R: BufRead, W: Write>(
    conn: &Connection<R, W>,
    session: &mut Session,
    req: &Request,
) -> anyhow::Result<Response> {
    match req.method.as_str() {
        "login" => {
            let base_url = req.params["base_url"]
                .as_str()
                .context("missing base_url")?
                .to_string();
            let email = req.params["email"]
                .as_str()
                .context("missing email")?
                .to_string();
            let password = req.params["password"]
                .as_str()
                .context("missing password")?
                .to_string();
            let (token, user) = CloudClient::login(&base_url, &email, &password).await?;
            session.cloud = Some(CloudClient { base_url, token });
            session.email = Some(user.email.clone());
            // Persist so headless runs and restarts keep the session.
            let path = crate::session_store::default_path()?;
            save(
                &path,
                &StoredSession {
                    base_url: session.cloud.as_ref().unwrap().base_url.clone(),
                    token: session.cloud.as_ref().unwrap().token.clone(),
                },
            )?;
            Ok(Response::ok(
                req.id,
                serde_json::json!({"ok": true, "user": user}),
            ))
        }
        "chat.send" => {
            let cloud = session
                .cloud
                .as_ref()
                .cloned()
                .context("not logged in — call login first")?;
            let text = req.params["text"]
                .as_str()
                .context("missing text")?
                .to_string();
            if session.model.is_empty() {
                session.model = req.params["model"]
                    .as_str()
                    .unwrap_or("gpt-4o-mini")
                    .to_string();
            }
            if session.chat_id.is_none() {
                session.chat_id = Some(cloud.create_chat(None).await?);
            }
            let chat_id = session.chat_id.unwrap();
            let stream = cloud
                .chat_stream(chat_id, &session.model, &[Message::user(text)])
                .await?;
            let (full_text, done) = collect_turn(stream).await?;
            conn.write_line(&Event::new(
                "chat.delta",
                serde_json::json!({"content": full_text}),
            ))?;
            let (message_id, cost_usd, tokens_in, tokens_out) = match done {
                Some(protocol::api::StreamEvent::Done {
                    message_id,
                    cost_usd,
                    tokens_in,
                    tokens_out,
                }) => (message_id, cost_usd, tokens_in, tokens_out),
                _ => anyhow::bail!("stream ended without done event"),
            };
            conn.write_line(&Event::new(
                "chat.done",
                serde_json::json!({
                    "message_id": message_id,
                    "cost_usd": cost_usd,
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                }),
            ))?;
            Ok(Response::ok(
                req.id,
                serde_json::json!({
                    "chat_id": chat_id,
                    "message_id": message_id,
                    "cost_usd": cost_usd,
                    "tokens_in": tokens_in,
                    "tokens_out": tokens_out,
                }),
            ))
        }
        other => Ok(Response::err(
            req.id,
            RpcError::new(
                RpcError::METHOD_NOT_FOUND,
                format!("unknown method {other}"),
            ),
        )),
    }
}
