//! Connection hub for browser member sockets and machine singleton sockets.
//! Liveness is represented by a socket held in the hub. The mutex is never
//! held across an await.

use super::ws::SocketSink;
use protocol::ws::WsServerMsg;
use std::collections::HashMap;
use std::sync::Mutex;
use uuid::Uuid;

pub const MAX_SOCKETS_PER_USER: usize = 32;

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
    pub fn register_member(&self, m: Member, conn_id: Uuid) -> Result<(), ()> {
        let mut guard = self.inner.lock().unwrap();
        let per_user = guard.members.entry(m.user_id).or_default();
        if per_user.len() >= MAX_SOCKETS_PER_USER && !per_user.contains_key(&conn_id) {
            return Err(());
        }
        per_user.insert(conn_id, m);
        Ok(())
    }

    /// Registers the only socket allowed for a machine. A newer connection
    /// replaces the old holder and tells it to close before its sink drops.
    pub fn register_machine(&self, m: Member, machine_id: &str) -> bool {
        let old = {
            let mut guard = self.inner.lock().unwrap();
            guard
                .machines
                .insert(machine_id.to_owned(), MachineSlot { holder: m })
                .map(|slot| slot.holder)
        };

        if let Some(old) = old {
            let _ = old.sink.try_send(WsServerMsg::Displaced);
            true
        } else {
            false
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
        self.inner.lock().unwrap().members.remove(&user_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn member() -> Member {
        Member {
            conn_id: Uuid::now_v7(),
            user_id: Uuid::now_v7(),
            org_id: Uuid::now_v7(),
            sink: mpsc::channel(8).0,
            label: None,
        }
    }

    #[test]
    fn machine_singleton_newest_wins_and_notifies_displaced() {
        let hub = Hub::default();
        let (old_sink, mut old_rx) = mpsc::channel::<WsServerMsg>(8);
        let old = Member {
            conn_id: Uuid::now_v7(),
            user_id: Uuid::now_v7(),
            org_id: Uuid::now_v7(),
            sink: old_sink,
            label: None,
        };
        let user_id = old.user_id;
        hub.register_machine(old, "m1");
        assert!(hub.machine_online("m1"));

        let mut new = member();
        new.label = Some("Desk".into());
        let new_user_id = new.user_id;
        assert!(hub.register_machine(new, "m1"));
        assert!(hub.machine_online("m1"));
        assert_eq!(
            hub.machines_of_user(new_user_id),
            vec![("m1".into(), "Desk".into())]
        );
        assert_eq!(old_rx.try_recv().unwrap(), WsServerMsg::Displaced);
        assert!(matches!(
            old_rx.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        ));
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
                sink: mpsc::channel(1).0,
                label: None,
            };
            let conn_id = m.conn_id;
            hub.register_member(m, conn_id).unwrap();
        }
        let over = Member {
            conn_id: Uuid::now_v7(),
            user_id,
            org_id: Uuid::now_v7(),
            sink: mpsc::channel(1).0,
            label: None,
        };
        let over_conn_id = over.conn_id;
        assert!(hub.register_member(over, over_conn_id).is_err());
        hub.unregister_all_of_user_for_test(user_id);
        assert!(hub.register_member(member(), Uuid::now_v7()).is_ok());
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
        let second_conn_id = second.conn_id;
        let first_user_id = first.user_id;
        hub.register_member(first, first_conn_id).unwrap();
        hub.register_member(second, second_conn_id).unwrap();
        hub.unregister_member(first_user_id, first_conn_id);
        assert_eq!(hub.sinks_of_user(first_user_id).len(), 1);
        hub.unregister_member(first_user_id, first_conn_id);
        assert_eq!(hub.sinks_of_user(first_user_id).len(), 1);
    }

    #[test]
    fn unregister_machine_only_by_current_holder() {
        let hub = Hub::default();
        let member = member();
        let conn_id = member.conn_id;
        hub.register_machine(member, "m2");
        hub.unregister_machine("m2", Uuid::now_v7());
        assert!(hub.machine_online("m2"));
        hub.unregister_machine("m2", conn_id);
        assert!(!hub.machine_online("m2"));
    }
}
