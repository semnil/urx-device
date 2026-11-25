//! Subscription ownership (K8, K10, K11): which tokens hold which
//! notification addresses on one connection, and which registrations and
//! unregistrations their lifecycle needs. This module performs no I/O; the
//! worker sends the requests it names and reports their verdicts back.
//!
//! An address is registered with Device Center for its first owner and
//! unregistered after its last owner is gone, so tokens that share an address
//! cause one registration between them. A token's address set never changes:
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
    /// Admitted, owning its addresses, not yet fully registered.
    Provisional,
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
    /// Provisional and active tokens holding the address, in admission order.
    owners: Vec<TokenId>,
    registration: Registration,
}

/// The ownership state of one connection.
#[derive(Debug, Default)]
pub struct Ledger {
    tokens: HashMap<TokenId, Token>,
    entries: HashMap<SubscriptionAddress, Entry>,
    memberships: usize,
    next: u64,
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

    /// The addresses `token` needs registered: those of its addresses that no
    /// registration covers yet, in the token's order. Addresses already
    /// registered for another owner, or possibly registered, are not sent
    /// again.
    pub fn to_register(&self, token: TokenId) -> Vec<SubscriptionAddress> {
        let Some(token) = self.tokens.get(&token) else {
            return Vec::new();
        };
        token
            .addresses
            .iter()
            .copied()
            .filter(|address| self.entries[address].registration == Registration::NotRegistered)
            .collect()
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

    /// Marks `token` active once all its registrations were accepted.
    pub fn activate(&mut self, token: TokenId) {
        if let Some(token) = self.tokens.get_mut(&token) {
            if token.state == TokenState::Provisional {
                token.state = TokenState::Active;
            }
        }
    }

    /// Ends `token`'s ownership and returns the addresses to unregister: those
    /// it was the last owner of that are registered or possibly registered.
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
        token.state = TokenState::Releasing;
        let mut unregister = Vec::new();
        for address in &token.addresses {
            let entry = self
                .entries
                .get_mut(address)
                .expect("an owned address has an entry");
            entry.owners.retain(|owner| *owner != id);
            if entry.owners.is_empty() {
                match entry.registration {
                    Registration::NotRegistered => {
                        self.entries.remove(address);
                    }
                    Registration::Registered | Registration::Unknown => unregister.push(*address),
                }
            }
        }
        unregister
    }

    /// Records the verdict of an unregistration sent for `address`. An
    /// accepted one forgets the address unless a new owner has taken it
    /// meanwhile, which then needs it registered again.
    pub fn unregistered(&mut self, address: SubscriptionAddress, verdict: Verdict) {
        let Some(entry) = self.entries.get_mut(&address) else {
            return;
        };
        match verdict {
            Verdict::Accepted => {
                entry.registration = Registration::NotRegistered;
                if entry.owners.is_empty() {
                    self.entries.remove(&address);
                }
            }
            Verdict::Rejected => {}
            Verdict::Unknown => entry.registration = Registration::Unknown,
        }
    }

    /// Forgets a token whose release has finished, freeing its capacity.
    pub fn finish(&mut self, token: TokenId) {
        if let Some(token) = self.tokens.remove(&token) {
            self.memberships -= token.addresses.len();
        }
    }

    /// The provisional and active tokens holding `address`, in admission
    /// order: the recipients of a notification for it. Releasing tokens are
    /// not recipients.
    pub fn recipients(&self, address: SubscriptionAddress) -> &[TokenId] {
        self.entries
            .get(&address)
            .map_or(&[], |entry| entry.owners.as_slice())
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
