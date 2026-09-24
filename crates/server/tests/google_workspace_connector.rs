//! Google Workspace connector tests (milestone 10, Lane GOOGLE): the
//! wiremock-backed exercise of the token exchange (RS256 service-account
//! JWT → access token), the in-process token cache, and every tool against
//! its endpoint family. The RSA keypair below is a generated fake — never a
//! real credential.

use guild_server::integrations::{google_workspace, integration_by_name, Integration};
use serde_json::{json, Value};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

const FAKE_PRIVATE_KEY: &str = "-----BEGIN PRIVATE KEY-----
\
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCmhHGZOsI/ve31
\
xJURqsYyTEzNoGkQc802Uww5k/Lo66g/lZ6Bn0vM1jJa7lFk80+61IkLOMb6TsLb
\
RKoqsEhdqFm54ozwO0+E4EVadl/xk0Lt7IP2krMxzX2r9E/VaHBCqUmhAXH42iAv
\
YPkknEBNdinbrclnfhRbFC8zWQ/8HeClW2Olq2jkA0Rtbh2oAgqtbtUZI0MQPHJF
\
4BZS07TsVgZpML7Qzkg9svbek53ApTv4Qb1Rk4Tn35mwqdEun0KAnok2VUybCHWl
\
Ue++G6BiHlmGIZjerkhQZ5OLd75S1FxURAM82H4RBWgTd2bDsNCePelI9tZ5gzOV
\
6/8aAUUNAgMBAAECggEABebiKzGrdTHopLzZIb1WoALB+B8hii094+6Gm5B/Brq6
\
MGK/saLGlNXaBrdgAtQi38ws/Uz/tHB6ieYBoq4JKpSkdX5Y9iIhW+QiYSXv7vKE
\
EpsUREwydhHtTIfGFUTJ3Hr+j+qAB8zHYOvZeMQ2/T0ybPBYbUbJNuncuxUC3Ycs
\
7ZzXHIQjBTRYygfu+fbcpXUAG+DfuRN8heUCQ0yuYJvHQZluINdNunbYPwP9xfC6
\
sU/we0H5ATcnyTvoUwougLE+mExmJ58sEvY5SwMCF9Wj7yrDwQ1G25VzmS40PuIw
\
DXLA1ZOFBUJ/6cr72fi0vVQtK+dyttdpRlKb21H+wQKBgQDTJd+vIzFCG7P86cD4
\
6DfmHgwFXlo+pzkSeCIDkvlWcGACggjhryQfuDEcCjNVEHR+X7XiScf1BL1qO1GL
\
0MmDkR0y/J6aVJBvqEgCu6ibSFEyO4nFaTbQ0di8R6JY1F3KsCMVB7nz2VivZmnc
\
hIYyoczDHmBMVWI1vhMrzT0ALQKBgQDJ45RiyUc69+qx4XWF90L1MI1hzus58O82
\
lG3896Aj5Nh5tnoz1knTr2py3JQ3WyUBxlL5HU9AsuYe4kjfMGjHrKdh/q2qD/PE
\
lQ8wFVExM8RTTgrzBH9uJFEaYwbHXpCMgFme8snxYVT5mCSFdSBc2ReVuhr2aL1B
\
wxEazCGEYQKBgDX7QdOxyJ8hHAP18wrvu5LObb5Vn/bSo8mwAuotAifyNOmPOxwP
\
vcmKOqvzg6okudOxPnvq5v8iRhbJsZBwQYSsbe2iHh5QrliNilOAjJuegnu4MwHQ
\
Y15BuApyufPB33S5UU7IGedY0s6M/VWOYAzDxui/dFkvnxskTBxvrT/FAoGAfVDu
\
goM927SX0eKI+KcKwPdqSxQNnuGXGuH3g9aRaLZcSPCj2hlhqixwfuu8dL/2sKtS
\
RZ+T2i0x+mmroh6Ca68YFxPm6HEOdy+vRcF1rHzdmHgRA9f+4XdZgG+HfamNQClL
\
eAZso5AvFt8BjHWvqPJ4WVAz/E/3aiKTM3cSNwECgYB7TV6cR6hYaUxLZQXfy8V8
\
KWMlUigY1R12a18UbunJni/3nbRg1LhjY7QvJSzXV2H/teCfAY0ZXXtNDh9dJnp8
\
eGdWYZborr9632lzxZHUhsAxQbwivmB0usL+TnokdMnvjmljDo0xaF35p64PsSW/
\
Evq+3WiOyVS1eDqCXd3s8w==
\
-----END PRIVATE KEY-----
";

