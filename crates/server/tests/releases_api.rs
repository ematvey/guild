use axum::body::Body;
use axum::http::{Request, StatusCode};
use guild_server::test_support::full_state;
use serde_json::Value;
use tower::ServiceExt;

const ARTIFACT: &[u8] = b"#!/bin/sh\necho guild-cli fake binary\n";

#[tokio::test]
async fn release_upload_list_signed_download_round_trip() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let token = fs.token.clone();

    // member cannot upload
    let member = fs
        .store()
        .identity()
        .create_user(fs.org_id, "m@b.c", "hunter226", "member")
        .await
        .unwrap();
    let (_sid, member_token) = fs
        .store()
        .identity()
        .create_session(member.id)
        .await
        .unwrap();
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/admin/releases?version=0.1.0&kind=cli&platform=linux-x86_64&filename=guild-cli.tar.gz&content_type=application/gzip")
                .header("authorization", format!("Bearer {member_token}"))
                .body(Body::from(ARTIFACT))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // admin uploads
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/admin/releases?version=0.1.0&kind=cli&platform=linux-x86_64&filename=guild-cli.tar.gz&content_type=application/gzip&notes=first%20build")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/gzip")
                .body(Body::from(ARTIFACT))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["sha256"].as_str().unwrap().len(), 64);
    assert_eq!(v["size_bytes"], ARTIFACT.len() as i64);
    let release_id = v["id"].as_str().unwrap().to_string();

    // Bearer downloads require no signature query; anonymous requests still fail.
    for (auth, expected) in [
        (Some(&token), StatusCode::OK),
        (None, StatusCode::UNAUTHORIZED),
    ] {
        let mut req = Request::builder().uri(format!("/api/v1/releases/{release_id}/download"));
        if let Some(token) = auth {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        let response = app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        if expected == StatusCode::OK {
            assert_eq!(
                &axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap()[..],
                ARTIFACT
            );
        }
    }

    // duplicate version/kind/platform → conflict
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/admin/releases?version=0.1.0&kind=cli&platform=linux-x86_64&filename=guild-cli.tar.gz")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/gzip")
                .body(Body::from(b"other".to_vec()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);

    // bad platform rejected
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/admin/releases?version=0.1.0&kind=cli&platform=amiga&filename=x.tar.gz")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(b"x".to_vec()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // user-visible list includes it (with sha256 for verification)
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/releases")
                .header("authorization", format!("Bearer {member_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(String::from_utf8(body.to_vec()).unwrap().contains("0.1.0"));

    // member mints a signed URL and downloads; bytes + sha match
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/releases/{release_id}/download-url"))
                .header("authorization", format!("Bearer {member_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    let url = v["url"].as_str().unwrap().to_string();

    let res = app
        .clone()
        .oneshot(Request::builder().uri(url).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers().get("content-disposition").unwrap(),
        "attachment; filename=\"guild-cli.tar.gz\""
    );
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(&body[..], ARTIFACT);

    // tampered signature rejected
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/v1/releases/{release_id}/download?exp=9999999999&sig=deadbeef"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // admin delete removes it (download then 404s even with a fresh URL)
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/v1/admin/releases/{release_id}"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/releases/{release_id}/download-url"))
                .header("authorization", format!("Bearer {member_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn updater_manifest_serves_newest_signed_desktop_version() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let token = fs.token.clone();

    // older desktop version (signed) + newer cli (not desktop, must be ignored)
    for (ver, kind, platform, filename) in [
        ("0.2.0", "desktop", "linux-x86_64", "Guild-0.2.0.AppImage"),
        ("0.3.0", "desktop", "linux-x86_64", "Guild-0.3.0.AppImage"),
        (
            "0.3.0",
            "desktop",
            "windows-x86_64",
            "Guild_0.3.0_x64-setup.exe",
        ),
        ("0.3.0", "desktop", "darwin-aarch64", "Guild.app.tar.gz"),
        ("0.9.0", "cli", "linux-x86_64", "guild-cli.tar.gz"),
    ] {
        let res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/v1/admin/releases?version={ver}&kind={kind}&platform={platform}\
                         &filename={filename}&updater_sig=minisig-{ver}-{platform}"
                    ))
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::from(ARTIFACT))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{ver}/{platform}");
    }
    // newer desktop version WITHOUT an updater signature: must be ignored
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(
                    "/api/v1/admin/releases?version=0.4.0&kind=desktop&platform=linux-x86_64\
                      &filename=Guild-0.4.0.AppImage",
                )
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(ARTIFACT))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // public (no auth): newest fully-signed desktop version wins
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/updates/latest.json")
                .header("host", "guild.example")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["version"], "0.3.0");
    for target in ["linux-x86_64", "windows-x86_64", "darwin-aarch64"] {
        let entry = &body["platforms"][target];
        assert!(!entry.is_null(), "missing {target}");
        assert_eq!(entry["signature"], format!("minisig-0.3.0-{target}"));
        assert!(entry["url"].as_str().unwrap().contains("sig="));
    }
    assert!(body["platforms"]["darwin-x86_64"].is_null());
    // the manifest URL is an absolute signed download link built from the
    // configured API base URL (not the request's Host header), and resolves
    let url = body["platforms"]["linux-x86_64"]["url"].as_str().unwrap();
    assert!(url.starts_with("http://localhost:8080/"));
    let res = app
        .clone()
        .oneshot(Request::builder().uri(url).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    assert_eq!(&bytes[..], ARTIFACT);
}

