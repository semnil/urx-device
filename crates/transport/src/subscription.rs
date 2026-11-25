//! Subscription ownership (K8, K10, K11): which tokens hold which
//! notification addresses on one connection, and which registrations and
//! unregistrations their lifecycle needs. This module performs no I/O; the
//! worker sends the requests it names and reports their verdicts back.
//!
//! A token admitted but not yet activating already receives notifications
//! and counts against the limits, but it takes no part in registration: an
//! address is registered for the first token that starts activating with it
//! and unregistered after the last such token is gone, so tokens that share
//! an address cause one registration between them, and releasing a token
//! that never started sends nothing. A token's address set never changes:
//! a consumer replaces a token by acquiring a new one and then releasing the
//! old one.

use crate::wire::{MeterAddress, ParameterAddress};
use std::collections::{HashMap, HashSet};

/// Tokens retained per connection, counting admitted, active and releasing
/// tokens (K11).
pub const MAX_TOKENS: usize = 32;
/// Address entries one acquisition may supply, before deduplication (K11).
pub const MAX_ADDRESSES_PER_ACQUISITION: usize = 8_192;
/// Address memberships retained across all tokens, after per-token
/// deduplication (K11).
pub const MAX_MEMBERSHIPS: usize = 32_768;

/// One notification address: a notification family and its complete address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SubscriptionAddress {
    Parameter(ParameterAddress),
    Meter(MeterAddress),
}

/// A token's identity within its connection. Identities are never reused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TokenId(u64);

/// Why an acquisition was not admitted. Existing tokens are unaffected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// More than [`MAX_ADDRESSES_PER_ACQUISITION`] entries were supplied.
    TooManyAddresses,
    /// [`MAX_TOKENS`] tokens are already retained.
    TooManyTokens,
    /// The token would take the memberships past [`MAX_MEMBERSHIPS`].
    TooManyMemberships,
}

/// Why [`Ledger::start`] refused to start an activation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartRefusal {
    /// A release or cleanup is still in progress.
    Busy,
    /// An unregistration was rejected, left unconfirmed or never completed:
    /// the connection's registrations are no longer known, and K10 ends it.
    Unusable,
    /// The token is no longer retained, or is being released: it cannot
    /// become active.
    Gone,
}

/// What a registration or unregistration reply established.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Accepted,
    /// A definite refusal: nothing changed at Device Center.
    Rejected,
    /// Sent, without a definite answer: it may have taken effect.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokenState {
    /// Admitted and receiving; it has not started registering.
    Provisional,
    /// Activation started: it holds its addresses' registrations.
    Registering,
    Active,
    /// Owning nothing any more; still counted until its release finishes.
    Releasing,
}

#[derive(Debug)]
struct Token {
    addresses: Vec<SubscriptionAddress>,
    state: TokenState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Registration {
    NotRegistered,
    Registered,
    /// A registration or unregistration was sent without a definite answer.
    Unknown,
}

#[derive(Debug)]
struct Entry {
    /// Tokens that receive the address's notifications, in admission order.
    owners: Vec<TokenId>,
    /// How many of them started activating: they keep the registration.
    holders: usize,
    registration: Registration,
}

/// The ownership state of one connection.
#[derive(Debug, Default)]
pub struct Ledger {
    tokens: HashMap<TokenId, Token>,
    entries: HashMap<SubscriptionAddress, Entry>,
    memberships: usize,
    next: u64,
    /// Unregistrations named by a release and not yet answered.
    unanswered: HashSet<SubscriptionAddress>,
    /// Set once an unregistration fails or a release finishes unanswered.
    unusable: bool,
}

impl Ledger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Admits a provisional token for `input`, deduplicated, after checking
    /// every limit and before any registration traffic. The token owns its
    /// addresses at once, so notifications for them reach it before its
    /// registrations are accepted.
    pub fn admit(&mut self, input: &[SubscriptionAddress]) -> Result<TokenId, Refusal> {
        if input.len() > MAX_ADDRESSES_PER_ACQUISITION {
            return Err(Refusal::TooManyAddresses);
        }
        if self.tokens.len() >= MAX_TOKENS {
            return Err(Refusal::TooManyTokens);
        }
        let mut seen = HashSet::with_capacity(input.len());
        let addresses: Vec<SubscriptionAddress> = input
            .iter()
            .copied()
            .filter(|address| seen.insert(*address))
            .collect();
        if self.memberships + addresses.len() > MAX_MEMBERSHIPS {
            return Err(Refusal::TooManyMemberships);
        }
        self.next += 1;
        let id = TokenId(self.next);
        for address in &addresses {
            self.entries
                .entry(*address)
                .or_insert(Entry {
                    owners: Vec::new(),
                    holders: 0,
                    registration: Registration::NotRegistered,
                })
                .owners
                .push(id);
        }
        self.memberships += addresses.len();
        self.tokens.insert(
            id,
            Token {
                addresses,
                state: TokenState::Provisional,
            },
        );
        Ok(id)
    }

