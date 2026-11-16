package de.kinotix.firetv;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Reads only static positional episode data from inline show calls. */
final class TvEpisodeMatrix {
    private static final int MAX_SCRIPT_LENGTH = 100_000;
    private static final int MAX_PAGE_LENGTH = 500_000;
    private static final int MAX_SCRIPTS = 24;
    private static final int MAX_CANDIDATES = 12;
    private static final int MAX_LINKS = 500;
    private static final int MAX_ADDRESS = 2_048;

    static final class Slot {
        final int season;
        final int number;
        final String url;

        Slot(int season, int number, String url) {
            this.season = season;
            this.number = number;
            this.url = url;
        }
    }

    private int scripts;
    private int remaining = MAX_PAGE_LENGTH;

    List<Slot> read(String script) {
        if (script.isEmpty() || scripts >= MAX_SCRIPTS || remaining <= 0) return Collections.emptyList();
        scripts++;
        int length = Math.min(script.length(), Math.min(MAX_SCRIPT_LENGTH, remaining));
        remaining -= length;
        Cursor cursor = new Cursor(script.substring(0, length), 0);
        int candidates = 0;
        while (cursor.index < length) {
            cursor.trivia();
            if (cursor.index >= length) break;
            char character = cursor.text.charAt(cursor.index);
            if (character == '\'' || character == '"' || character == '`') {
                cursor.skipString(character);
                continue;
            }
            int dot = cursor.index++;
            if (character != '.' || !cursor.text.startsWith("show", dot + 1) || !hasReceiver(cursor.text, dot)) continue;
            if (++candidates > MAX_CANDIDATES) break;
            try {
                List<Slot> matrix = new Cursor(cursor.text, dot + 5).call();
                if (!matrix.isEmpty()) return matrix;
            } catch (Invalid ignored) {
                // Only a complete literal argument list yields links.
            }
        }
        return Collections.emptyList();
    }

    private static boolean hasReceiver(String text, int dot) {
        int previous = dot - 1;
        while (previous >= 0 && space(text.charAt(previous))) previous--;
        return previous >= 0 && Character.isJavaIdentifierPart(text.charAt(previous));
    }

    private static boolean space(char character) {
        return Character.isWhitespace(character) || Character.isSpaceChar(character) || character == '\uFEFF';
    }

    private static final class Cursor {
        final String text;
        int index;

        Cursor(String text, int index) {
            this.text = text;
            this.index = index;
        }

        List<Slot> call() throws Invalid {
            require('(');
            integer();
            require(',');
            require('[');
            List<Slot> result = new ArrayList<>();
            if (!take(']')) {
                for (int season = 1; ; season++) {
                    if (season > 999) throw new Invalid();
                    readSeason(season, result);
                    if (take(']')) break;
                    require(',');
                    if (take(']')) break;
                }
            }
            require(')');
            return result;
        }

        private void readSeason(int season, List<Slot> result) throws Invalid {
            require('[');
            if (take(']')) return;
            for (int episode = 1; ; episode++) {
                if (episode > 9_999) throw new Invalid();
                trivia();
                String url;
                if (text.startsWith("null", index)) {
                    index += 4;
                    url = "";
                } else {
                    url = stringLiteral();
                }
                if (!url.isEmpty() && result.size() < MAX_LINKS) result.add(new Slot(season, episode, url));
                if (take(']')) return;
                require(',');
                if (take(']')) return;
            }
        }

        private void integer() throws Invalid {
            trivia();
            int digits = 0;
            while (index < text.length() && text.charAt(index) >= '0' && text.charAt(index) <= '9') {
                if (++digits > 4) throw new Invalid();
                index++;
            }
            if (digits == 0) throw new Invalid();
        }

        private String stringLiteral() throws Invalid {
            if (index == text.length()) throw new Invalid();
            char quote = text.charAt(index++);
            if (quote != '\'' && quote != '"') throw new Invalid();
            StringBuilder value = new StringBuilder();
            boolean usable = true;
            while (index < text.length()) {
                char character = text.charAt(index++);
                if (character == quote) return usable && TvCatalogPatterns.wellFormedText(value) ? value.toString().trim() : "";
                if (character == '\r' || character == '\n') throw new Invalid();
                if (character == '\\') {
                    if (index == text.length()) throw new Invalid();
                    char escape = text.charAt(index++);
                    if (escape == 'u' || escape == 'x') {
                        int digits = escape == 'u' ? 4 : 2;
                        int decoded = TvCatalogPatterns.hex(text, index, digits);
                        if (decoded < 0) throw new Invalid();
                        index += digits;
                        character = (char) decoded;
                    } else if (escape == '\r' || escape == '\n') {
                        if (escape == '\r' && index < text.length() && text.charAt(index) == '\n') index++;
                        continue;
                    } else if (escape == '\\' || escape == '/' || escape == '\'' || escape == '"') {
                        character = escape;
                    } else if ("bfnrtv0".indexOf(escape) >= 0) {
                        usable = false;
                        continue;
                    } else {
                        throw new Invalid();
                    }
                }
                if (character < ' ' || character == 127 || value.length() >= MAX_ADDRESS) usable = false;
                if (usable) value.append(character);
            }
            throw new Invalid();
        }

        void skipString(char quote) {
            index++;
            while (index < text.length()) {
                char character = text.charAt(index++);
                if (character == quote) return;
                if (character == '\\' && index < text.length()) index++;
            }
        }

        void trivia() {
            while (index < text.length()) {
                if (space(text.charAt(index))) index++;
                else if (text.startsWith("//", index)) {
                    index += 2;
                    while (index < text.length() && text.charAt(index) != '\n' && text.charAt(index) != '\r') index++;
                } else if (text.startsWith("/*", index)) {
                    int end = text.indexOf("*/", index + 2);
                    index = end < 0 ? text.length() : end + 2;
                } else break;
            }
        }

        private boolean take(char expected) {
            trivia();
            if (index >= text.length() || text.charAt(index) != expected) return false;
            index++;
            return true;
        }

        private void require(char expected) throws Invalid {
            if (!take(expected)) throw new Invalid();
        }
    }

    private static final class Invalid extends Exception {
        private static final long serialVersionUID = 1;
    }
}
