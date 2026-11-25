use super::{
    NotificationRecord, Overflow, Queue, MAX_BATCH_BYTES, MAX_BATCH_RECORDS,
    MAX_PENDING_NOTIFICATIONS, MAX_PENDING_NOTIFICATION_BYTES,
};
use crate::subscription::{Ledger, SubscriptionAddress};
use crate::wire::{MeterAddress, Notification};

fn record(value: i64) -> NotificationRecord {
    let mut ledger = Ledger::new();
    let token = ledger
        .admit(&[SubscriptionAddress::Meter(MeterAddress {
            meter_id: 1,
            x: 0,
        })])
        .unwrap();
    NotificationRecord {
        recipients: vec![token],
        received_at_ms: 0,
        payload: Notification::Meter {
            address: MeterAddress { meter_id: 1, x: 0 },
            value,
        },
    }
}

fn values(batch: &super::NotificationBatch) -> Vec<i64> {
    batch
        .records
        .iter()
        .map(|record| match record.payload {
            Notification::Meter { value, .. } => value,
            _ => unreachable!(),
        })
        .collect()
}

#[test]
fn batches_keep_receive_order_and_one_is_in_delivery_until_acknowledged() {
    let mut queue = Queue::new(7);
    for value in 0..3 {
        queue.push(record(value), 10).unwrap();
    }
    let first = queue.next_batch().unwrap();
    assert_eq!(first.generation, 7);
    assert_eq!(values(&first), [0, 1, 2]);
    queue.push(record(3), 10).unwrap();
    assert_eq!(queue.next_batch(), None, "one batch at a time");
    assert_eq!(
        queue.retained(),
        (4, 40),
        "the batch in delivery stays charged"
    );
    assert!(queue.adopt(first.ticket));
    assert!(
        !queue.adopt(first.ticket),
        "a repeated acknowledgment changes nothing"
    );
    let second = queue.next_batch().unwrap();
    assert_eq!(values(&second), [3]);
    assert!(
        !queue.adopt(first.ticket),
        "a stale ticket cannot release a newer batch"
    );
    assert!(queue.adopt(second.ticket));
    assert!(queue.is_idle());
}

#[test]
fn equal_values_stay_distinct_records() {
    let mut queue = Queue::new(7);
    queue.push(record(5), 1).unwrap();
    queue.push(record(5), 1).unwrap();
    assert_eq!(values(&queue.next_batch().unwrap()), [5, 5]);
}

#[test]
fn a_batch_holds_at_most_its_record_and_byte_limits() {
    let mut queue = Queue::new(7);
    for value in 0..(MAX_BATCH_RECORDS as i64 + 1) {
        queue.push(record(value), 1).unwrap();
    }
    let batch = queue.next_batch().unwrap();
    assert_eq!(batch.records.len(), MAX_BATCH_RECORDS);
    queue.adopt(batch.ticket);
    assert_eq!(queue.next_batch().unwrap().records.len(), 1);

    let mut queue = Queue::new(7);
    queue.push(record(0), MAX_BATCH_BYTES - 1).unwrap();
    queue.push(record(1), 1).unwrap();
    queue.push(record(2), 1).unwrap();
    let batch = queue.next_batch().unwrap();
    assert_eq!(values(&batch), [0, 1], "exactly the byte limit");
    queue.adopt(batch.ticket);
    assert_eq!(values(&queue.next_batch().unwrap()), [2]);
}

#[test]
fn a_record_larger_than_a_batch_is_delivered_alone() {
    let mut queue = Queue::new(7);
    queue.push(record(0), MAX_BATCH_BYTES + 1).unwrap();
    queue.push(record(1), 1).unwrap();
    let batch = queue.next_batch().unwrap();
    assert_eq!(values(&batch), [0]);
}

#[test]
fn the_pending_limits_are_inclusive_and_count_the_batch_in_delivery() {
    let mut queue = Queue::new(7);
    for value in 0..MAX_PENDING_NOTIFICATIONS as i64 {
        queue.push(record(value), 1).unwrap();
    }
    assert_eq!(queue.push(record(-1), 1), Err(Overflow));
    let batch = queue.next_batch().unwrap();
    assert_eq!(
        queue.push(record(-1), 1),
        Err(Overflow),
        "in delivery still counts"
    );
    queue.adopt(batch.ticket);
    assert!(queue.push(record(-1), 1).is_ok());

    let mut queue = Queue::new(7);
    queue
        .push(record(0), MAX_PENDING_NOTIFICATION_BYTES - 1)
        .unwrap();
    assert!(queue.push(record(1), 1).is_ok(), "exactly the byte limit");
    assert_eq!(queue.push(record(2), 1), Err(Overflow));
}

#[test]
fn a_ticket_of_another_connection_is_not_accepted() {
    let mut old = Queue::new(1);
    let mut new = Queue::new(2);
    old.push(record(0), 1).unwrap();
    new.push(record(0), 1).unwrap();
    let old_batch = old.next_batch().unwrap();
    let new_batch = new.next_batch().unwrap();
    assert!(
        !new.adopt(old_batch.ticket),
        "same sequence, other generation"
    );
    assert!(new.adopt(new_batch.ticket));
}

#[test]
fn a_cutoff_counts_the_records_queued_before_it_including_the_batch_in_delivery() {
    let mut queue = Queue::new(7);
    queue.push(record(0), 1).unwrap();
    queue.push(record(1), 1).unwrap();
    let first = queue.next_batch().unwrap();
    queue.push(record(2), 1).unwrap();
    let cutoff = queue.accepted();
    assert_eq!(cutoff, 3);
    queue.push(record(3), 1).unwrap();
    assert_eq!(queue.accepted(), 4, "later arrivals do not move the cutoff");
    assert!(!queue.has_adopted(cutoff));
    assert!(queue.adopt(first.ticket));
    assert!(
        !queue.has_adopted(cutoff),
        "one record before the cutoff remains"
    );
    let second = queue.next_batch().unwrap();
    assert_eq!(
        second.records.len(),
        2,
        "the cutoff falls inside this batch"
    );
    assert!(queue.adopt(second.ticket));
    assert!(queue.has_adopted(cutoff));
    assert!(
        Queue::new(7).has_adopted(0),
        "nothing before an empty cutoff"
    );
}