const FAKE_PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----
\
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApoRxmTrCP73t9cSVEarG
\
MkxMzaBpEHPNNlMMOZPy6OuoP5WegZ9LzNYyWu5RZPNPutSJCzjG+k7C20SqKrBI
\
XahZueKM8DtPhOBFWnZf8ZNC7eyD9pKzMc19q/RP1WhwQqlJoQFx+NogL2D5JJxA
\
TXYp263JZ34UWxQvM1kP/B3gpVtjpato5ANEbW4dqAIKrW7VGSNDEDxyReAWUtO0
\
7FYGaTC+0M5IPbL23pOdwKU7+EG9UZOE59+ZsKnRLp9CgJ6JNlVMmwh1pVHvvhug
\
Yh5ZhiGY3q5IUGeTi3e+UtRcVEQDPNh+EQVoE3dmw7DQnj3pSPbWeYMzlev/GgFF
\
DQIDAQAB
\
-----END PUBLIC KEY-----
";

const CLIENT_EMAIL: &str = "svc@guild-test.iam.gserviceaccount.com";
const ADMIN_EMAIL: &str = "gw-admin@example.com";
const FAKE_ACCESS_TOKEN: &str = "fake-access-token-1";

/// A second generated fake keypair — the credential another org would
/// configure under the same client_email.
const SECOND_PRIVATE_KEY: &str = "-----BEGIN PRIVATE KEY-----
\
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDI5+I6WLRKdXcY
\
/gacF5sWFKPMNSLE7vKWGCrupANyfHBteLQwpDQG9YOrChM0PRhgx8YUwpZQHc5p
\
tAdjxSG6+E2g30QFoMQtTVkCYWf6/AeH6T9ZrSPaAnT7r4F8DfvVGZO6wGiN69Vu
\
cZFGunoZM9Qq7FpRMWI0JHhGqhxO5w1eBed0kTqcJt7aDeRwfCI++i4zBViTUxZA
\
YwmFdp9oudrrHXZ26N4Q1BTBfntv4OHgZ8bp1UhfAlmrkdQqnsEx/wXcL312Rjui
\
EfOoZaHS+jXqKkzhCAXPH4RMCTQ9gia9aoa2rvWb+bNnXEOt/3LhJnyT09Vs8Aq0
\
oKobte/9AgMBAAECggEABpsxYi/GhehE6Up5Fyrji59UH4Pjx8v/qBXVW5GDF4Gm
\
BMOCUVMk7tGl6brkFMSph40qI0aewLWqMumbkJlL2aUOkGqnBvRZXw/7DEv9qlAd
\
Q0fVMHK0ChgolpoXzOd8z24O4IYxKfGGTCJp34SEPU3p/RtWgPL5wrMsTU6Mrb92
\
SKQY9LjkGG4x3qwabv4e8Ocv4rJmZdqyiMvkxWASXm6lXZBkNijA3MAd9VDCxFO+
\
qcGTFZtBEbiNjhwxVLOeNoWPwuZjZwR7buz+F//WOKz6IYV6UwHhk71A3oVWmfH+
\
XIryoa1mSBStol3PJanGGebI4ZAD4a/VxXRY6JFpNQKBgQD05BZDz8KE+TDzA105
\
9D507zSlpp+EnxlJWGqtxPJwV1iHPs+3k00QR1CIDO6YXZb7Nm53FnintoM5Zjou
\
cvYDKvf7ES+PIO2AU9OVdVWkhF2PGH7djWiaqwgwbw9dVUd/S/5jqyVVA3NJs+W6
\
r6s3KUeLsoCKdx49V2s+S08bpwKBgQDSBP98lQau08ASdloNjDZR1nfeF/I7CVwV
\
58zubhejEbwb7xgySnzqPN1kYgiwsUraP/tZqftBY4W+5nTRcivIG7lvtm5BFZF2
\
Ho6NH7UWEvQ5tRY/ogCFrVFYZ3bqHjWg2H+ZK5uwVpl0JkierTPUpOChP02oITZ8
\
Ey+tCrD7uwKBgQCq4OTwWG5hHwia6YQJxnY2XhucYxH4FpQsa7e0nTKWVTx+0sNa
\
Uzx42WpGJM/wHY4WqLqX+mQikuYqDT0X4DvtpfP3itxmwRE4dEW1inRCIeKu0Obl
\
baDKHAHQ2g4ckD8dgkd2AJxCH/A4Q4FPrPiJuxIjVmD/PXMqVm+MvjvrDQKBgC+x
\
qN9+7GSZe931eJ/o/pD5NoF+SKk1h+8FlBl1cPK8XU6urn0FQ3biWZipVrXhnVER
\
BKCpJIEF++KNbWv/FIg+G4+OC13GayE68T6FO9eGeGX+hM3wmVPCN13vKScjsyQS
\
5m8/YvzZvcGNzCIUzVd2FfkoahdLa5cjuEkAy45vAoGAUw2N3SBI0be7johrAtrO
\
KtaUPnrGgk7mzHwK1X5Hen5yMeapiPwfW2oHP+ts9YpF/az1GyjBjJNQUZ3N4B5R
\
B5RHbcpDnHNp/4Ua6Pq5nGe/+ti16x3hg4jUtD6ABJMEDUO83IUkrmSDO6s5jsUD
\
zGC+rXxhPy6L/CAlIawnmgg=
\
-----END PRIVATE KEY-----
";