    /// Starts `token`'s activation and returns the addresses it needs
    /// registered: those of its addresses no registration covers yet, in the
    /// token's order. Addresses registered or possibly registered for another
    /// activating or active token are not sent again. An active token needs
    /// nothing; a token no longer retained, releasing or already activating
    /// refuses with `Gone`.
    ///
    /// A release or cleanup that has not finished refuses with `Busy`: its
    /// unregistrations decide what is still registered, so an activation can
    /// start only after their verdicts are recorded and [`Ledger::finish`] ran.
    /// Once an unregistration has failed, every start refuses with `Unusable`.
    pub fn start(&mut self, token: TokenId) -> Result<Vec<SubscriptionAddress>, StartRefusal> {
        if self.unusable {
            return Err(StartRefusal::Unusable);
        }
        if self
            .tokens
            .values()
            .any(|token| token.state == TokenState::Releasing)
        {
            return Err(StartRefusal::Busy);
        }
        let Some(token) = self.tokens.get_mut(&token) else {
            return Err(StartRefusal::Gone);
        };
        match token.state {
            TokenState::Provisional => {}
            TokenState::Active => return Ok(Vec::new()),
            TokenState::Registering | TokenState::Releasing => return Err(StartRefusal::Gone),
        }
        token.state = TokenState::Registering;
        let mut needed = Vec::new();
        for address in &token.addresses {
            let entry = self
                .entries
                .get_mut(address)
                .expect("an owned address has an entry");
            entry.holders += 1;
            if entry.registration == Registration::NotRegistered {
                needed.push(*address);
            }
        }
        Ok(needed)
    }

    /// Records the verdict of a registration sent for `address`.
    pub fn registered(&mut self, address: SubscriptionAddress, verdict: Verdict) {
        if let Some(entry) = self.entries.get_mut(&address) {
            entry.registration = match verdict {
                Verdict::Accepted => Registration::Registered,
                Verdict::Rejected => Registration::NotRegistered,
                Verdict::Unknown => Registration::Unknown,
            };
        }
    }

    /// Marks an activating `token` active once all its registrations were
    /// accepted.
    pub fn activate(&mut self, token: TokenId) {
        if let Some(token) = self.tokens.get_mut(&token) {
            if token.state == TokenState::Registering {
                token.state = TokenState::Active;
            }
        }
    }

    /// Ends `token`'s ownership and returns the addresses to unregister: those
    /// it was the last activating or active holder of that are registered or
    /// possibly registered. A token that never started returns nothing.
    /// The token stays counted against the limits until [`Ledger::finish`].
    /// Used both for a release and for the cleanup of a failed or cancelled
    /// acquisition. A token already releasing, or unknown, returns nothing.
    pub fn begin_release(&mut self, token: TokenId) -> Vec<SubscriptionAddress> {
        let id = token;
        let Some(token) = self.tokens.get_mut(&id) else {
            return Vec::new();
        };
        if token.state == TokenState::Releasing {
            return Vec::new();
        }
        let held = token.state != TokenState::Provisional;
        token.state = TokenState::Releasing;
        let mut unregister = Vec::new();
        for address in &token.addresses {
            let entry = self
                .entries
                .get_mut(address)
                .expect("an owned address has an entry");
            entry.owners.retain(|owner| *owner != id);
            if held {
                entry.holders -= 1;
                if entry.holders == 0 && entry.registration != Registration::NotRegistered {
                    unregister.push(*address);
                    self.unanswered.insert(*address);
                    continue;
                }
            }
            if entry.owners.is_empty() && entry.registration == Registration::NotRegistered {
                self.entries.remove(address);
            }
        }
        unregister
    }

    /// Records the verdict of an unregistration sent for `address`. An
    /// accepted one forgets the address unless a new owner has taken it
    /// meanwhile, which then needs it registered again; any other verdict
    /// makes the ledger unusable for further activations.
    pub fn unregistered(&mut self, address: SubscriptionAddress, verdict: Verdict) {
        self.unanswered.remove(&address);
        if verdict != Verdict::Accepted {
            self.unusable = true;
        }
        let Some(entry) = self.entries.get_mut(&address) else {
            return;
        };
        match verdict {
            Verdict::Accepted => {
                entry.registration = Registration::NotRegistered;
                if entry.owners.is_empty() && entry.holders == 0 {
                    self.entries.remove(&address);
                }
            }
            Verdict::Rejected => {}
            Verdict::Unknown => entry.registration = Registration::Unknown,
        }
    }

    /// Forgets a token whose release has finished, freeing its capacity. An
    /// unregistration it named that was never answered makes the ledger
    /// unusable for further activations.
    pub fn finish(&mut self, token: TokenId) {
        if let Some(token) = self.tokens.remove(&token) {
            self.memberships -= token.addresses.len();
            for address in &token.addresses {
                if self.unanswered.remove(address) {
                    self.unusable = true;
                }
            }
        }
    }

    /// The tokens holding `address` that are not releasing, in admission
    /// order: the recipients of a notification for it.
    pub fn recipients(&self, address: SubscriptionAddress) -> &[TokenId] {
        self.entries
            .get(&address)
            .map_or(&[], |entry| entry.owners.as_slice())
    }

    /// The tokens that are not releasing and hold any parameter address, in
    /// admission order: the recipients of a whole-namespace parameter change.
    pub fn parameter_holders(&self) -> Vec<TokenId> {
        let mut holders: Vec<TokenId> = self
            .tokens
            .iter()
            .filter(|(_, token)| {
                token.state != TokenState::Releasing
                    && token
                        .addresses
                        .iter()
                        .any(|address| matches!(address, SubscriptionAddress::Parameter(_)))
            })
            .map(|(id, _)| *id)
            .collect();
        holders.sort();
        holders
    }

    /// Retained tokens, releasing ones included.
    pub fn token_count(&self) -> usize {
        self.tokens.len()
    }

    /// Retained memberships, releasing tokens' included.
    pub fn membership_count(&self) -> usize {
        self.memberships
    }

    /// Whether `token` is retained and active.
    pub fn is_active(&self, token: TokenId) -> bool {
        self.tokens
            .get(&token)
            .is_some_and(|token| token.state == TokenState::Active)
    }
}

#[cfg(test)]
mod tests;
