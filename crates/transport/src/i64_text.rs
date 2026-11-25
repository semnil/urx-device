//! Canonical decimal text for signed 64-bit integers (K7).
//!
//! Raw values and address coordinates cross the application boundary as text,
//! so the full `i64` range survives a JavaScript `number`. Device Center itself
//! still receives JSON integers; this text form exists only between the
//! applications and this crate.

use std::fmt;

/// Why a text slot did not hold a canonical `i64`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum I64TextError {
    /// Not `0`, or an optional `-` followed by a nonzero ASCII digit and further
    /// ASCII digits. Covers `+`, whitespace, leading zeros, `-0`, fractions,
    /// exponents and empty text.
    NotCanonical,
    /// Canonical, but outside `i64::MIN..=i64::MAX`.
    OutOfRange,
}

impl fmt::Display for I64TextError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            I64TextError::NotCanonical => f.write_str("not canonical signed decimal text"),
            I64TextError::OutOfRange => f.write_str("outside the signed 64-bit range"),
        }
    }
}

impl std::error::Error for I64TextError {}

/// Parses canonical decimal text into an `i64`, never truncating, clamping or
/// rounding.
pub fn parse(text: &str) -> Result<i64, I64TextError> {
    let digits = text.strip_prefix('-').unwrap_or(text);
    let canonical = match digits.as_bytes() {
        [b'0'] => digits.len() == text.len(),
        [first, rest @ ..] => (b'1'..=b'9').contains(first) && rest.iter().all(u8::is_ascii_digit),
        [] => false,
    };
    if !canonical {
        return Err(I64TextError::NotCanonical);
    }
    text.parse::<i64>().map_err(|_| I64TextError::OutOfRange)
}

/// Formats an `i64` as canonical decimal text.
pub fn format(value: i64) -> String {
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::{format, parse, I64TextError};

    #[test]
    fn the_range_endpoints_and_the_safe_integer_boundaries_round_trip() {
        for value in [
            i64::MIN,
            i64::MIN + 1,
            -9_007_199_254_740_993,
            -9_007_199_254_740_992,
            -9_007_199_254_740_991,
            -1,
            0,
            1,
            9_007_199_254_740_991,
            9_007_199_254_740_992,
            9_007_199_254_740_993,
            i64::from(u32::MAX),
            i64::MAX - 1,
            i64::MAX,
        ] {
            let text = format(value);
            assert_eq!(parse(&text), Ok(value), "{text}");
        }
        assert_eq!(format(i64::MIN), "-9223372036854775808");
        assert_eq!(format(i64::MAX), "9223372036854775807");
    }

    #[test]
    fn one_past_either_endpoint_is_out_of_range() {
        assert_eq!(parse("9223372036854775808"), Err(I64TextError::OutOfRange));
        assert_eq!(parse("-9223372036854775809"), Err(I64TextError::OutOfRange));
        assert_eq!(
            parse("123456789012345678901234567890"),
            Err(I64TextError::OutOfRange)
        );
    }

    #[test]
    fn noncanonical_text_is_rejected() {
        for text in [
            "", "-", "+1", " 1", "1 ", "01", "00", "-0", "-01", "1.0", "1.", ".5", "1e3", "1E3",
            "0x10", "١", "1_000", "--1", "- 1", "NaN", "Infinity",
        ] {
            assert_eq!(parse(text), Err(I64TextError::NotCanonical), "{text:?}");
        }
    }
}