const SECOND_PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----
\
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyOfiOli0SnV3GP4GnBeb
\
FhSjzDUixO7ylhgq7qQDcnxwbXi0MKQ0BvWDqwoTND0YYMfGFMKWUB3OabQHY8Uh
\
uvhNoN9EBaDELU1ZAmFn+vwHh+k/Wa0j2gJ0+6+BfA371RmTusBojevVbnGRRrp6
\
GTPUKuxaUTFiNCR4RqocTucNXgXndJE6nCbe2g3kcHwiPvouMwVYk1MWQGMJhXaf
\
aLna6x12dujeENQUwX57b+Dh4GfG6dVIXwJZq5HUKp7BMf8F3C99dkY7ohHzqGWh
\
0vo16ipM4QgFzx+ETAk0PYImvWqGtq71m/mzZ1xDrf9y4SZ8k9PVbPAKtKCqG7Xv
\
/QIDAQAB
\
-----END PUBLIC KEY-----
";
const SCOPES: &str = "https://www.googleapis.com/auth/gmail.readonly \
                      https://www.googleapis.com/auth/calendar.readonly \
                      https://www.googleapis.com/auth/drive.readonly \
                      https://www.googleapis.com/auth/admin.directory.user.readonly";

fn connector() -> std::sync::Arc<guild_server::integrations::google_workspace::GoogleWorkspace> {
    google_workspace::instance()
}

/// The full service-account JSON string, as the secrets store would hold it.
fn service_account_json() -> String {
    json!({
        "type": "service_account",
        "project_id": "guild-test",
        "client_email": CLIENT_EMAIL,
        "private_key": FAKE_PRIVATE_KEY,
        "token_uri": "https://oauth2.googleapis.com/token"
    })
    .to_string()
}

fn secrets() -> Vec<(String, String)> {
    vec![
        ("service_account_json".to_string(), service_account_json()),
        ("admin_email".to_string(), ADMIN_EMAIL.to_string()),
    ]
}

fn config(server: &MockServer) -> Value {
    json!({
        "api_base": server.uri(),
        // Wiremock pools and reuses server addresses. Distinguish fixtures
        // in the process-wide connector cache while preserving each test's
        // repeated calls through its single config.
        "token_url": format!("{}/token?fixture={}", server.uri(), uuid::Uuid::now_v7())
    })
}

async fn mount_token_endpoint(server: &MockServer, expires_in: u64) {
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": FAKE_ACCESS_TOKEN,
            "expires_in": expires_in,
            "token_type": "Bearer"
        })))
        .mount(server)
        .await;
}