#[tokio::test]
async fn updater_manifest_is_204_when_nothing_is_signed() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let token = fs.token.clone();
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/admin/releases?version=0.2.0&kind=desktop&platform=linux-x86_64&filename=Guild.AppImage")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(ARTIFACT))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/updates/latest.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
}

/// The release identity includes the artifact filename: one (version,
/// platform) carries several artifacts (macOS DMG + its .app.tar.gz updater
/// bundle), and republishing one must not delete the other — the old
/// (version, kind, platform) unique key made the second publish delete the
/// first.
#[tokio::test]
async fn same_platform_artifacts_with_different_filenames_coexist() {
    let fs = full_state().await;
    let app = guild_server::build_router(fs.state.clone());
    let token = fs.token.clone();
    let upload = |filename: &str, body: &'static [u8]| {
        app.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/v1/admin/releases?version=0.6.0&kind=desktop&platform=darwin-aarch64&filename={filename}&content_type=application/octet-stream&updater_sig=sig"
                ))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/octet-stream")
                .body(Body::from(body))
                .unwrap(),
        )
    };
    let dmg = upload("Guild-0.6.0-macos-aarch64.dmg", b"dmg-bytes")
        .await
        .unwrap();
    assert_eq!(dmg.status(), StatusCode::OK);
    let tar = upload("Guild-0.6.0-macos-aarch64.app.tar.gz", b"tar-bytes")
        .await
        .unwrap();
    assert_eq!(
        tar.status(),
        StatusCode::OK,
        "the second artifact must not delete the first"
    );

    let list = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/releases")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(list.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    let names: Vec<&str> = v["releases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["version"] == "0.6.0")
        .filter_map(|r| r["filename"].as_str())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");

    // Republish the DMG: delete its row, re-upload — the tarball stays.
    let dmg_id = v["releases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["filename"].as_str().unwrap_or("").ends_with(".dmg"))
        .and_then(|r| r["id"].as_str())
        .unwrap()
        .to_string();
    let del = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/v1/admin/releases/{dmg_id}"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(del.status(), StatusCode::OK);
    assert_eq!(
        upload("Guild-0.6.0-macos-aarch64.dmg", b"dmg-v2")
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let list = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/releases")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = axum::body::to_bytes(list.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&body).unwrap();
    let count = v["releases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["version"] == "0.6.0")
        .count();
    assert_eq!(count, 2, "republish retained both artifacts");
}
