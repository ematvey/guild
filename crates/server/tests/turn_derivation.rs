//! Turn-derivation extraction (PLAN-suggestions §2d): the arrival-turn text
//! and media-map loading live in worker/turn.rs, off the gateway/restate
//! pair. These tests pin the moved derivation's shapes.

use guild_server::worker::turn::{build_turn_text, modality_of, MediaMap, MediaRef};
use uuid::Uuid;

fn row(id: Uuid, filename: &str, ct: &str, size: i64) -> (Uuid, String, String, i64) {
    (id, filename.to_string(), ct.to_string(), size)
}

fn media(id: Uuid, mime: &str, text: &str) -> (Uuid, MediaRef) {
    use base64::Engine as _;
    (
        id,
        MediaRef {
            mime: mime.to_string(),
            b64: base64::engine::general_purpose::STANDARD.encode(text.as_bytes()),
        },
    )
}

/// A textual document inlines its bytes under the UI's strip marker; a
/// non-textual document renders the not-inlined note; an oversized document
/// truncates with the ellipsis marker; image notes follow the route's
/// modalities.
#[test]
fn build_turn_text_inline_and_notes() {
    let doc = Uuid::now_v7();
    let png = Uuid::now_v7();
    let wav = Uuid::now_v7();
    let big = Uuid::now_v7();
    let requested = [doc, png, wav, big];
    let rows = [
        row(doc, "notes.md", "text/markdown", 12),
        row(png, "photo.png", "image/png", 9),
        row(wav, "clip.wav", "audio/wav", 9),
        row(big, "huge.txt", "text/plain", 200_000),
    ];
    let media_map: MediaMap = [
        media(doc, "text/markdown", "hello world"),
        media(png, "image/png", "PNG"),
        media(wav, "audio/wav", "WAV"),
        media(big, "text/plain", &"x".repeat(80_001)),
    ]
    .into_iter()
    .collect();

    let (chips, text) = build_turn_text(
        &requested,
        &media_map,
        &rows,
        &["image".to_string(), "audio".to_string()],
    );

    assert_eq!(chips.len(), 4);
    assert_eq!(chips[0].modality, "document");
    assert_eq!(chips[1].modality, "image");
    // The typed text plus the inlined document under the strip marker.
    assert!(
        text.contains("[Attachment: notes.md (text/markdown, 12 bytes)]\nhello world"),
        "got: {text}"
    );
    // Image supported by the route: shown, not inlined as text.
    assert!(text.contains("photo.png (image/png, 9 bytes) — shown to the model as an image"));
    // Audio supported by the route.
    assert!(text.contains("clip.wav (audio/wav, 9 bytes) — provided to the model as audio"));
    // Oversized textual document truncates at the inline cap.
    assert!(text.contains("huge.txt (text/plain, 200000 bytes)]"));
    assert!(text.contains("…[truncated]"));
    let huge = text.split("\n\n").last().unwrap();
    let inline = huge
        .strip_suffix("\n…[truncated]")
        .expect("truncation marker")
        .split('\n')
        .nth(1)
        .unwrap();
    assert_eq!(inline.chars().count(), 80_000, "inline cap applies");
}

/// Requests filter: only the requested ids become chips; unrequested
/// attachment rows leave no trace.
#[test]
fn build_turn_text_only_requested_ids() {
    let asked = Uuid::now_v7();
    let other = Uuid::now_v7();
    let media_map: MediaMap = [media(other, "image/png", "PNG")].into_iter().collect();
    let rows = [
        row(asked, "keep.md", "text/markdown", 4),
        row(other, "drop.png", "image/png", 4),
    ];
    let (chips, text) = build_turn_text(&[asked], &media_map, &rows, &[]);
    assert_eq!(chips.len(), 1);
    assert_eq!(chips[0].id, asked);
    assert!(text.contains("keep.md"));
    assert!(!text.contains("drop.png"));
    // Nothing requested: empty text, no chips.
    let (chips, text) = build_turn_text(&[], &MediaMap::new(), &rows, &[]);
    assert!(chips.is_empty());
    assert!(text.is_empty());
}

#[test]
fn modality_of_covers_the_wire_classes() {
    assert_eq!(modality_of("image/png"), "image");
    assert_eq!(modality_of("AUDIO/WAV"), "audio");
    assert_eq!(modality_of("video/mp4"), "video");
    assert_eq!(modality_of("application/pdf"), "document");
}