/// The `assertion` form field of the captured token request — the signed
/// service-account JWT.
async fn captured_assertion(server: &MockServer) -> String {
    let requests = server
        .received_requests()
        .await
        .expect("received token requests");
    let token_req = requests
        .iter()
        .find(|r| r.url.path() == "/token")
        .expect("token endpoint was called");
    let body = String::from_utf8(token_req.body.clone()).expect("form body is utf8");
    body.split('&')
        .find_map(|pair| pair.strip_prefix("assertion="))
        .expect("token request carries an assertion")
        .to_string()
}

#[derive(serde::Deserialize)]
struct GwClaims {
    iss: String,
    sub: String,
    scope: String,
    aud: String,
    iat: u64,
    exp: u64,
}

/// Decodes the captured JWT against the fake keypair's public key and
/// checks the Google service-account claim set.
fn verify_service_account_jwt(assertion: &str, expected_sub: &str, token_url: &str) {
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[token_url]);
    let key =
        jsonwebtoken::DecodingKey::from_rsa_pem(FAKE_PUBLIC_KEY.as_bytes()).expect("public key");
    let data = jsonwebtoken::decode::<GwClaims>(assertion, &key, &validation)
        .expect("assertion decodes with the fake keypair");
    assert_eq!(data.claims.iss, CLIENT_EMAIL);
    assert_eq!(data.claims.sub, expected_sub);
    assert_eq!(data.claims.scope, SCOPES);
    assert_eq!(data.claims.aud, token_url);
    assert!(data.claims.exp > data.claims.iat);
}

// ---------- manifest + registration ----------

#[test]
fn registered_with_impersonated_auth_manifest_and_read_tools() {
    let connector = integration_by_name("google_workspace").expect("registered");
    assert_eq!(connector.name(), "google_workspace");
    let manifest = connector.manifest();
    let auth = manifest.auth.as_ref().expect("auth manifest");
    assert_eq!(auth.kind, "org_secret_impersonated");
    assert_eq!(auth.identity_key, "email");
    // admin_email is a plain setting; the service-account JSON is the one
    // credential.
    assert_eq!(auth.secret_names, vec!["service_account_json".to_string()]);
    let fields = &manifest.settings.as_ref().expect("settings").fields;
    assert!(fields.iter().any(|f| f.name == "admin_email" && f.required));
    let tools = manifest.tools.expect("tools manifest");
    assert_eq!(tools.classes.len(), 7);
    for name in [
        "gmail_search",
        "gmail_get_message",
        "gmail_get_attachment",
        "calendar_list_events",
        "drive_search",
        "directory_users",
    ] {
        assert_eq!(tools.classes[name], "read", "tool {name} is read-class");
    }
    // The api tool exposes the write-capable REST surface.
    assert_eq!(tools.classes["api"], "write");
}

#[test]
fn acting_identity_prefers_override_then_admin_email() {
    // The acting_as branch is the interface extension the unified execute
    // does not carry yet — the resolution itself is the connector's.
    assert_eq!(
        google_workspace::acting_identity(Some("member@example.com"), ADMIN_EMAIL),
        "member@example.com"
    );
    assert_eq!(
        google_workspace::acting_identity(None, ADMIN_EMAIL),
        ADMIN_EMAIL
    );
}

// ---------- token exchange + cache ----------

#[tokio::test]
async fn gmail_search_exchanges_jwt_and_lists_messages() {
    let server = MockServer::start().await;
    mount_token_endpoint(&server, 3600).await;
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/messages"))
        .and(query_param("q", "from:alice"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "messages": [{"id": "msg-1", "threadId": "th-1"}],
            "resultSizeEstimate": 1
        })))
        .expect(1)
        .mount(&server)
        .await;

    let cfg = config(&server);
    let outcome = connector()
        .execute(
            &cfg,
            "gmail_search",
            json!({"query": "from:alice"}),
            &secrets(),
            None,
        )
        .await
        .expect("gmail_search succeeds");
    assert!(outcome.content.contains("msg-1"));
    assert!(outcome.content.contains("th-1"));
    server.verify().await;

    let assertion = captured_assertion(&server).await;
    verify_service_account_jwt(&assertion, ADMIN_EMAIL, cfg["token_url"].as_str().unwrap());

    let requests = server.received_requests().await.unwrap();
    let api_req = requests
        .iter()
        .find(|r| r.url.path() == "/gmail/v1/users/me/messages")
        .unwrap();
    let expected_auth = format!("Bearer {FAKE_ACCESS_TOKEN}");
    assert_eq!(
        api_req
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok()),
        Some(expected_auth.as_str())
    );
}

