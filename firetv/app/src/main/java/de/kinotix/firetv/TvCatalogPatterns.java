package de.kinotix.firetv;

import com.google.re2j.Matcher;
import com.google.re2j.Pattern;
import com.google.re2j.PatternSyntaxException;

import java.util.List;

/** Extracts catalog captures with a linear-time matcher and bounded inputs. */
final class TvCatalogPatterns {
    private static final int MAX_RULE_LENGTH = 450;
    private static final int MAX_CONTROL_LENGTH = 32_768;
    private static final int MAX_SCRIPT_LENGTH = 100_000;
    private static final int MAX_URL_LENGTH = 2_048;
    private static final int MAX_MATCHES = 20;
    private static final int MAX_PAGE_LENGTH = 4_000_000;

    static final class Match {
        final String url;
        final int height;

        Match(String url, int height) {
            this.url = url;
            this.height = height;
        }
    }

    private final Pattern pattern;
    private int remaining = MAX_PAGE_LENGTH;
    private int matches;

    private TvCatalogPatterns(Pattern pattern) {
        this.pattern = pattern;
    }

    static TvCatalogPatterns compile(String expression, int groups) {
        if (expression == null || expression.isEmpty() || expression.length() > MAX_RULE_LENGTH) return null;
        try {
            Pattern pattern = Pattern.compile(unicodeEscapes(expression));
            return pattern.matcher("").groupCount() >= groups ? new TvCatalogPatterns(pattern) : null;
        } catch (PatternSyntaxException error) {
            return null;
        }
    }

    String source(String raw) {
        if (raw == null || raw.isEmpty() || remaining <= 0) return null;
        Matcher matcher = pattern.matcher(input(raw, MAX_CONTROL_LENGTH));
        return matcher.find() ? url(matcher, 1) : null;
    }

    boolean appendVariants(String script, List<Match> result) {
        if (remaining <= 0 || matches >= MAX_MATCHES) return false;
        Matcher matcher = pattern.matcher(input(script, MAX_SCRIPT_LENGTH));
        while (matches < MAX_MATCHES && matcher.find()) {
            matches++;
            String address = url(matcher, 2);
            if (address != null) result.add(new Match(address, parseHeight(matcher.group(1))));
        }
        return remaining > 0 && matches < MAX_MATCHES;
    }

    private String input(String value, int maximum) {
        int length = Math.min(value.length(), Math.min(maximum, remaining));
        remaining -= length;
        return length == value.length() ? value : value.substring(0, length);
    }

    // RE2 writes a Unicode escape as \x{hhhh}; escaped backslashes remain literal.
    private static String unicodeEscapes(String value) {
        StringBuilder result = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char current = value.charAt(i);
            if (current != '\\' || i + 1 == value.length()) {
                result.append(current);
                continue;
            }
            char escape = value.charAt(++i);
            int code = escape == 'u' ? hex(value, i + 1, 4) : -1;
            if (code < 0) result.append('\\').append(escape);
            else {
                result.append("\\x{").append(value, i + 1, i + 5).append('}');
                i += 4;
            }
        }
        return result.toString();
    }

    private static String url(Matcher matcher, int group) {
        int start = matcher.start(group);
        int length = matcher.end(group) - start;
        if (start < 0 || length == 0 || length > MAX_URL_LENGTH) return null;
        String raw = matcher.group(group);
        if (raw.indexOf('\\') < 0) return raw;
        StringBuilder value = new StringBuilder(raw.length());
        for (int index = 0; index < raw.length(); index++) {
            char character = raw.charAt(index);
            if (character == '\\') {
                if (++index >= raw.length()) return null;
                char escape = raw.charAt(index);
                if (escape == '/') character = '/';
                else {
                    int lengthOfEscape = escape == 'u' ? 4 : escape == 'x' ? 2 : 0;
                    int code = lengthOfEscape == 0 ? -1 : hex(raw, index + 1, lengthOfEscape);
                    if (code < 0) return null;
                    index += lengthOfEscape;
                    character = (char) code;
                    if (character < ' ' || character == 127 || character == '\\') return null;
                }
            }
            value.append(character);
        }
        return wellFormedText(value) ? value.toString() : null;
    }

    static boolean wellFormedText(CharSequence value) {
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (!Character.isSurrogate(character)) continue;
            if (index + 1 == value.length() || !Character.isSurrogatePair(character, value.charAt(++index))) return false;
        }
        return true;
    }

    static int hex(String value, int start, int length) {
        if (start + length > value.length()) return -1;
        int code = 0;
        for (int i = start; i < start + length; i++) {
            char letter = value.charAt(i);
            int digit = Character.digit(letter, 16);
            if (letter > 127 || digit < 0) return -1;
            code = code * 16 + digit;
        }
        return code;
    }

    private static int parseHeight(String value) {
        if (value == null || value.length() > 16) return 0;
        try {
            int height = Integer.parseInt(value.trim());
            return height >= 0 && height <= 4_320 ? height : 0;
        } catch (NumberFormatException error) {
            return 0;
        }
    }

}
