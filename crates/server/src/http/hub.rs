//! Connection hub for browser member sockets and machine singleton sockets.
//! Liveness is represented by a socket held in the hub. The mutex is never
//! held across an await.

use super::ws::SocketSink;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::watch;
use uuid::Uuid;

pub const MAX_SOCKETS_PER_USER: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapRejected;

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

#[derive(Default)]
pub struct Hub {
    inner: Mutex<HubInner>,
}

#[derive(Default)]
struct HubInner {
    machines: HashMap<String, MachineSlot>,
    members: HashMap<Uuid, HashMap<Uuid, Member>>,
}

impl Hub {
    /// Registers a browser socket, rejecting a new connection over the limit.
    pub fn register_member(&self, m: Member) -> Result<(), ()> {
        let mut guard = self.inner.lock().unwrap();
        let already_registered = guard
            .members
            .get(&m.user_id)
            .is_some_and(|members| members.contains_key(&m.conn_id));
        if !already_registered && self.socket_count(&guard, m.user_id) >= MAX_SOCKETS_PER_USER {
            return Err(());
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
    /// replaces the old holder and tells it to close before its sink drops.
    pub async fn register_machine(
        &self,
        m: Member,
        machine_id: &str,
    ) -> Result<MachineRegistration, CapRejected> {
        let (shutdown, shutdown_rx) = watch::channel(false);
        let old = {
            let mut guard = self.inner.lock().unwrap();
            let old = guard
                .machines
                .get(machine_id)
                .map(|slot| slot.holder.clone());
            let replacing_existing_machine = old
                .as_ref()
                .is_some_and(|holder| holder.user_id == m.user_id);
            let socket_count = self.socket_count(&guard, m.user_id);
            let socket_count_after_replace =
                socket_count.saturating_sub(usize::from(replacing_existing_machine));
            if socket_count_after_replace >= MAX_SOCKETS_PER_USER {
                return Err(CapRejected);
            }
            guard.machines.insert(
                machine_id.to_owned(),
                MachineSlot {
                    holder: m,
                    shutdown,
                },
            )
        };

        if let Some(old) = old {
            let _ = old.shutdown.send(true);
            old.holder.sink.displace();
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
        let is_current = guard
            .machines
            .get(machine_id)
            .is_some_and(|slot| slot.holder.conn_id == conn_id);
        if is_current {
            guard.machines.remove(machine_id);
        }
    }

    pub fn machine_online(&self, machine_id: &str) -> bool {
        self.inner.lock().unwrap().machines.contains_key(machine_id)
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
            sink: socket_channel(8).0,
            label: None,
        }
    }

    #[tokio::test]
    async fn machine_singleton_newest_wins_and_notifies_displaced() {
        let hub = Hub::default();
        let (old_sink, mut old_rx) = socket_channel(8);
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
        assert!(hub.sinks_of_user(user_id).is_empty());
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
                sink: socket_channel(1).0,
                label: None,
            };
            hub.register_member(m).unwrap();
        }
        let over = Member {
            conn_id: Uuid::now_v7(),
            user_id,
            org_id: Uuid::now_v7(),
            sink: socket_channel(1).0,
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
                sink: socket_channel(1).0,
                label: None,
            })
            .unwrap();
        }
        let machine = Member {
            conn_id: Uuid::now_v7(),
            user_id,
            org_id: Uuid::now_v7(),
            sink: socket_channel(1).0,
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
                sink: socket_channel(1).0,
                label: None,
            })
            .unwrap();
        }
        let first = Member {
            conn_id: Uuid::now_v7(),
            user_id,
            org_id: Uuid::now_v7(),
            sink: socket_channel(1).0,
            label: None,
        };
        let first_registration = hub.register_machine(first, "replaceable").await.unwrap();
        drop(first_registration);
        let replacement = Member {
            conn_id: Uuid::now_v7(),
            user_id,
            org_id: Uuid::now_v7(),
            sink: socket_channel(1).0,
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
                sink: socket_channel(1).0,
                label: None,
            })
            .is_err());
    }

    #[tokio::test]
    async fn displacement_signal_wakes_holder_when_sink_is_full() {
        let hub = Hub::default();
        let (old_sink, mut old_rx) = socket_channel(1);
        old_sink.send(WsServerMsg::Hello).await.unwrap();
        let old = Member {
            conn_id: Uuid::now_v7(),
            user_id: Uuid::now_v7(),
            org_id: Uuid::now_v7(),
            sink: old_sink,
            label: None,
        };
        let registration = hub.register_machine(old, "full-queue").await.unwrap();
        let mut shutdown = registration.shutdown;
        let new = member();
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
        assert!(old_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn machine_registration_does_not_wait_for_blocked_reader_enqueue() {
        let hub = Hub::default();
        let (old_sink, mut old_rx) = socket_channel(1);
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

        // Poll the reader's sync enqueue once: the full queue keeps it
        // pending with the ordering mutex held throughout registration.
        let mut reader_enqueue = Box::pin(old_sink.start_sync());
        assert!(futures::poll!(&mut reader_enqueue).is_pending());
        let (new_sink, mut new_rx) = socket_channel(1);
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
        assert!(futures::poll!(&mut reader_enqueue).is_pending());

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
        drop(reader_enqueue);
        assert!(matches!(
            old_rx.try_recv().unwrap(),
            SocketOutput::Message(WsServerMsg::Hello)
        ));
        assert!(old_rx.try_recv().is_err());
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