#[tokio::test]
async fn access_token_is_cached_within_the_same_process() {
    let server = MockServer::start().await;
    mount_token_endpoint(&server, 3600).await;
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "messages": [{"id": "msg-1", "threadId": "th-1"}],
            "resultSizeEstimate": 1
        })))
        .expect(2)
        .mount(&server)
        .await;

    let cfg = config(&server);
    let c = connector();
    for _ in 0..2 {
        c.execute(
            &cfg,
            "gmail_search",
            json!({"query": "q"}),
            &secrets(),
            None,
        )
        .await
        .expect("gmail_search succeeds");
    }
    // Two tool calls, one token exchange — the second rides the cache.
    server.verify().await;
    assert_eq!(
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|request| request.url.path() == "/token")
            .count(),
        1
    );
}

#[tokio::test]
async fn token_refreshes_once_near_expiry() {
    let server = MockServer::start().await;
    // A 1s token is already past the 60s refresh margin — every call
    // re-exchanges, proving the near-expiry path.
    mount_token_endpoint(&server, 1).await;
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "messages": [],
            "resultSizeEstimate": 0
        })))
        .expect(2)
        .mount(&server)
        .await;

    let cfg = config(&server);
    let c = connector();
    for _ in 0..2 {
        c.execute(
            &cfg,
            "gmail_search",
            json!({"query": "q"}),
            &secrets(),
            None,
        )
        .await
        .expect("gmail_search succeeds");
    }
    server.verify().await;
    assert_eq!(
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|request| request.url.path() == "/token")
            .count(),
        2
    );
}

#[tokio::test]
async fn missing_service_account_secret_fails() {
    let outcome = connector()
        .execute(&json!({}), "gmail_search", json!({"query": "q"}), &[], None)
        .await;
    let err = outcome.expect_err("no secrets — no call");
    assert!(err.contains("is not stored"), "error: {err}");
}

#[tokio::test]
async fn failing_token_endpoint_surfaces_the_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/token"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let outcome = connector()
        .execute(
            &config(&server),
            "gmail_search",
            json!({"query": "q"}),
            &secrets(),
            None,
        )
        .await;
    let err = outcome.expect_err("token exchange fails");
    assert!(err.contains("token endpoint"), "error: {err}");
}

// ---------- tools ----------

#[tokio::test]
async fn gmail_get_message_extracts_headers_and_text_body() {
    let server = MockServer::start().await;
    mount_token_endpoint(&server, 3600).await;
    let b64 = |s: &str| {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s)
    };
    let plain = b64("hello from gmail");
    let html = b64("<p>html body</p>");
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/messages/msg-9"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg-9",
            "threadId": "th-1",
            "snippet": "hello snippet",
            "payload": {
                "mimeType": "multipart/alternative",
                "headers": [
                    {"name": "Subject", "value": "Test subject"},
                    {"name": "From", "value": "alice@example.com"},
                    {"name": "Date", "value": "Fri, 12 Sep 2026 10:00:00 +0000"}
                ],
                "parts": [
                    {"mimeType": "text/plain", "body": {"data": plain}},
                    {"mimeType": "text/html", "body": {"data": html}}
                ]
            }
        })))
        .mount(&server)
        .await;

    let outcome = connector()
        .execute(
            &config(&server),
            "gmail_get_message",
            json!({"message_id": "msg-9"}),
            &secrets(),
            None,
        )
        .await
        .expect("gmail_get_message succeeds");
    assert!(outcome.content.contains("Test subject"));
    assert!(outcome.content.contains("alice@example.com"));
    assert!(outcome.content.contains("hello from gmail"));
    // text/plain wins over text/html.
    assert!(!outcome.content.contains("html body"));
}

