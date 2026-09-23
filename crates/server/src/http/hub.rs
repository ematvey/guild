//! Connection hub for browser member sockets and machine singleton sockets.
//! Liveness is represented by a socket held in the hub. The mutex is never
//! held across an await.

use super::ws::SocketSink;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::{oneshot, watch};
use uuid::Uuid;

pub const MAX_SOCKETS_PER_USER: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapRejected;

#[derive(Debug)]
pub enum MachineRejected {
    Cap,
    Displaced,
    /// The machine slot is held by a different user: a machine socket is
    /// claimed only by its owner (newest-wins displacement applies within
    /// one user's own reconnections).
    ForeignOwner,
}

pub struct MachineRegistration {
    pub displaced: bool,
    pub shutdown: watch::Receiver<bool>,
}

/// One connected socket. The sink is the outbound queue drained by the
/// socket's writer task.
#[derive(Clone)]
pub struct Member {
    pub conn_id: Uuid,
    pub user_id: Uuid,
    pub org_id: Uuid,
    pub sink: SocketSink,
    pub label: Option<String>,
}

struct MachineSlot {
    holder: Member,
    shutdown: watch::Sender<bool>,
}

/// A machine control-plane request waiting for its `MachineResponse`.
#[derive(Debug)]
pub enum MachineRequestError {
    Offline,
    SendFailed,
    TimedOut,
    /// The machine answered with ok=false (error text inside).
    Rejected(String),
}

struct PendingMachineRequest {
    connection_id: Uuid,
    org_id: Uuid,
    reply: oneshot::Sender<Result<serde_json::Value, String>>,
}

struct PendingRequestGuard<'a> {
    hub: &'a Hub,
    request_id: String,
}
impl Drop for PendingRequestGuard<'_> {
    fn drop(&mut self) {
        self.hub
            .inner
            .lock()
            .unwrap()
            .machine_requests
            .remove(&self.request_id);
    }
}

#[derive(Default)]
pub struct Hub {
    inner: Mutex<HubInner>,
}

#[derive(Default)]
struct HubInner {
    machines: HashMap<String, MachineSlot>,
    /// Last instance claim survives disconnect, so a stale reconnect cannot
    /// reclaim the slot after losing its terminal notice.
    owners: HashMap<String, Uuid>,
    members: HashMap<Uuid, HashMap<Uuid, Member>>,
    machine_requests: HashMap<String, PendingMachineRequest>,
}

#[derive(Debug, thiserror::Error)]
#[error("socket limit reached")]
pub struct SocketLimitReached;

impl Hub {
    /// Registers a browser socket, rejecting a new connection over the limit.
    pub fn register_member(&self, m: Member) -> Result<(), SocketLimitReached> {
        let mut guard = self.inner.lock().unwrap();
        let already_registered = guard
            .members
            .get(&m.user_id)
            .is_some_and(|members| members.contains_key(&m.conn_id));
        if !already_registered && self.socket_count(&guard, m.user_id) >= MAX_SOCKETS_PER_USER {
            return Err(SocketLimitReached);
        }
        guard
            .members
            .entry(m.user_id)
            .or_default()
            .insert(m.conn_id, m);
        Ok(())
    }

    fn socket_count(&self, guard: &HubInner, user_id: Uuid) -> usize {
        let members = guard.members.get(&user_id).map_or(0, HashMap::len);
        let machines = guard
            .machines
            .values()
            .filter(|slot| slot.holder.user_id == user_id)
            .count();
        members + machines
    }

    /// Registers the only socket allowed for a machine. A newer connection
    /// replaces the old holder and tells it to close before its sink drops —
    /// but never a holder of a different user: a machine slot is owned, so
    /// a foreign claim is refused instead of displacing the real executor.
    pub async fn register_machine(
        &self,
        m: Member,
        machine_id: &str,
    ) -> Result<MachineRegistration, CapRejected> {
        self.register_machine_instance(m, machine_id, Uuid::now_v7(), false)
            .await
            .map_err(|_| CapRejected)
    }

