//! Context-overflow detection for provider errors: a port of pi's
//! `overflow.js` pattern lists. When a model call fails because the request
//! exceeded the model's context window, the ChatRunner retries once after an
//! auto-compaction instead of failing the whole turn. Rate-limit / throttling
//! errors are explicitly EXCLUDED first — several of them contain token-ish
//! wording that would otherwise match an overflow pattern.

use std::sync::LazyLock;

use regex::Regex;

/// Errors that look like overflow but are NOT (checked FIRST, pi semantics):
/// throttling / service-availability / rate-limit wording. A message matching
/// any of these is never treated as a context overflow.
static NON_OVERFLOW_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        // Unanchored on purpose: the string a caller passes is wrapped by the
        // turn's error layers ("provider error: …"), so a `^` anchor never
        // sees the provider's own wording.
        r"(Throttling error|Service unavailable):",
        r"rate limit",
        r"too many requests",
    ]
    .iter()
    .map(|p| Regex::new(&format!(r"(?i){p}")).expect("non-overflow pattern is valid"))
    .collect()
});

/// Provider error messages that mean "the request exceeded the model's
/// context window" (pi's OVERFLOW_PATTERNS, case-insensitive). Covers the
/// wording of Anthropic, OpenAI, Gemini, Bedrock, Groq, Mistral, Ollama and
/// generic HTTP-400/413 proxy errors.
static OVERFLOW_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"prompt is too long",
        r"request_too_large",
        r"input is too long for requested model",
        r"exceeds the context window",
        r#"exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))"#,
        r"input token count.*exceeds the maximum",
        r"maximum prompt length is \d+",
        r"reduce the length of the messages",
        r"maximum context length is \d+ tokens",
        r"exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?",
        r"input \(\d+ tokens\) is longer than the model.?s context length \(\d+ tokens\)",
        r"exceeds the limit of \d+",
        r"exceeds the available context size",
        r"greater than the context length",
        r"context window exceeds limit",
        r"exceeded model token limit",
        r"too large for model with \d+ maximum context length",
        r"prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?",
        r"model_context_window_exceeded",
        r"prompt too long; exceeded (?:max )?context length",
        r"range of input length should be",
        r"context[_ ]length[_ ]exceeded",
        r"too many tokens",
        r"token limit exceeded",
        // HTTP 400/413 with an empty (or absent) body — the shape the
        // provider adapter renders (`status 413: `), and the pi-era
        // `(no body)` variant.
        r"^status 4(?:00|13):?\s*$",
        r"\b4(?:00|13)\s*(?:status code)?\s*\(no body\)",
    ]
    .iter()
    .map(|p| Regex::new(&format!(r"(?i){p}")).expect("overflow pattern is valid"))
    .collect()
});

/// True when a provider error message means the request exceeded the model's
/// context window (and is not a rate-limit / throttling error). Compiled
/// patterns are built once and reused.
pub fn is_context_overflow(msg: &str) -> bool {
    if NON_OVERFLOW_PATTERNS.iter().any(|re| re.is_match(msg)) {
        return false;
    }
    OVERFLOW_PATTERNS.iter().any(|re| re.is_match(msg))
}

/// Classifies the error strings the ChatRunner actually sees: a journaled
/// run failure is wrapped as `provider error: provider error: <raw>` (the
/// TerminalError wrapper plus the provider error's own display prefix), so
/// the wrappers are stripped before the patterns run.
pub fn is_context_overflow_wrapped(msg: &str) -> bool {
    let mut inner = msg;
    loop {
        let stripped = inner
            .strip_prefix("provider error: ")
            .or_else(|| inner.strip_prefix("turn failed: "))
            // The SDK's TerminalError Display wraps every journaled run
            // failure: `Terminal error [<code>]: <message>` (restate-sdk
            // errors.rs). Code-independent: the wrapper's code is the
            // handler's HTTP mapping, not the provider's status.
            .or_else(|| TERMINAL_ERROR_PREFIX.find(inner).map(|m| &inner[m.end()..]))
            .unwrap_or(inner);
        if stripped.len() == inner.len() {
            break;
        }
        inner = stripped;
    }
    is_context_overflow(inner)
}

static TERMINAL_ERROR_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^terminal error \[\d+\]: ").expect("terminal-error prefix pattern is valid")
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sdk_terminal_error_wrapper_is_transparent_to_the_classifier() {
        // The exact Display shape restate-sdk 0.12 produces for a journaled
        // run failure (TerminalErrorInner: "Terminal error [{}]: {}") — the
        // catch site in restate.rs passes e.to_string() (and e.message()).
        let sdk = restate_sdk::errors::TerminalError::new_with_code(500, "status 413: ");
        assert!(is_context_overflow_wrapped(&sdk.to_string()));
        assert!(is_context_overflow(sdk.message()));
        // Code-agnostic: the wrapper's code is the handler's HTTP mapping,
        // not the provider status.
        assert!(is_context_overflow_wrapped(
            &restate_sdk::errors::TerminalError::new_with_code(
                502,
                "prompt is too long: 300000 tokens > 200000 maximum",
            )
            .to_string()
        ));
    }

    #[test]
    fn anthropic_prompt_too_long() {
        assert!(is_context_overflow(
            "prompt is too long: 213462 tokens > 200000 maximum"
        ));
    }

    #[test]
    fn openai_context_window() {
        assert!(is_context_overflow(
            "Error 400: Your input exceeds the context window of this model"
        ));
    }

    #[test]
    fn rate_limit_is_excluded_even_with_token_wording() {
        // Contains overflow-ish wording, but the exclusion patterns win.
        assert!(!is_context_overflow(
            "429: rate limit exceeded — too many requests, slow down"
        ));
        assert!(!is_context_overflow(
            "Throttling error: too many tokens in flight, retry later"
        ));
    }

    #[test]
    fn generic_too_many_tokens() {
        assert!(is_context_overflow(
            "Request failed: too many tokens provided in the input"
        ));
    }

    #[test]
    fn unrelated_errors_are_not_overflow() {
        assert!(!is_context_overflow("invalid api key"));
        assert!(!is_context_overflow("connection reset by peer"));
        assert!(!is_context_overflow(""));
    }

    /// The strings the turn's catch path passes: the TerminalError wrapper
    /// plus the provider error's own display prefix sit in front of the raw
    /// provider message.
    #[test]
    fn wrapped_provider_errors_classify() {
        let wrapped_413 = "provider error: provider error: status 413: ";
        assert!(is_context_overflow_wrapped(wrapped_413));
        let wrapped_throttle =
            "provider error: provider error: status 429: Throttling error: too many requests";
        assert!(!is_context_overflow_wrapped(wrapped_throttle));
        let wrapped_throttle_wording =
            "provider error: provider error: Throttling error: too many tokens in flight";
        assert!(!is_context_overflow_wrapped(wrapped_throttle_wording));
        let wrapped_real =
            "provider error: provider error: status 400: prompt is too long: 213462 tokens > 200000 maximum";
        assert!(is_context_overflow_wrapped(wrapped_real));
        let wrapped_plain = "provider error: provider error: status 500: internal";
        assert!(!is_context_overflow_wrapped(wrapped_plain));
    }
}