#[tokio::test]
async fn gmail_get_message_falls_back_to_html_body() {
    let server = MockServer::start().await;
    mount_token_endpoint(&server, 3600).await;
    use base64::Engine;
    let html = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("<p>only html</p>");
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/messages/msg-html"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "msg-html",
            "payload": {
                "mimeType": "text/html",
                "headers": [],
                "body": {"data": html}
            }
        })))
        .mount(&server)
        .await;

    let outcome = connector()
        .execute(
            &config(&server),
            "gmail_get_message",
            json!({"message_id": "msg-html"}),
            &secrets(),
            None,
        )
        .await
        .expect("gmail_get_message succeeds");
    assert!(outcome.content.contains("only html"));
}

#[tokio::test]
async fn calendar_list_events_lists_primary_events() {
    let server = MockServer::start().await;
    mount_token_endpoint(&server, 3600).await;
    Mock::given(method("GET"))
        .and(path("/calendar/v3/calendars/primary/events"))
        .and(query_param("timeMin", "2026-09-12T00:00:00Z"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [
                {"id": "e1", "summary": "Standup", "start": {"dateTime": "2026-09-14T10:00:00Z"}},
                {"id": "e2", "summary": "Offsite", "start": {"date": "2026-09-15"}}
            ]
        })))
        .mount(&server)
        .await;

    let outcome = connector()
        .execute(
            &config(&server),
            "calendar_list_events",
            json!({"time_min": "2026-09-12T00:00:00Z"}),
            &secrets(),
            None,
        )
        .await
        .expect("calendar_list_events succeeds");
    assert!(outcome.content.contains("Standup"));
    assert!(outcome.content.contains("2026-09-14T10:00:00Z"));
    assert!(outcome.content.contains("Offsite"));
    assert!(outcome.content.contains("2026-09-15"));
}

#[tokio::test]
async fn calendar_list_events_defaults_time_min_to_now() {
    let server = MockServer::start().await;
    mount_token_endpoint(&server, 3600).await;
    Mock::given(method("GET"))
        .and(path("/calendar/v3/calendars/primary/events"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"items": []})))
        .mount(&server)
        .await;

    let outcome = connector()
        .execute(
            &config(&server),
            "calendar_list_events",
            json!({}),
            &secrets(),
            None,
        )
        .await
        .expect("calendar_list_events succeeds");
    assert!(outcome.content.contains("No events"));

    let requests = server.received_requests().await.unwrap();
    let api_req = requests
        .iter()
        .find(|r| r.url.path() == "/calendar/v3/calendars/primary/events")
        .unwrap();
    let time_min = api_req
        .url
        .query_pairs()
        .find(|(k, _)| k == "timeMin")
        .map(|(_, v)| v.to_string())
        .expect("timeMin is always sent");
    let sent = chrono::DateTime::parse_from_rfc3339(&time_min).expect("timeMin is RFC3339");
    let age = chrono::Utc::now().signed_duration_since(sent);
    assert!(
        age.num_seconds() >= 0 && age.num_seconds() < 120,
        "timeMin {time_min} is close to now"
    );
}

#[tokio::test]
async fn drive_search_builds_name_contains_query() {
    let server = MockServer::start().await;
    mount_token_endpoint(&server, 3600).await;
    Mock::given(method("GET"))
        .and(path("/drive/v3/files"))
        .and(query_param("q", "name contains 'Quarterly Report'"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "files": [
                {"id": "f-1", "name": "Quarterly Report Q3", "mimeType": "application/vnd.google-apps.document"}
            ]
        })))
        .mount(&server)
        .await;

    let outcome = connector()
        .execute(
            &config(&server),
            "drive_search",
            json!({"name": "Quarterly Report"}),
            &secrets(),
            None,
        )
        .await
        .expect("drive_search succeeds");
    assert!(outcome.content.contains("Quarterly Report Q3"));
    assert!(outcome.content.contains("f-1"));
}

#[tokio::test]
async fn directory_users_defaults_to_admin_email_domain() {
    let server = MockServer::start().await;
    mount_token_endpoint(&server, 3600).await;
    Mock::given(method("GET"))
        .and(path("/admin/directory/v1/users"))
        .and(query_param("domain", "example.com"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "users": [
                {"primaryEmail": "bob@example.com", "name": {"fullName": "Bob Example"}}
            ]
        })))
        .mount(&server)
        .await;

    let outcome = connector()
        .execute(
            &config(&server),
            "directory_users",
            json!({}),
            &secrets(),
            None,
        )
        .await
        .expect("directory_users succeeds");
    assert!(outcome.content.contains("bob@example.com"));
    assert!(outcome.content.contains("Bob Example"));
}

