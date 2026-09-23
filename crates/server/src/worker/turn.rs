//! Turn derivation and turn-start policy (the 2d rider of the funnel
//! landing): everything a turn derives from its inputs before the loop
//! runs — the arrival-turn text (chips + inlined document bytes), the
//! attachment media map, and the model route's quota enforcement. Shared by
//! the gateway's turn submission (the queued-send path commits the user
//! event early) and the ChatRunner workflow's journaled steps.

use crate::http::error::ApiError;
use crate::state::AppState;
use protocol::api::{MessageAttachment, MessageAudio, ThreadEvent};
use uuid::Uuid;

/// Loaded attachment bytes for the current turn, wire-ready: base64 plus
/// the content type (data URIs and audio parts are derived at use time,
/// gated by the resolved route's modalities). Values are journaled (the
/// run result carries the base64), so map loads must happen inside `run`.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct MediaRef {
    pub mime: String,
    pub b64: String,
}

impl MediaRef {
    pub fn decoded(&self) -> Vec<u8> {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(&self.b64)
            .unwrap_or_default()
    }
}

pub type MediaMap = std::collections::HashMap<Uuid, MediaRef>;

/// Attachment modality class from the content type.
pub fn modality_of(content_type: &str) -> &'static str {
    let ct = content_type.to_ascii_lowercase();
    if ct.starts_with("image/") {
        "image"
    } else if ct.starts_with("audio/") {
        "audio"
    } else if ct.starts_with("video/") {
        "video"
    } else {
        "document"
    }
}

/// OpenAI `input_audio` accepts wav/mp3 only.
fn audio_format(mime: &str) -> Option<&'static str> {
    match mime {
        "audio/wav" | "audio/x-wav" | "audio/wave" => Some("wav"),
        "audio/mpeg" | "audio/mp3" => Some("mp3"),
        _ => None,
    }
}

/// Model-facing image/audio parts for a turn's attachments, gated by the
/// route's native modalities. Unsupported media stays in the log and in
/// object storage (later: code-execution tooling), never silently deleted —
/// it just does not reach this model.
pub fn media_parts(
    media: &MediaMap,
    atts: &[MessageAttachment],
    modalities: &[String],
) -> (Vec<String>, Vec<MessageAudio>) {
    let mut images = Vec::new();
    let mut audio = Vec::new();
    for a in atts {
        let Some(m) = media.get(&a.id) else { continue };
        let supported = modalities.iter().any(|x| x == &a.modality);
        match a.modality.as_str() {
            "image" if supported => {
                images.push(format!("data:{};base64,{}", m.mime, m.b64));
            }
            "audio" if supported => {
                if let Some(f) = audio_format(&m.mime) {
                    audio.push(MessageAudio {
                        data: m.b64.clone(),
                        format: f.to_string(),
                    });
                }
            }
            _ => {}
        }
    }
    (images, audio)
}

/// Inline cap for one document attachment's textual content (chars) — a
/// single huge file must not blow the context window by itself.
const ATTACHMENT_INLINE_LIMIT: usize = 80_000;

/// Whether a document attachment's content is textual and can be inlined.
fn attachment_is_textual(content_type: &str, filename: &str) -> bool {
    let ct = content_type.to_ascii_lowercase();
    if ct.starts_with("text/") {
        return true;
    }
    if matches!(
        ct.as_str(),
        "application/json"
            | "application/xml"
            | "application/yaml"
            | "application/x-yaml"
            | "application/javascript"
            | "application/toml"
            | "application/sql"
            | "application/x-sh"
    ) {
        return true;
    }
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "md" | "txt"
            | "json"
            | "rs"
            | "py"
            | "js"
            | "ts"
            | "tsx"
            | "jsx"
            | "toml"
            | "yaml"
            | "yml"
            | "csv"
            | "tsv"
            | "log"
            | "sh"
            | "bash"
            | "sql"
            | "html"
            | "htm"
            | "css"
            | "xml"
            | "ini"
            | "conf"
            | "env"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "go"
            | "java"
            | "rb"
            | "php"
            | "swift"
            | "kt"
            | "proto"
            | "gradle"
            | "lock"
            | "gitignore"
            | "dockerfile"
            | "makefile"
            | "patch"
            | "diff"
    )
}