    pub async fn register_machine_instance(
        &self,
        m: Member,
        machine_id: &str,
        instance: Uuid,
        resume: bool,
    ) -> Result<MachineRegistration, MachineRejected> {
        let (shutdown, shutdown_rx) = watch::channel(false);
        let old = {
            let mut guard = self.inner.lock().unwrap();
            if resume
                && guard
                    .owners
                    .get(machine_id)
                    .is_some_and(|owner| *owner != instance)
            {
                return Err(MachineRejected::Displaced);
            }
            let old = guard
                .machines
                .get(machine_id)
                .map(|slot| slot.holder.clone());
            if old
                .as_ref()
                .is_some_and(|holder| holder.user_id != m.user_id)
            {
                // Ownership gate: the current holder is a different user, so
                // the claim never displaces it (a machine slot belongs to
                // its user — newest-wins applies within one user only).
                return Err(MachineRejected::ForeignOwner);
            }
            let replacing_existing_machine = old
                .as_ref()
                .is_some_and(|holder| holder.user_id == m.user_id);
            let socket_count = self.socket_count(&guard, m.user_id);
            let socket_count_after_replace =
                socket_count.saturating_sub(usize::from(replacing_existing_machine));
            if socket_count_after_replace >= MAX_SOCKETS_PER_USER {
                return Err(MachineRejected::Cap);
            }
            guard.owners.insert(machine_id.to_owned(), instance);
            guard.machines.insert(
                machine_id.to_owned(),
                MachineSlot {
                    holder: m,
                    shutdown,
                },
            )
        };

        if let Some(old) = old {
            old.holder.sink.displace();
            let _ = old.shutdown.send(true);
            Ok(MachineRegistration {
                displaced: true,
                shutdown: shutdown_rx,
            })
        } else {
            Ok(MachineRegistration {
                displaced: false,
                shutdown: shutdown_rx,
            })
        }
    }

    pub fn unregister_member(&self, user_id: Uuid, conn_id: Uuid) {
        let mut guard = self.inner.lock().unwrap();
        let Some(per_user) = guard.members.get_mut(&user_id) else {
            return;
        };
        per_user.remove(&conn_id);
        if per_user.is_empty() {
            guard.members.remove(&user_id);
        }
    }

    pub fn unregister_machine(&self, machine_id: &str, conn_id: Uuid) {
        let mut guard = self.inner.lock().unwrap();
        guard
            .machine_requests
            .retain(|_, pending| pending.connection_id != conn_id);
        let is_current = guard
            .machines
            .get(machine_id)
            .is_some_and(|slot| slot.holder.conn_id == conn_id);
        if is_current {
            guard.machines.remove(machine_id);
        }
    }

    /// Displaces a machine's live socket without a replacement: registry
    /// adoption re-keyed the row away from this id, so the old registration
    /// no longer has a registry identity to hold.
    pub fn displace_machine(&self, machine_id: &str) -> bool {
        let slot = self.inner.lock().unwrap().machines.remove(machine_id);
        match slot {
            Some(slot) => {
                slot.holder.sink.displace();
                let _ = slot.shutdown.send(true);
                true
            }
            None => false,
        }
    }

    pub(crate) fn machine_holder(&self, machine_id: &str) -> Option<Member> {
        self.inner
            .lock()
            .unwrap()
            .machines
            .get(machine_id)
            .map(|slot| slot.holder.clone())
    }

