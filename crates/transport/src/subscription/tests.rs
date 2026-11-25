use super::{
    Ledger, Refusal, StartRefusal, SubscriptionAddress, Verdict, MAX_ADDRESSES_PER_ACQUISITION,
    MAX_MEMBERSHIPS, MAX_TOKENS,
};
use crate::wire::{MeterAddress, ParameterAddress};

trait StartOk {
    /// `start` when no release is in progress.
    fn start_ok(&mut self, token: super::TokenId) -> Vec<SubscriptionAddress>;
}

impl StartOk for Ledger {
    fn start_ok(&mut self, token: super::TokenId) -> Vec<SubscriptionAddress> {
        self.start(token).expect("no release in progress")
    }
}

fn p(param_id: u32) -> SubscriptionAddress {
    SubscriptionAddress::Parameter(ParameterAddress {
        param_id,
        x: 0,
        y: 0,
    })
}

fn m(meter_id: u32) -> SubscriptionAddress {
    SubscriptionAddress::Meter(MeterAddress { meter_id, x: 0 })
}

/// Admits `addresses` and accepts every registration the token needs.
fn active(ledger: &mut Ledger, addresses: &[SubscriptionAddress]) -> super::TokenId {
    let token = ledger.admit(addresses).unwrap();
    for address in ledger.start_ok(token) {
        ledger.registered(address, Verdict::Accepted);
    }
    ledger.activate(token);
    token
}

/// Releases `token` with every unregistration accepted; returns those sent.
fn release(ledger: &mut Ledger, token: super::TokenId) -> Vec<SubscriptionAddress> {
    let sent = ledger.begin_release(token);
    for address in &sent {
        ledger.unregistered(*address, Verdict::Accepted);
    }
    ledger.finish(token);
    sent
}

#[test]
fn a_shared_address_is_registered_once_and_unregistered_after_its_last_owner() {
    let mut ledger = Ledger::new();
    let a = ledger.admit(&[p(1), p(2)]).unwrap();
    assert_eq!(ledger.start_ok(a), [p(1), p(2)]);
    ledger.registered(p(1), Verdict::Accepted);
    ledger.registered(p(2), Verdict::Accepted);
    ledger.activate(a);
    assert!(ledger.is_active(a));

    let b = ledger.admit(&[p(2), p(3)]).unwrap();
    assert_eq!(ledger.start_ok(b), [p(3)], "p2 is already registered for a");
    ledger.registered(p(3), Verdict::Accepted);
    ledger.activate(b);

    assert_eq!(release(&mut ledger, a), [p(1)], "b still owns p2");
    assert_eq!(release(&mut ledger, b), [p(2), p(3)]);
    assert_eq!(ledger.token_count(), 0);
    assert_eq!(ledger.membership_count(), 0);
}

#[test]
fn either_owner_may_release_first() {
    let mut ledger = Ledger::new();
    let a = active(&mut ledger, &[p(1)]);
    let b = active(&mut ledger, &[p(1)]);
    assert_eq!(release(&mut ledger, b), []);
    assert_eq!(release(&mut ledger, a), [p(1)]);
}

#[test]
fn a_failed_replacement_keeps_the_old_set_and_releases_only_its_own_additions() {
    // Old {p, q}; new {q, r, s}; registering s is rejected.
    let (pp, q, r, s) = (p(1), p(2), p(3), p(4));
    let mut ledger = Ledger::new();
    let old = active(&mut ledger, &[pp, q]);
    let new = ledger.admit(&[q, r, s]).unwrap();
    assert_eq!(ledger.start_ok(new), [r, s], "q is never registered again");
    ledger.registered(r, Verdict::Accepted);
    ledger.registered(s, Verdict::Rejected);
    assert_eq!(
        ledger.begin_release(new),
        [r],
        "q stays with old; s never registered"
    );
    ledger.unregistered(r, Verdict::Accepted);
    ledger.finish(new);
    assert!(ledger.is_active(old));
    assert_eq!(ledger.recipients(pp), [old]);
    assert_eq!(ledger.recipients(q), [old]);
    assert_eq!(ledger.recipients(r), []);
}