/// Builds the arrival-turn user event from the requested attachment ids
/// (in the chat's attachment order): chip metadata plus the text appended
/// to the typed message (inlined document text, or a note for media).
/// The marker `"\n\n[Attachment: "` is the UI's strip boundary — clients
/// render the typed text plus chips, not the wire text.
pub fn build_turn_text(
    requested: &[Uuid],
    media: &MediaMap,
    rows: &[(Uuid, String, String, i64)], // (id, filename, content_type, size)
    modalities: &[String],
) -> (Vec<MessageAttachment>, String) {
    let mut chips = Vec::new();
    let mut blocks = Vec::new();
    for (id, filename, content_type, size) in rows {
        if !requested.contains(id) {
            continue;
        }
        let modality = modality_of(content_type);
        chips.push(MessageAttachment {
            id: *id,
            filename: filename.clone(),
            content_type: content_type.clone(),
            size_bytes: *size,
            modality: modality.to_string(),
        });
        match modality {
            "document" => {
                let mut text = media
                    .get(id)
                    .map(|m| String::from_utf8_lossy(&m.decoded()).into_owned())
                    .unwrap_or_default();
                if text.chars().count() > ATTACHMENT_INLINE_LIMIT {
                    text = text.chars().take(ATTACHMENT_INLINE_LIMIT).collect();
                    text.push_str("\n…[truncated]");
                }
                if attachment_is_textual(content_type, filename) && !text.is_empty() {
                    blocks.push(format!(
                        "[Attachment: {} ({}, {} bytes)]\n{}",
                        filename, content_type, size, text
                    ));
                } else {
                    blocks.push(format!(
                        "[Attachment: {} ({}, {} bytes) — content not inlined]",
                        filename, content_type, size
                    ));
                }
            }
            m => {
                let supported = modalities.iter().any(|x| *x == m);
                let note = if supported {
                    match m {
                        "image" => "shown to the model as an image",
                        "audio" => "provided to the model as audio",
                        _ => "no native modality on this route",
                    }
                } else {
                    "stored; this model does not accept this modality"
                };
                blocks.push(format!(
                    "[Attachment: {} ({}, {} bytes) — {}]",
                    filename, content_type, size, note
                ));
            }
        }
    }
    let text = if blocks.is_empty() {
        String::new()
    } else {
        blocks.join("\n\n")
    };
    (chips, text)
}

/// Journaled-loadable attachment bytes for one chat: every image/audio
/// attachment referenced by `events` (derivation replays them as parts on
/// every subsequent turn) plus every id in `extra_ids` (the arrival turn;
/// documents need their bytes for inlining). Bytes are immutable once
/// uploaded, so the read is replay-deterministic.
pub async fn load_media_map(
    state: &AppState,
    org_id: Uuid,
    chat_id: Uuid,
    events: &[ThreadEvent],
    extra_ids: &[Uuid],
) -> Result<MediaMap, ApiError> {
    let mut ids: Vec<Uuid> = Vec::new();
    for ev in events {
        if let ThreadEvent::UserMessage { attachments, .. } = ev {
            for a in attachments {
                if a.modality == "image" || a.modality == "audio" {
                    ids.push(a.id);
                }
            }
        }
    }
    ids.extend(extra_ids.iter().copied());
    if ids.is_empty() {
        return Ok(MediaMap::new());
    }
    let store = state.store().await?;
    let rows = store.attachments().list(org_id, chat_id).await?;
    let objects = state.objects().await?;
    let mut map = MediaMap::new();
    for row in rows {
        if !ids.contains(&row.id) {
            continue;
        }
        let key = crate::store::attachments::object_key(org_id, row.id, &row.filename);
        let Ok(bytes) = objects.get(&key).await else {
            continue;
        };
        use base64::Engine as _;
        map.insert(
            row.id,
            MediaRef {
                mime: row.content_type.clone(),
                b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            },
        );
    }
    Ok(map)
}

/// Route quota enforcement (spec §4.5): reject when month-to-date spend for
/// (org, model) has reached the route's monthly cap.
pub async fn enforce_quota(
    state: &AppState,
    org_id: Uuid,
    model: &str,
    route: &crate::store::gateway::RouteRow,
) -> Result<(), ApiError> {
    let Some(quota) = route.quota_monthly_usd else {
        return Ok(());
    };
    let spent = state
        .usage()
        .await?
        .month_spend(org_id, model)
        .await
        .map_err(|e| ApiError::internal(format!("quota check failed: {e}")))?;
    if spent >= quota {
        return Err(ApiError::new(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "quota_exceeded",
            format!("monthly quota for this model reached ({spent:.2} >= {quota:.2} USD)"),
        ));
    }
    Ok(())
}
