//! Blocking client for the engine's local socket — every cloud-touching
//! CLI verb goes through it, so the hosting engine (the desktop app, or a
//! headless `daemon`) owns the session.

use crate::daemon::{attach, Pair};
use anyhow::Context as _;
use protocol::rpc::Request;
use serde_json::Value;
use std::io::{BufRead, BufReader};

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

    pub fn attach() -> anyhow::Result<Self> {
        Ok(Self::from_pair(attach()?))
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

    /// Sends the request and returns its result once the response for this
    /// request id arrives. Event lines (`rpc.error` for an unparseable
    /// line) are skipped.
    pub fn call(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_req(id, method, &params)?;
        loop {
            let v = self.read_line()?.context("daemon closed the connection")?;
            if v.get("event").is_some() {
                continue;
            }
            if v["id"].as_u64() == Some(id) {
                return match v.get("error") {
                    Some(err) => Err(anyhow::anyhow!(err["message"]
                        .as_str()
                        .unwrap_or("rpc error")
                        .to_string())),
                    None => Ok(v["result"].clone()),
                };
            }
            // A private connection can only carry responses for the request
            // that is in flight; anything else is a protocol violation.
            anyhow::bail!("unexpected response id {} for request {id}", v["id"]);
        }
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
    fn client_with_timeout(client_side: std::os::unix::net::UnixStream) -> DaemonClient {
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

    /// Each call returns its own response; an event line in between is
    /// skipped.
    #[test]
    fn calls_match_responses_and_skip_events() {
        let (server_side, client_side) = std::os::unix::net::UnixStream::pair().unwrap();
        std::thread::spawn(move || {
            fake_server(
                server_side,
                &[
                    r#"{"protocol":1,"event":"rpc.error","payload":{"message":"bad line"}}"#.into(),
                    r#"{"jsonrpc":"2.0","id":0,"protocol":1,"result":{"n":0}}"#.into(),
                    r#"{"jsonrpc":"2.0","id":1,"protocol":1,"result":{"n":1}}"#.into(),
                ],
            )
        });
        let mut client = client_with_timeout(client_side);
        assert_eq!(client.call("session.info", json!({})).unwrap()["n"], 0);
        assert_eq!(client.call("session.info", json!({})).unwrap()["n"], 1);
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