#[tokio::test]
async fn unknown_tool_is_an_error() {
    let outcome = connector()
        .execute(&json!({}), "gmail_send", json!({}), &secrets(), None)
        .await;
    let err = outcome.expect_err("unknown tool");
    assert!(err.contains("no tool"), "error: {err}");
}

#[tokio::test]
async fn api_passthrough_carries_identity_token() {
    let server = MockServer::start().await;
    mount_token_endpoint(&server, 3600).await;
    Mock::given(method("GET"))
        .and(path("/drive/v3/files"))
        .and(header(
            "authorization",
            format!("Bearer {FAKE_ACCESS_TOKEN}"),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"files": []})))
        .expect(1)
        .mount(&server)
        .await;

    let plugin = integration_by_name("google_workspace").unwrap();
    let out = plugin
        .execute(
            &config(&server),
            "api",
            json!({"path": "/drive/v3/files", "query": {"pageSize": "5"}}),
            &secrets(),
            None,
        )
        .await
        .unwrap();
    assert_eq!(out.meta.unwrap()["status"], 200);
}

// ---------- cache isolation ----------

/// Another org configured the same client_email (not a secret) with its own
/// RSA key: the credential is part of the cache key, so the second org
/// never receives the first org's cached token — it signs its own exchange
/// (which also means a rotated/revoked key cannot ride a stale cache entry
/// past a `test_connection`).
#[tokio::test]
async fn different_private_keys_under_one_client_email_never_share_cached_tokens() {
    let server = MockServer::start().await;
    mount_token_endpoint(&server, 3600).await;
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "messages": [],
            "resultSizeEstimate": 0
        })))
        .mount(&server)
        .await;

    let cfg = config(&server);
    let c = connector();
    let second_secrets = vec![
        (
            "service_account_json".to_string(),
            json!({
                "type": "service_account",
                "project_id": "guild-test",
                "client_email": CLIENT_EMAIL,
                "private_key": SECOND_PRIVATE_KEY,
                "token_uri": "https://oauth2.googleapis.com/token"
            })
            .to_string(),
        ),
        ("admin_email".to_string(), ADMIN_EMAIL.to_string()),
    ];
    c.execute(
        &cfg,
        "gmail_search",
        json!({"query": "q"}),
        &secrets(),
        None,
    )
    .await
    .expect("first credential succeeds");
    c.execute(
        &cfg,
        "gmail_search",
        json!({"query": "q"}),
        &second_secrets,
        None,
    )
    .await
    .expect("second credential succeeds");

    // Two credentials under one client_email: two exchanges, no sharing.
    let token_calls = server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.url.path() == "/token")
        .collect::<Vec<_>>();
    assert_eq!(
        token_calls.len(),
        2,
        "each credential exchanges its own token"
    );
    // The second exchange was signed with the SECOND key.
    let second_assertion = token_calls
        .last()
        .map(|r| String::from_utf8(r.body.clone()).unwrap())
        .map(|body| {
            body.split('&')
                .find_map(|pair| pair.strip_prefix("assertion="))
                .unwrap()
                .to_string()
        })
        .unwrap();
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[cfg["token_url"].as_str().unwrap()]);
    jsonwebtoken::decode::<GwClaims>(
        &second_assertion,
        &jsonwebtoken::DecodingKey::from_rsa_pem(SECOND_PUBLIC_KEY.as_bytes()).unwrap(),
        &validation,
    )
    .expect("the second exchange is signed by the second credential");
}

// ---------- script-caller identity (HTTP path) ----------

