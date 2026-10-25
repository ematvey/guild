//! Shared helpers for the app-server integration tests.

/// Collision-proof loopback listener.
pub async fn standalone_listener() -> tokio::net::TcpListener {
    loop {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // tokio's bind listens immediately, so OUR port is already in
        // /proc — exclude it before the collision check.
        let mut ports = std::collections::HashSet::<u16>::new();
        for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
            if let Ok(content) = std::fs::read_to_string(path) {
                for line in content.lines().skip(1) {
                    if let Some(p) = line.split_whitespace().nth(1) {
                        if let Ok(n) = u64::from_str_radix(p.rsplit(':').next().unwrap_or("0"), 16)
                        {
                            if n as u16 != port {
                                ports.insert(n as u16);
                            }
                        }
                    }
                }
            }
        }
        if !ports.contains(&port) {
            return listener;
        }
    }
}
