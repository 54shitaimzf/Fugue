# Mandatory literal groups in optional indexed grep

This records the initial fixed-group extension. The current bounded optional/dot admission and its mandatory-run proof are described in [mandatory literal runs](MANDATORY-LITERAL-RUNS.md); its unsupported forms still preserve the scanner fallback.

ROADMAP §4's 0.3.3 query equivalence requires every indexed exclusion to preserve the original regular expression's matches. The optional extractor now accepts balanced, unquantified capture groups `(...)` and noncapture groups `(?:...)` when their entire contents are literal concatenation. For example, `rare(?:_hit)`, `rare(_hit)` and `rare_hit` all require the same fixed substring. Their UTF-16 trigrams are therefore mandatory for every true native match, including trigrams crossing group boundaries.

This is an index-admission subset. Alternation, every quantifier, character classes, dot, lookaround, named or modifier groups, backreferences, unknown escapes, internal anchors and all flags still return `null` for the whole pattern. The existing regex scanner handles those queries. The single optional outside `^`/`$` anchors and escaped punctuation keep their original meaning; escaped parentheses, dollar and pipe are literal text. Empty unquantified groups contribute no text. Fewer than three literal code units never produce an exclusion condition.

The parser is iterative and retains the 4,096-pattern-unit and 128-required-trigram caps. More than 64 nested groups returns `null`; it does not reject a valid user regex. No index format, tool catalog, public interface or default activation changes.

The focused fast tests include exhaustive binary subjects, 2,000 seeded escaped Unicode/grouped patterns, non-vacuous native-match-to-gram containment, group-boundary trigrams, malformed/unsupported syntax and depth/unit fallback. Actual prepared-View receipt and cost evidence is recorded separately. Initial exact-f7 profiling established the coverage gap on generated 512-file, 16 MiB code/mixed corpora: the equivalent plain literal read one source file, while either grouped spelling bypassed cohort filtering and read all 512. Those baseline samples justify the scope; they are not a final cold-target certificate. Preparation remains caller-paid and optional indexing remains off by default.

Owner gate: `node tools/test-entry.js fast src/search/regex-literal.test.ts`