/// A member's API key calling a read tool mints Google tokens as the
/// MEMBER'S email — never the admin/default subject (any member can mint a
/// key; the default subject is the domain-wide-delegation admin, so an
/// unmapped caller must never fall back to it). An admin-minted org key
/// keeps the designed admin default. The gateway also refuses a non-admin
/// call with no resolvable identity on this impersonating connector
/// (unit-level guard in the script handler).
#[tokio::test]
async fn member_api_key_never_mints_the_admin_subject() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    let server = MockServer::start().await;
    mount_token_endpoint(&server, 3600).await;
    Mock::given(method("GET"))
        .and(path("/gmail/v1/users/me/messages"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "messages": [],
            "resultSizeEstimate": 0
        })))
        .mount(&server)
        .await;

    let db = guild_server::store::Store::connect_test()
        .await
        .expect("postgres");
    let state = guild_server::state::AppState::with_store(
        std::sync::Arc::new(db.store.clone()),
        guild_server::config::Config::test_config(),
    );
    let store = db.store.clone();
    let admin_id = store
        .identity()
        .ensure_bootstrap_admin("gw-owner@example.org", "hunter226")
        .await
        .unwrap();
    let admin = store.identity().get_user(admin_id).await.unwrap();
    let org = admin.org_id;
    let member = store
        .identity()
        .create_user(org, "gw-member@example.org", "hunter226", "member")
        .await
        .unwrap();
    let member_email = store.identity().get_user(member.id).await.unwrap().email;

    store
        .integrations()
        .upsert(
            org,
            "google_workspace",
            &json!({
                "api_base": server.uri(),
                "token_url": format!("{}/token", server.uri()),
                "admin_email": ADMIN_EMAIL,
            }),
            true,
        )
        .await
        .unwrap();
    store
        .integration_secrets()
        .upsert(
            org,
            "google_workspace",
            "service_account_json",
            &service_account_json(),
            &[0u8; 32],
        )
        .await
        .unwrap();

    let app = guild_server::build_router(state);
    let call = |app: axum::Router, auth: String| async move {
        app.oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/integrations/google_workspace/tools/gmail_search")
                .header("authorization", format!("Bearer {auth}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"query": "q"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
    };

    // The member mints their own key and searches Gmail.
    let (_, member_token) = store.identity().create_session(member.id).await.unwrap();
    let mint = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/api-keys")
                .header("authorization", format!("Bearer {member_token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"name": "k"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(mint.status(), axum::http::StatusCode::OK);
    let minted: Value = serde_json::from_slice(
        &axum::body::to_bytes(mint.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let res = call(
        app.clone(),
        minted["plaintext"].as_str().unwrap().to_string(),
    )
    .await;
    assert_eq!(res.status(), axum::http::StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["ok"], true, "{body}");
    // The token subject is the member's own email, not the admin's.
    let assertion = captured_assertion(&server).await;
    verify_service_account_jwt(
        &assertion,
        &member_email,
        &format!("{}/token", server.uri()),
    );

    // An admin-minted org key (no separate owner) resolves to the ADMIN's
    // own email — the designed default subject for the one principal that
    // holds the delegation.
    let org_key = store
        .api_keys()
        .create(org, admin_id, "org", None, None)
        .await
        .unwrap();
    let res = call(app, org_key.plaintext).await;
    assert_eq!(res.status(), axum::http::StatusCode::OK);

    // Two exchanges: the first as the member, the second as the admin —
    // each caller's own identity, never someone else's.
    let token_calls: Vec<String> = server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|r| r.url.path() == "/token")
        .map(|r| String::from_utf8(r.body).unwrap())
        .collect();
    assert_eq!(token_calls.len(), 2, "each caller exchanges its own token");
    let sub_of = |body: &String| {
        body.split('&')
            .find_map(|pair| pair.strip_prefix("assertion="))
            .unwrap()
            .to_string()
    };
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_audience(&[format!("{}/token", server.uri())]);
    let decode = |assertion: &str| {
        jsonwebtoken::decode::<GwClaims>(
            assertion,
            &jsonwebtoken::DecodingKey::from_rsa_pem(FAKE_PUBLIC_KEY.as_bytes()).unwrap(),
            &validation,
        )
        .unwrap()
        .claims
        .sub
    };
    assert_eq!(decode(&sub_of(&token_calls[0])), member_email);
    // The org key's principal is the admin account itself (its login
    // email) — not some other principal's identity.
    assert_eq!(decode(&sub_of(&token_calls[1])), admin.email);
}
