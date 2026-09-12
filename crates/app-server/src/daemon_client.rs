//! Blocking client for the local daemon — every headless CLI verb goes
//! through it so the daemon is the only cloud route (spec §3.3).

use crate::daemon::{attach, Pair};
use anyhow::Context as _;
use protocol::rpc::Request;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::Path;

pub struct DaemonClient {
    reader: BufReader<Box<dyn std::io::Read + Send>>,
    writer: Box<dyn std::io::Write + Send>,
    next_id: u64,
}

impl DaemonClient {
    pub fn from_pair(pair: Pair) -> Self {
        let Pair(rd, wr, _) = pair;
        Self {
            reader: BufReader::new(rd),
            writer: wr,
            next_id: 0,
        }
    }

    pub fn attach(bin: &Path) -> anyhow::Result<Self> {
        Ok(Self::from_pair(attach(bin)?))
    }

    fn write_req(&mut self, id: u64, method: &str, params: &Value) -> anyhow::Result<()> {
        use std::io::Write as _;
        writeln!(
            self.writer,
            "{}",
            serde_json::to_string(&Request::new(id, method, params.clone()))?
        )?;
        self.writer.flush()?;
        Ok(())
    }

    /// One line; None on EOF.
    fn read_line(&mut self) -> anyhow::Result<Option<Value>> {
        let mut line = String::new();
        let n = self.reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        Ok(Some(serde_json::from_str(line.trim())?))
    }

    pub fn call(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        self.call_streaming(method, params, |_| {})
    }