    /// Sends a control-plane request to the machine's executor socket and
    /// awaits its `MachineResponse`. Offline/send/timeout are clean errors;
    /// the machine's own refusal arrives as `Rejected`.
    pub async fn machine_request(
        &self,
        machine_id: &str,
        org_id: Uuid,
        op: &str,
        payload: serde_json::Value,
        timeout: std::time::Duration,
    ) -> Result<serde_json::Value, MachineRequestError> {
        let holder = self
            .machine_holder(machine_id)
            .filter(|holder| holder.org_id == org_id)
            .ok_or(MachineRequestError::Offline)?;
        let request_id = Uuid::now_v7().to_string();
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.inner.lock().unwrap();
            guard.machine_requests.insert(
                request_id.clone(),
                PendingMachineRequest {
                    connection_id: holder.conn_id,
                    org_id,
                    reply: tx,
                },
            );
        }
        let _pending = PendingRequestGuard {
            hub: self,
            request_id: request_id.clone(),
        };
        let sent = holder
            .sink
            .try_send(protocol::ws::WsServerMsg::MachineRequest {
                request_id: request_id.clone(),
                op: op.to_owned(),
                payload,
            });
        if sent.is_err() {
            self.inner
                .lock()
                .unwrap()
                .machine_requests
                .remove(&request_id);
            return Err(MachineRequestError::SendFailed);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(payload))) => Ok(payload),
            Ok(Ok(Err(error))) => Err(MachineRequestError::Rejected(error)),
            // Responder dropped without a send: the machine disconnected
            // while the request was in flight.
            Ok(Err(_)) => Err(MachineRequestError::Offline),
            Err(_) => {
                // Elapsed timer: drop the pending entry so the late response
                // (if the machine still answers) finds no waiter.
                self.inner
                    .lock()
                    .unwrap()
                    .machine_requests
                    .remove(&request_id);
                Err(MachineRequestError::TimedOut)
            }
        }
    }

    /// Routes a machine's `MachineResponse` to its waiter (from the socket
    /// inbound path). Unknown request ids are dropped silently — a request
    /// whose timer already fired.
    pub fn resolve_machine_response(
        &self,
        member: &Member,
        request_id: &str,
        ok: bool,
        payload: Option<serde_json::Value>,
        error: Option<String>,
    ) {
        let mut guard = self.inner.lock().unwrap();
        let matches = guard
            .machine_requests
            .get(request_id)
            .is_some_and(|pending| {
                pending.connection_id == member.conn_id && pending.org_id == member.org_id
            });
        if !matches {
            return;
        }
        if let Some(pending) = guard.machine_requests.remove(request_id) {
            let tx = pending.reply;
            let _ = tx.send(if ok {
                Ok(payload.unwrap_or(serde_json::Value::Null))
            } else {
                Err(error.unwrap_or_else(|| "machine refused".into()))
            });
        }
    }

    pub fn machine_connection(&self, machine_id: &str) -> Option<Uuid> {
        self.inner
            .lock()
            .unwrap()
            .machines
            .get(machine_id)
            .map(|slot| slot.holder.conn_id)
    }

    pub fn machine_online(&self, machine_id: &str) -> bool {
        self.inner.lock().unwrap().machines.contains_key(machine_id)
    }

    /// Returns the connection label, falling back to the machine id.
    pub fn machine_label(&self, machine_id: &str) -> Option<String> {
        self.inner
            .lock()
            .unwrap()
            .machines
            .get(machine_id)
            .map(|slot| {
                slot.holder
                    .label
                    .clone()
                    .filter(|label| !label.is_empty())
                    .unwrap_or_else(|| machine_id.to_owned())
            })
    }

    /// Returns whether a live machine belongs to the user or organization.
    pub fn machine_bindable(&self, machine_id: &str, user_id: Uuid, org_id: Uuid) -> bool {
        self.inner
            .lock()
            .unwrap()
            .machines
            .get(machine_id)
            .is_some_and(|slot| slot.holder.user_id == user_id || slot.holder.org_id == org_id)
    }

    /// Returns live `(machine_id, label)` entries for one user.
    pub fn machines_of_user(&self, user_id: Uuid) -> Vec<(String, String)> {
        self.inner
            .lock()
            .unwrap()
            .machines
            .iter()
            .filter(|(_, slot)| slot.holder.user_id == user_id)
            .map(|(id, slot)| {
                (
                    id.clone(),
                    slot.holder
                        .label
                        .clone()
                        .filter(|label| !label.is_empty())
                        .unwrap_or_else(|| id.clone()),
                )
            })
            .collect()
    }

    /// Returns browser sockets and machine sockets for one user.
    pub fn sinks_of_user(&self, user_id: Uuid) -> Vec<SocketSink> {
        let guard = self.inner.lock().unwrap();
        let mut sinks = guard
            .members
            .get(&user_id)
            .into_iter()
            .flat_map(|members| members.values().map(|member| member.sink.clone()))
            .collect::<Vec<_>>();
        sinks.extend(
            guard
                .machines
                .values()
                .filter(|slot| slot.holder.user_id == user_id)
                .map(|slot| slot.holder.sink.clone()),
        );
        sinks
    }

    #[cfg(test)]
    fn unregister_all_of_user_for_test(&self, user_id: Uuid) {
        let mut guard = self.inner.lock().unwrap();
        guard.members.remove(&user_id);
        guard
            .machines
            .retain(|_, slot| slot.holder.user_id != user_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::ws::{socket_channel, SocketOutput};
    use protocol::ws::WsServerMsg;

    fn member() -> Member {
        Member {
            conn_id: Uuid::now_v7(),
            user_id: Uuid::now_v7(),
            org_id: Uuid::now_v7(),
            sink: socket_channel().0,
            label: None,
        }
    }

    #[tokio::test]
    async fn stale_resume_cannot_displace_new_holder_even_after_old_writer_is_gone() {
        let hub = Hub::default();
        let old = member();
        let new = member();
        let old_instance = Uuid::now_v7();
        let new_instance = Uuid::now_v7();
        hub.register_machine_instance(old.clone(), "machine", old_instance, false)
            .await
            .unwrap();
        hub.unregister_machine("machine", old.conn_id);
        hub.register_machine_instance(new.clone(), "machine", new_instance, false)
            .await
            .unwrap();
        assert!(matches!(
            hub.register_machine_instance(old, "machine", old_instance, true)
                .await,
            Err(MachineRejected::Displaced)
        ));
        assert_eq!(hub.machine_connection("machine"), Some(new.conn_id));
    }

    #[tokio::test]
    async fn machine_singleton_newest_wins_and_notifies_displaced() {
        let hub = Hub::default();
        let (old_sink, mut old_rx) = socket_channel();
        let old = Member {
            conn_id: Uuid::now_v7(),
            user_id: Uuid::now_v7(),
            org_id: Uuid::now_v7(),
            sink: old_sink,
            label: None,
        };
        let user_id = old.user_id;
        let first_registration = hub.register_machine(old, "m1").await.unwrap();
        assert!(!first_registration.displaced);
        assert!(hub.machine_online("m1"));

        let mut new = member();
        new.label = Some("Desk".into());
        new.user_id = user_id; // same owner: newest-wins displacement applies
        let new_user_id = new.user_id;
        assert!(hub.register_machine(new, "m1").await.unwrap().displaced);
        assert!(hub.machine_online("m1"));
        assert_eq!(
            hub.machines_of_user(new_user_id),
            vec![("m1".into(), "Desk".into())]
        );
        assert!(matches!(
            old_rx.try_recv().unwrap(),
            SocketOutput::Message(WsServerMsg::Displaced)
        ));
        assert!(old_rx.try_recv().is_err());
        // The displaced holder's sink is gone; only the replacement remains
        // (both sockets belong to the same owner in this test).
        assert_eq!(hub.sinks_of_user(user_id).len(), 1);
    }

    #[tokio::test]
    async fn machine_label_falls_back_to_id_and_bindable_by_user_or_org() {
        let hub = Hub::default();
        let member = member();
        let user_id = member.user_id;
        let org_id = member.org_id;
        hub.register_machine(member, "m1").await.unwrap();

        assert_eq!(hub.machine_label("m1"), Some("m1".into()));
        assert!(hub.machine_bindable("m1", user_id, Uuid::now_v7()));
        assert!(hub.machine_bindable("m1", Uuid::now_v7(), org_id));
        assert!(!hub.machine_bindable("m1", Uuid::now_v7(), Uuid::now_v7()));
        assert_eq!(hub.machine_label("missing"), None);
    }

    #[tokio::test]
    async fn machine_label_uses_connection_name() {
        let hub = Hub::default();
        let mut machine = member();
        machine.label = Some("Desk".into());
        hub.register_machine(machine, "m1").await.unwrap();
        assert_eq!(hub.machine_label("m1"), Some("Desk".into()));
    }

    #[test]
    fn member_cap_is_thirty_two_and_drop_frees_the_slot() {
        let hub = Hub::default();
        let user_id = Uuid::now_v7();
        for _ in 0..MAX_SOCKETS_PER_USER {
            let m = Member {
                conn_id: Uuid::now_v7(),
                user_id,
                org_id: Uuid::now_v7(),
                sink: socket_channel().0,
                label: None,
            };
            hub.register_member(m).unwrap();
        }
        let over = Member {
            conn_id: Uuid::now_v7(),
            user_id,
            org_id: Uuid::now_v7(),
            sink: socket_channel().0,
            label: None,
        };
        assert!(hub.register_member(over).is_err());
        hub.unregister_all_of_user_for_test(user_id);
        assert!(hub.register_member(member()).is_ok());
    }

    #[test]
    fn unregister_member_removes_only_matching_connection() {
        let hub = Hub::default();
        let first = member();
        let second = Member {
            user_id: first.user_id,
            ..member()
        };
        let first_conn_id = first.conn_id;
        let first_user_id = first.user_id;
        hub.register_member(first).unwrap();
        hub.register_member(second).unwrap();
        hub.unregister_member(first_user_id, first_conn_id);
        assert_eq!(hub.sinks_of_user(first_user_id).len(), 1);
        hub.unregister_member(first_user_id, first_conn_id);
        assert_eq!(hub.sinks_of_user(first_user_id).len(), 1);
    }

    #[tokio::test]
    async fn machine_counts_against_user_socket_cap() {
        let hub = Hub::default();
        let user_id = Uuid::now_v7();
        for _ in 0..MAX_SOCKETS_PER_USER {
            hub.register_member(Member {
                conn_id: Uuid::now_v7(),
                user_id,
                org_id: Uuid::now_v7(),
                sink: socket_channel().0,
                label: None,
            })
            .unwrap();
        }
        let machine = Member {
            conn_id: Uuid::now_v7(),
            user_id,
            org_id: Uuid::now_v7(),
            sink: socket_channel().0,
            label: None,
        };
        assert!(hub.register_machine(machine, "full-machine").await.is_err());
    }

    #[tokio::test]
    async fn machine_replacement_keeps_one_budget_slot() {
        let hub = Hub::default();
        let user_id = Uuid::now_v7();
        for _ in 0..(MAX_SOCKETS_PER_USER - 1) {
            hub.register_member(Member {
                conn_id: Uuid::now_v7(),
                user_id,
                org_id: Uuid::now_v7(),
                sink: socket_channel().0,
                label: None,
            })
            .unwrap();
        }
        let first = Member {
            conn_id: Uuid::now_v7(),
            user_id,
            org_id: Uuid::now_v7(),
            sink: socket_channel().0,
            label: None,
        };
        let first_registration = hub.register_machine(first, "replaceable").await.unwrap();
        drop(first_registration);
        let replacement = Member {
            conn_id: Uuid::now_v7(),
            user_id,
            org_id: Uuid::now_v7(),
            sink: socket_channel().0,
            label: None,
        };
        assert!(
            hub.register_machine(replacement, "replaceable")
                .await
                .unwrap()
                .displaced
        );
        assert!(hub
            .register_member(Member {
                conn_id: Uuid::now_v7(),
                user_id,
                org_id: Uuid::now_v7(),
                sink: socket_channel().0,
                label: None,
            })
            .is_err());
    }

    #[tokio::test]
    async fn displacement_signal_and_notice_survive_queued_output() {
        let hub = Hub::default();
        let (old_sink, mut old_rx) = socket_channel();
        old_sink.send(WsServerMsg::Hello).await.unwrap();
        let old = Member {
            conn_id: Uuid::now_v7(),
            user_id: Uuid::now_v7(),
            org_id: Uuid::now_v7(),
            sink: old_sink,
            label: None,
        };
        let old_user_id = old.user_id;
        let registration = hub.register_machine(old, "full-queue").await.unwrap();
        let mut shutdown = registration.shutdown;
        let mut new = member();
        new.user_id = old_user_id; // same owner: displacement is same-user
        assert!(
            hub.register_machine(new, "full-queue")
                .await
                .unwrap()
                .displaced
        );
        assert!(*shutdown.borrow_and_update());
        assert!(matches!(
            old_rx.try_recv().unwrap(),
            SocketOutput::Message(WsServerMsg::Hello)
        ));
        assert!(matches!(
            old_rx.try_recv().unwrap(),
            SocketOutput::Message(WsServerMsg::Displaced)
        ));
        assert!(old_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn machine_registration_does_not_wait_for_stalled_writer() {
        let hub = Hub::default();
        let (old_sink, mut old_rx) = socket_channel();
        old_sink.send(WsServerMsg::Hello).await.unwrap();
        let old = Member {
            sink: old_sink.clone(),
            ..member()
        };
        let old_conn_id = old.conn_id;
        let user_id = old.user_id;
        let mut shutdown = hub
            .register_machine(old, "blocked-reader")
            .await
            .unwrap()
            .shutdown;

        // Queue a backlog without polling a writer.
        for _ in 0..256 {
            old_sink.send(WsServerMsg::Hello).await.unwrap();
        }
        // Pause the reader at its control operation while registration runs.
        let reader_enqueue = old_sink.start_sync();
        let (new_sink, mut new_rx) = socket_channel();
        let replacement = Member {
            user_id,
            sink: new_sink,
            ..member()
        };
        let registration = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            hub.register_machine(replacement, "blocked-reader"),
        )
        .await
        .expect("registration must not wait for the old reader or writer")
        .unwrap();
        assert!(registration.displaced);
        assert!(*shutdown.borrow_and_update());
        assert!(!*registration.shutdown.borrow());
        assert!(futures::poll!(Box::pin(reader_enqueue)).is_ready());

        // Late cleanup by the old socket must leave the replacement usable.
        hub.unregister_machine("blocked-reader", old_conn_id);
        assert!(hub.machine_online("blocked-reader"));
        let sinks = hub.sinks_of_user(user_id);
        assert_eq!(sinks.len(), 1);
        sinks[0].send(WsServerMsg::Hello).await.unwrap();
        assert!(matches!(
            new_rx.try_recv().unwrap(),
            SocketOutput::Message(WsServerMsg::Hello)
        ));
        for _ in 0..257 {
            assert!(matches!(
                old_rx.try_recv().unwrap(),
                SocketOutput::Message(WsServerMsg::Hello)
            ));
        }
        assert!(matches!(
            old_rx.try_recv().unwrap(),
            SocketOutput::Message(WsServerMsg::Displaced)
        ));
        assert!(matches!(
            old_rx.try_recv().unwrap(),
            SocketOutput::SyncStart
        ));
        assert!(old_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn control_response_requires_exact_dispatch_connection_and_org() {
        let hub = std::sync::Arc::new(Hub::default());
        let (sink, mut receiver) = socket_channel();
        let machine = Member { sink, ..member() };
        hub.register_machine(machine.clone(), "context-machine")
            .await
            .unwrap();
        let task_hub = hub.clone();
        let org = machine.org_id;
        let pending = tokio::spawn(async move {
            task_hub
                .machine_request(
                    "context-machine",
                    org,
                    "context.prepare_v1",
                    serde_json::json!({}),
                    std::time::Duration::from_secs(2),
                )
                .await
        });
        let request_id = match receiver.recv().await.unwrap() {
            SocketOutput::Message(WsServerMsg::MachineRequest { request_id, .. }) => request_id,
            _ => panic!("expected request"),
        };
        let wrong_connection = Member {
            conn_id: Uuid::now_v7(),
            ..machine.clone()
        };
        hub.resolve_machine_response(
            &wrong_connection,
            &request_id,
            true,
            Some(serde_json::json!("forged")),
            None,
        );
        let wrong_org = Member {
            org_id: Uuid::now_v7(),
            ..machine.clone()
        };
        hub.resolve_machine_response(
            &wrong_org,
            &request_id,
            true,
            Some(serde_json::json!("forged")),
            None,
        );
        assert!(!pending.is_finished());
        hub.resolve_machine_response(
            &machine,
            &request_id,
            true,
            Some(serde_json::json!("executor")),
            None,
        );
        assert_eq!(
            pending.await.unwrap().unwrap(),
            serde_json::json!("executor")
        );
    }

    #[tokio::test]
    async fn unregister_machine_only_by_current_holder() {
        let hub = Hub::default();
        let member = member();
        let conn_id = member.conn_id;
        let _ = hub.register_machine(member, "m2").await.unwrap();
        hub.unregister_machine("m2", Uuid::now_v7());
        assert!(hub.machine_online("m2"));
        hub.unregister_machine("m2", conn_id);
        assert!(!hub.machine_online("m2"));
    }
}
