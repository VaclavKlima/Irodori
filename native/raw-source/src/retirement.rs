//! Observe completed row-thread retirement without confusing Linux task accounting with joins.

use std::fs;
use std::io;
use std::thread;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(1);
const POLL_INTERVAL: Duration = Duration::from_millis(1);

fn observed_threads() -> io::Result<u64> {
    let status = fs::read_to_string("/proc/self/status")?;
    status
        .lines()
        .find_map(|line| line.strip_prefix("Threads:"))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Missing native RAW thread count.",
            )
        })?
        .trim()
        .parse()
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid native RAW thread count.",
            )
        })
}

fn wait_with_observation(
    mut observe: impl FnMut() -> io::Result<u64>,
    mut elapsed: impl FnMut() -> Duration,
    mut pause: impl FnMut(Duration),
) -> io::Result<u64> {
    loop {
        let count = observe()?;
        if !(1..=8).contains(&count) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Native RAW thread count after its join barrier is outside 1..8: {count}."),
            ));
        }
        let observed_at = elapsed();
        if observed_at >= TIMEOUT {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "Native RAW thread retirement was not confirmed within 1000 ms after its join barrier: observed {count} threads."
                ),
            ));
        }
        if count == 1 {
            return Ok(count);
        }
        let remaining = TIMEOUT - observed_at;
        pause(POLL_INTERVAL.min(remaining));
    }
}

/// Scoped joins remain the ownership barrier. Linux can clear the pthread join futex before
/// removing the exiting task from /proc accounting, so observe its exact final count separately.
pub fn wait_for_single_thread() -> io::Result<u64> {
    let started = Instant::now();
    wait_with_observation(observed_threads, || started.elapsed(), thread::sleep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn observations(counts: &[u64]) -> (io::Result<u64>, usize, Duration) {
        let reads = Cell::new(0);
        let clock = Cell::new(Duration::ZERO);
        let result = wait_with_observation(
            || {
                let index = reads.get();
                reads.set(index + 1);
                Ok(counts[index.min(counts.len() - 1)])
            },
            || clock.get(),
            |duration| clock.set(clock.get() + duration),
        );
        (result, reads.get(), clock.get())
    }

    #[test]
    fn already_single_thread_requires_no_pause() {
        let (result, reads, elapsed) = observations(&[1]);
        assert_eq!(result.unwrap(), 1);
        assert_eq!(reads, 1);
        assert_eq!(elapsed, Duration::ZERO);
    }

    #[test]
    fn joined_thread_accounting_can_settle_from_two_to_one() {
        let (result, reads, elapsed) = observations(&[2, 1]);
        assert_eq!(result.unwrap(), 1);
        assert_eq!(reads, 2);
        assert_eq!(elapsed, POLL_INTERVAL);
    }

    #[test]
    fn the_existing_eight_thread_ceiling_remains_admitted_while_retiring() {
        let (result, reads, elapsed) = observations(&[8, 1]);
        assert_eq!(result.unwrap(), 1);
        assert_eq!(reads, 2);
        assert_eq!(elapsed, POLL_INTERVAL);
    }

    #[test]
    fn persistent_extra_threads_fail_at_the_fixed_deadline() {
        let (result, reads, elapsed) = observations(&[2]);
        let error = result.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(error.to_string().contains("within 1000 ms"));
        assert!(error.to_string().contains("observed 2 threads"));
        assert_eq!(reads, 1001);
        assert_eq!(elapsed, TIMEOUT);
    }

    #[test]
    fn a_single_thread_observed_after_pause_overshoot_still_times_out() {
        let reads = Cell::new(0);
        let clock = Cell::new(Duration::ZERO);
        let result = wait_with_observation(
            || {
                reads.set(reads.get() + 1);
                Ok(if reads.get() == 1 { 2 } else { 1 })
            },
            || clock.get(),
            |duration| {
                assert_eq!(duration, POLL_INTERVAL);
                clock.set(TIMEOUT + POLL_INTERVAL);
            },
        );
        let error = result.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(error.to_string().contains("observed 1 threads"));
        assert_eq!(reads.get(), 2);
        assert_eq!(clock.get(), TIMEOUT + POLL_INTERVAL);
    }

    #[test]
    fn zero_and_excess_thread_counts_fail_without_waiting() {
        for count in [0, 9] {
            let (result, reads, elapsed) = observations(&[count]);
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidData);
            assert_eq!(reads, 1);
            assert_eq!(elapsed, Duration::ZERO);
        }
    }

    #[test]
    fn observation_failure_is_not_retried_or_replaced_with_a_thread_count() {
        let reads = Cell::new(0);
        let clock = Cell::new(Duration::ZERO);
        let result = wait_with_observation(
            || {
                reads.set(reads.get() + 1);
                if reads.get() == 1 {
                    Ok(2)
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "read denied",
                    ))
                }
            },
            || clock.get(),
            |duration| clock.set(clock.get() + duration),
        );
        let error = result.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(error.to_string(), "read denied");
        assert_eq!(reads.get(), 2);
        assert_eq!(clock.get(), POLL_INTERVAL);
    }
}