#[test]
fn a_registration_with_an_unknown_result_is_cleaned_up_as_possibly_registered() {
    let mut ledger = Ledger::new();
    let token = ledger.admit(&[p(1), p(2)]).unwrap();
    assert_eq!(ledger.start_ok(token), [p(1), p(2)]);
    ledger.registered(p(1), Verdict::Unknown);
    assert_eq!(ledger.begin_release(token), [p(1)], "p2 was never sent");
    // An unconfirmed cleanup leaves the registrations unknown: nothing
    // starts on this connection afterwards.
    let other = ledger.admit(&[p(1)]).unwrap();
    ledger.unregistered(p(1), Verdict::Unknown);
    ledger.finish(token);
    assert_eq!(ledger.start(other), Err(StartRefusal::Unusable));
}

#[test]
fn an_address_taken_by_a_new_owner_during_its_unregistration_is_registered_again() {
    let mut ledger = Ledger::new();
    let old = active(&mut ledger, &[p(1)]);
    let sent = ledger.begin_release(old);
    assert_eq!(sent, [p(1)]);
    let new = ledger.admit(&[p(1)]).unwrap();
    assert_eq!(
        ledger.start(new),
        Err(StartRefusal::Busy),
        "not before the release finishes"
    );
    ledger.unregistered(p(1), Verdict::Accepted);
    ledger.finish(old);
    assert_eq!(ledger.start_ok(new), [p(1)]);
    assert_eq!(ledger.recipients(p(1)), [new]);
}

#[test]
fn an_unchanged_replacement_needs_no_traffic() {
    let mut ledger = Ledger::new();
    let old = active(&mut ledger, &[p(1), m(1)]);
    let new = ledger.admit(&[m(1), p(1)]).unwrap();
    assert_eq!(ledger.start_ok(new), []);
    ledger.activate(new);
    assert_eq!(release(&mut ledger, old), []);
}

#[test]
fn a_parameter_and_a_meter_with_the_same_numbers_are_different_addresses() {
    let mut ledger = Ledger::new();
    let token = ledger.admit(&[p(5), m(5)]).unwrap();
    assert_eq!(ledger.start_ok(token), [p(5), m(5)]);
}

#[test]
fn duplicates_are_owned_once_but_count_against_the_input_limit() {
    let mut ledger = Ledger::new();
    let token = ledger.admit(&[p(1), p(1), p(2), p(1)]).unwrap();
    assert_eq!(ledger.start_ok(token), [p(1), p(2)]);
    assert_eq!(ledger.membership_count(), 2);
    assert_eq!(
        ledger.admit(&vec![p(1); MAX_ADDRESSES_PER_ACQUISITION + 1]),
        Err(Refusal::TooManyAddresses)
    );
    assert!(ledger
        .admit(&vec![p(1); MAX_ADDRESSES_PER_ACQUISITION])
        .is_ok());
}

#[test]
fn recipients_are_the_admitted_and_active_owners_in_admission_order() {
    let mut ledger = Ledger::new();
    let a = active(&mut ledger, &[p(1)]);
    let b = ledger.admit(&[p(1)]).unwrap();
    assert_eq!(
        ledger.recipients(p(1)),
        [a, b],
        "a provisional token already receives"
    );
    ledger.begin_release(a);
    assert_eq!(ledger.recipients(p(1)), [b], "a releasing token does not");
    assert_eq!(ledger.recipients(p(9)), []);
}

fn full(start: u32) -> Vec<SubscriptionAddress> {
    (start..start + MAX_ADDRESSES_PER_ACQUISITION as u32)
        .map(p)
        .collect()
}

#[test]
fn memberships_admit_exactly_their_limit_and_count_until_released() {
    let mut ledger = Ledger::new();
    let tokens: Vec<_> = (0..4)
        .map(|i| ledger.admit(&full(i * 10_000)).unwrap())
        .collect();
    assert_eq!(ledger.membership_count(), MAX_MEMBERSHIPS);
    assert_eq!(
        ledger.admit(&[p(999_999)]),
        Err(Refusal::TooManyMemberships)
    );
    // Overlap does not reduce the count: the same addresses again still need
    // memberships of their own.
    assert_eq!(
        ledger.admit(&full(0)[..1]),
        Err(Refusal::TooManyMemberships)
    );

    // A release in progress still counts; release works at full capacity.
    let _ = ledger.begin_release(tokens[0]);
    assert_eq!(
        ledger.admit(&[p(999_999)]),
        Err(Refusal::TooManyMemberships)
    );
    ledger.finish(tokens[0]);
    assert!(ledger.admit(&[p(999_999)]).is_ok());
}

