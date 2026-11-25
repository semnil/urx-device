//! Notification delivery bookkeeping (K6, K12): the bounded queue of
//! notification records waiting for the application, and the one batch in
//! delivery until the application acknowledges it. This module performs no
//! I/O and runs no callbacks.

use crate::subscription::TokenId;
use crate::wire::Notification;
use std::collections::VecDeque;

/// Undelivered records, the batch in delivery included (K6).
pub const MAX_PENDING_NOTIFICATIONS: usize = 512;
/// Charged bytes of those records (K6).
pub const MAX_PENDING_NOTIFICATION_BYTES: usize = 4 << 20;
/// Records in one batch (K6).
pub const MAX_BATCH_RECORDS: usize = 64;
/// Charged bytes in one batch (K6).
pub const MAX_BATCH_BYTES: usize = 1 << 20;

/// One received notification for the tokens eligible at receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationRecord {
    /// Eligible tokens in admission order, never empty.
    pub recipients: Vec<TokenId>,
    /// PC receipt time, milliseconds since the Unix epoch.
    pub received_at_ms: i64,
    pub payload: Notification,
}

/// Identifies one delivered batch; only its own acknowledgment releases it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct BatchTicket(u64);

/// Records handed to the application together, in receive order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationBatch {
    /// The connection generation the records were received on.
    pub generation: u64,
    pub ticket: BatchTicket,
    pub records: Vec<NotificationRecord>,
}

/// A record that does not fit the delivery budget: the connection must end
/// with `notification_overflow` (K6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Overflow;

#[derive(Debug)]
struct InDelivery {
    ticket: BatchTicket,
    records: usize,
    bytes: usize,
}

/// The pending records of one connection and its batch in delivery.
#[derive(Debug, Default)]
pub struct Queue {
    pending: VecDeque<(NotificationRecord, usize)>,
    pending_bytes: usize,
    in_delivery: Option<InDelivery>,
    next_ticket: u64,
}

impl Queue {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queues `record`, charged `bytes` (its originating frame's length),
    /// unless it would take the records or bytes past their limits.
    pub fn push(&mut self, record: NotificationRecord, bytes: usize) -> Result<(), Overflow> {
        let (records, charged) = self.retained();
        if records + 1 > MAX_PENDING_NOTIFICATIONS
            || charged + bytes > MAX_PENDING_NOTIFICATION_BYTES
        {
            return Err(Overflow);
        }
        self.pending.push_back((record, bytes));
        self.pending_bytes += bytes;
        Ok(())
    }

    /// Records and charged bytes retained, the batch in delivery included.
    pub fn retained(&self) -> (usize, usize) {
        let (records, bytes) = self
            .in_delivery
            .as_ref()
            .map_or((0, 0), |batch| (batch.records, batch.bytes));
        (records + self.pending.len(), bytes + self.pending_bytes)
    }

    /// The next batch, when none is in delivery and records are pending: the
    /// oldest records up to [`MAX_BATCH_RECORDS`] and [`MAX_BATCH_BYTES`]
    /// (at least one record). They stay charged until [`Queue::adopt`].
    pub fn next_batch(&mut self, generation: u64) -> Option<NotificationBatch> {
        if self.in_delivery.is_some() || self.pending.is_empty() {
            return None;
        }
        let mut records = Vec::new();
        let mut bytes = 0;
        while let Some((_, size)) = self.pending.front() {
            let full = records.len() == MAX_BATCH_RECORDS
                || (!records.is_empty() && bytes + size > MAX_BATCH_BYTES);
            if full {
                break;
            }
            let (record, size) = self.pending.pop_front().expect("checked above");
            self.pending_bytes -= size;
            bytes += size;
            records.push(record);
        }
        self.next_ticket += 1;
        let ticket = BatchTicket(self.next_ticket);
        self.in_delivery = Some(InDelivery {
            ticket,
            records: records.len(),
            bytes,
        });
        Some(NotificationBatch {
            generation,
            ticket,
            records,
        })
    }

    /// Acknowledges the batch in delivery. A ticket that is not the one in
    /// delivery (stale or repeated) changes nothing and returns false.
    pub fn adopt(&mut self, ticket: BatchTicket) -> bool {
        match &self.in_delivery {
            Some(batch) if batch.ticket == ticket => {
                self.in_delivery = None;
                true
            }
            _ => false,
        }
    }

    pub fn is_idle(&self) -> bool {
        self.in_delivery.is_none() && self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests;