    /// Sends the request, pumps events to `on_event`, returns when the
    /// response for this request id arrives. Events that arrive after the
    /// response stay buffered for later calls to drain (see
    /// `call_until_event` when a trailing event is the thing you wait for).
    pub fn call_streaming(
        &mut self,
        method: &str,
        params: Value,
        mut on_event: impl FnMut(Value),
    ) -> anyhow::Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_req(id, method, &params)?;
        loop {
            let v = self.read_line()?.context("daemon closed the connection")?;
            if v.get("event").is_some() {
                on_event(v);
                continue;
            }
            if v["id"].as_u64() == Some(id) {
                return match v.get("error") {
                    Some(err) => Err(anyhow::anyhow!(
                        err["message"].as_str().unwrap_or("rpc error").to_string()
                    )),
                    None => Ok(v["result"].clone()),
                };
            }
            // A private connection can only carry responses for the request
            // that is in flight; anything else is a protocol violation.
            anyhow::bail!("unexpected response id {} for request {id}", v["id"]);
        }
    }

    /// Like `call_streaming`, but keeps reading past the response until
    /// `stop_event` arrives; returns (response, events in arrival order).
    pub fn call_until_event(
        &mut self,
        method: &str,
        params: Value,
        stop_event: &str,
    ) -> anyhow::Result<(Value, Vec<Value>)> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_req(id, method, &params)?;
        let mut events = Vec::new();
        let response = loop {
            let v = self.read_line()?.context("daemon closed the connection")?;
            if v.get("event").is_some() {
                events.push(v);
                continue;
            }
            if v["id"].as_u64() == Some(id) {
                break match v.get("error") {
                    Some(err) => Err(anyhow::anyhow!(
                        err["message"].as_str().unwrap_or("rpc error").to_string()
                    )),
                    None => Ok(v["result"].clone()),
                };
            }
            anyhow::bail!("unexpected response id {} for request {id}", v["id"]);
        };
        let response = response?;
        while events
            .last()
            .map(|v| v["event"].as_str() != Some(stop_event))
            .unwrap_or(true)
        {
            let v = self
                .read_line()?
                .with_context(|| format!("daemon closed before {stop_event}"))?;
            if v.get("event").is_some() {
                events.push(v);
            }
        }
        Ok((response, events))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};

    /// The client holds ONE end for both directions; the fake server writes
    /// to the other end and keeps it open until the client is done. (Writes
    /// to one socketpair end arrive at the other — crossing the ends would
    /// make the client read back its own requests.)
    /// Test client with a read timeout: a regression fails fast instead of
    /// hanging the whole suite.
    fn client_with_timeout(
        client_side: std::os::unix::net::UnixStream,
    ) -> DaemonClient {
        client_side
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        DaemonClient::from_pair(Pair(
            Box::new(client_side.try_clone().unwrap()),
            Box::new(client_side),
            None,
        ))
    }

    fn fake_server(server_side: std::os::unix::net::UnixStream, lines: &[String]) {
        let mut wr = server_side.try_clone().unwrap();
        let mut rd = server_side;
        for l in lines {
            writeln!(wr, "{l}").unwrap();
        }
        // Stay open until the client closes its end, so mid-test reads see
        // the written lines and never a premature EOF (EPIPE / EOF race).
        let _ = rd.read_to_end(&mut Vec::new());
    }

    /// A response for the request id ends call_streaming; events after it
    /// stay buffered and are drained by the next call.
    #[test]
    fn demux_responses_and_events() {
        let (server_side, client_side) = std::os::unix::net::UnixStream::pair().unwrap();
        std::thread::spawn(move || {
            fake_server(
                server_side,
                &[
                    r#"{"protocol":1,"event":"chat.delta","payload":{"content":"hi"}}"#.into(),
                    r#"{"jsonrpc":"2.0","id":0,"protocol":1,"result":{"ok":true}}"#.into(),
                    r#"{"protocol":1,"event":"chat.done","payload":{}}"#.into(),
                    r#"{"jsonrpc":"2.0","id":1,"protocol":1,"result":{"ok":true}}"#.into(),
                ],
            )
        });
        let mut client = client_with_timeout(client_side);
        let mut events = Vec::new();
        let res = client
            .call_streaming("chat.send", json!({"text": "x"}), |ev| events.push(ev))
            .unwrap();
        assert_eq!(res["ok"], true);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["event"], "chat.delta");

        // the buffered chat.done is drained by the next call, ahead of its
        // own response
        let mut seen = Vec::new();
        let res2 = client
            .call_streaming("agent.policy.get", json!({}), |ev| seen.push(ev))
            .unwrap();
        assert_eq!(res2["ok"], true);
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["event"], "chat.done");
    }

    /// call_until_event waits for the named event even after the response.
    #[test]
    fn call_until_event_waits_for_trailing_event() {
        let (server_side, client_side) = std::os::unix::net::UnixStream::pair().unwrap();
        std::thread::spawn(move || {
            fake_server(
                server_side,
                &[
                    r#"{"jsonrpc":"2.0","id":0,"protocol":1,"result":{"chat_id":"c"}}"#.into(),
                    r#"{"protocol":1,"event":"chat.delta","payload":{"content":"hello"}}"#.into(),
                    r#"{"protocol":1,"event":"chat.done","payload":{}}"#.into(),
                ],
            )
        });
        let mut client = client_with_timeout(client_side);
        let (res, events) = client
            .call_until_event("chat.send", json!({"text": "x"}), "chat.done")
            .unwrap();
        assert_eq!(res["chat_id"], "c");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["payload"]["content"], "hello");
        assert_eq!(events.last().unwrap()["event"], "chat.done");
    }

    /// An error response surfaces as Err with the server's message.
    #[test]
    fn error_response_surfaces() {
        let (server_side, client_side) = std::os::unix::net::UnixStream::pair().unwrap();
        std::thread::spawn(move || {
            fake_server(
                server_side,
                &[r#"{"jsonrpc":"2.0","id":0,"protocol":1,"error":{"code":-32000,"message":"not logged in"}}"#.into()],
            )
        });
        let mut client = client_with_timeout(client_side);
        let err = client.call("session.info", json!({})).unwrap_err();
        assert!(err.to_string().contains("not logged in"));
    }
}