#[test]
fn tokens_admit_exactly_their_limit() {
    let mut ledger = Ledger::new();
    let tokens: Vec<_> = (0..MAX_TOKENS as u32)
        .map(|i| ledger.admit(&[p(i)]).unwrap())
        .collect();
    assert_eq!(ledger.admit(&[p(1)]), Err(Refusal::TooManyTokens));
    assert_eq!(ledger.admit(&[]), Err(Refusal::TooManyTokens));
    let _ = ledger.begin_release(tokens[0]);
    assert_eq!(
        ledger.admit(&[p(1)]),
        Err(Refusal::TooManyTokens),
        "releasing still counts"
    );
    ledger.finish(tokens[0]);
    assert!(ledger.admit(&[p(1)]).is_ok());
}

#[test]
fn a_refused_acquisition_leaves_existing_ownership_unchanged() {
    let mut ledger = Ledger::new();
    let a = active(&mut ledger, &[p(1)]);
    assert!(ledger
        .admit(&vec![p(2); MAX_ADDRESSES_PER_ACQUISITION + 1])
        .is_err());
    assert_eq!(ledger.recipients(p(1)), [a]);
    assert_eq!(ledger.recipients(p(2)), []);
    assert_eq!(ledger.membership_count(), 1);
}

#[test]
fn repeated_or_unknown_releases_send_nothing_and_identities_are_not_reused() {
    let mut ledger = Ledger::new();
    let a = active(&mut ledger, &[p(1)]);
    assert_eq!(ledger.begin_release(a), [p(1)]);
    assert_eq!(
        ledger.begin_release(a),
        [],
        "a second release sends nothing"
    );
    ledger.unregistered(p(1), Verdict::Accepted);
    ledger.finish(a);
    ledger.finish(a);
    assert_eq!(ledger.begin_release(a), []);
    let b = ledger.admit(&[p(1)]).unwrap();
    assert_ne!(a, b);
    assert_eq!(
        ledger.begin_release(a),
        [],
        "an old identity cannot release new ownership"
    );
    assert_eq!(ledger.recipients(p(1)), [b]);
}

#[test]
fn a_token_that_never_started_neither_keeps_nor_inherits_a_registration() {
    for meter in [false, true] {
        let address = if meter { m(1) } else { p(1) };
        let mut ledger = Ledger::new();
        let first = active(&mut ledger, &[address]);
        let waiting = ledger.admit(&[address]).unwrap();
        // The last activating holder leaves: it unregisters, though a
        // provisional token still receives the address.
        assert_eq!(release(&mut ledger, first), [address]);
        assert_eq!(ledger.recipients(address), [waiting]);
        // Releasing the token that never started sends nothing.
        assert_eq!(ledger.begin_release(waiting), []);
        ledger.finish(waiting);
        assert_eq!(ledger.token_count(), 0);

        // Started later instead, it registers the address itself.
        let first = active(&mut ledger, &[address]);
        let waiting = ledger.admit(&[address]).unwrap();
        assert_eq!(release(&mut ledger, first), [address]);
        assert_eq!(ledger.start_ok(waiting), [address]);
    }
}

#[test]
fn a_failed_acquisition_cleans_up_what_it_registered_even_with_a_provisional_owner() {
    for verdict in [Verdict::Accepted, Verdict::Unknown] {
        let mut ledger = Ledger::new();
        let failing = ledger.admit(&[p(1), p(2)]).unwrap();
        let waiting = ledger.admit(&[p(1)]).unwrap();
        assert_eq!(ledger.start_ok(failing), [p(1), p(2)]);
        ledger.registered(p(1), verdict);
        ledger.registered(p(2), Verdict::Rejected);
        assert_eq!(ledger.begin_release(failing), [p(1)], "{verdict:?}");
        ledger.unregistered(p(1), Verdict::Accepted);
        ledger.finish(failing);
        assert_eq!(ledger.start_ok(waiting), [p(1)], "it registers on its own");
        ledger.registered(p(1), Verdict::Accepted);
        ledger.activate(waiting);
        assert!(ledger.is_active(waiting));
    }
}

