//! Poison-tolerant locking. Every value the engine guards with a std
//! `Mutex` (the engine state, pending-call maps, caches) stays valid when a
//! holder panics, so one panicking handler must not make every later lock
//! panic too and wedge the engine.

use std::sync::{Mutex, MutexGuard};

pub trait LockExt<T> {
    /// Locks, recovering the guard from a poisoned mutex.
    fn guard(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn guard(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::LockExt;
    use std::sync::{Arc, Mutex};

    #[test]
    fn a_poisoned_mutex_still_locks() {
        let m = Arc::new(Mutex::new(1));
        let poisoner = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = poisoner.lock().unwrap();
            panic!("poison");
        })
        .join();
        assert!(m.lock().is_err());
        *m.guard() += 1;
        assert_eq!(*m.guard(), 2);
    }
}