#[test]
fn only_an_activating_token_becomes_active() {
    let mut ledger = Ledger::new();
    let token = ledger.admit(&[p(1)]).unwrap();
    ledger.activate(token);
    assert!(!ledger.is_active(token), "not started");
    ledger.start_ok(token);
    assert_eq!(
        ledger.start(token),
        Err(StartRefusal::Gone),
        "already activating"
    );
    ledger.registered(p(1), Verdict::Accepted);
    ledger.activate(token);
    assert!(ledger.is_active(token));
}

#[test]
fn no_activation_starts_while_a_release_or_cleanup_is_unfinished() {
    let mut ledger = Ledger::new();
    let old = active(&mut ledger, &[p(1), p(2)]);
    assert_eq!(ledger.begin_release(old), [p(1), p(2)]);
    let next = ledger.admit(&[p(1), p(2)]).unwrap();
    assert_eq!(ledger.recipients(p(1)), [next], "it receives while waiting");
    assert_eq!(ledger.start(next), Err(StartRefusal::Busy));
    ledger.unregistered(p(1), Verdict::Accepted);
    assert_eq!(
        ledger.start(next),
        Err(StartRefusal::Busy),
        "one verdict of two"
    );
    ledger.unregistered(p(2), Verdict::Accepted);
    assert_eq!(
        ledger.start(next),
        Err(StartRefusal::Busy),
        "not finished yet"
    );
    ledger.finish(old);
    assert_eq!(ledger.start_ok(next), [p(1), p(2)]);
}

#[test]
fn a_failed_or_unanswered_unregistration_refuses_every_later_activation() {
    for (meter, outcome) in [
        (false, Some(Verdict::Rejected)),
        (true, Some(Verdict::Unknown)),
        (false, None),
    ] {
        let address = if meter { m(1) } else { p(1) };
        let mut ledger = Ledger::new();
        let old = active(&mut ledger, &[address, p(2)]);
        let sent = ledger.begin_release(old);
        assert_eq!(sent, [address, p(2)]);
        let overlapping = ledger.admit(&[address]).unwrap();
        let separate = ledger.admit(&[p(3)]).unwrap();
        ledger.unregistered(p(2), Verdict::Accepted);
        if let Some(verdict) = outcome {
            ledger.unregistered(address, verdict);
        }
        ledger.finish(old);
        assert_eq!(ledger.token_count(), 2, "capacity is still freed");
        for token in [overlapping, separate] {
            assert_eq!(
                ledger.start(token),
                Err(StartRefusal::Unusable),
                "{outcome:?}"
            );
            ledger.activate(token);
            assert!(!ledger.is_active(token));
        }
    }
}

#[test]
fn only_a_retained_token_starts_and_an_active_one_needs_nothing() {
    let mut ledger = Ledger::new();
    let token = active(&mut ledger, &[p(1)]);
    assert_eq!(ledger.start(token), Ok(vec![]), "already active");
    assert_eq!(release(&mut ledger, token), [p(1)]);
    assert_eq!(ledger.start(token), Err(StartRefusal::Gone), "released");
    let releasing = active(&mut ledger, &[p(2)]);
    let _ = ledger.begin_release(releasing);
    assert_eq!(
        ledger.start(releasing),
        Err(StartRefusal::Busy),
        "a release is unfinished"
    );
}

#[test]
fn finishing_a_release_does_not_take_another_tokens_unanswered_unregistration() {
    for address in [p(1), m(1)] {
        let mut ledger = Ledger::new();
        let live = active(&mut ledger, &[address]);
        let unregister = ledger.begin_release(live);
        assert_eq!(unregister, [address]);
        let provisional = ledger.admit(&[address]).unwrap();
        assert!(ledger.begin_release(provisional).is_empty());
        ledger.finish(provisional);
        ledger.unregistered(address, Verdict::Accepted);
        ledger.finish(live);
        let next = ledger.admit(&[address]).unwrap();
        assert_eq!(ledger.start(next), Ok(vec![address]), "{address:?}");
    }
}
