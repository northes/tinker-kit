package main

import (
	"regexp"
	"sort"
	"strings"
	"unicode"
)

type logPredicate func(ServiceLogLine) bool
type logToken struct {
	value  string
	quoted bool
}
type logHighlightTerm struct {
	value  string
	scopes []string
}

type logExpression struct {
	tokens     []logToken
	pos        int
	filter     ServiceLogFilter
	negated    bool
	highlights []logHighlightTerm
	scopes     []string
}

func compileLogExpression(f ServiceLogFilter) (logPredicate, []logHighlightTerm, error) {
	// 未使用语法时保留整段文本的包含匹配。
	if !strings.ContainsAny(f.Query, "\"()@") {
		syntax := false
		for _, word := range strings.Fields(f.Query) {
			if word == "and" || word == "or" || word == "not" {
				syntax = true
			}
		}
		if !syntax {
			return logTerm(f.Query, f), []logHighlightTerm{{value: f.Query}}, nil
		}
	}
	var tokens []logToken
	r := []rune(f.Query)
	for i := 0; i < len(r); {
		if unicode.IsSpace(r[i]) {
			i++
			continue
		}
		if r[i] == '(' || r[i] == ')' {
			tokens = append(tokens, logToken{value: string(r[i])})
			i++
			continue
		}
		if r[i] == '"' {
			i++
			var b strings.Builder
			closed := false
			for i < len(r) {
				c := r[i]
				i++
				if c == '"' {
					closed = true
					break
				}
				if c == '\\' && i < len(r) && (r[i] == '"' || r[i] == '\\') {
					c = r[i]
					i++
				}
				b.WriteRune(c)
			}
			if !closed {
				return nil, nil, userError("errors.service.logSyntaxInvalid")
			}
			tokens = append(tokens, logToken{b.String(), true})
			continue
		}
		start := i
		for i < len(r) && !unicode.IsSpace(r[i]) && r[i] != '(' && r[i] != ')' && r[i] != '"' {
			i++
		}
		tokens = append(tokens, logToken{value: string(r[start:i])})
	}
	p := logExpression{tokens: tokens, filter: f}
	result, err := p.or()
	if err != nil || p.pos != len(tokens) {
		return nil, nil, userError("errors.service.logSyntaxInvalid")
	}
	return result, p.highlights, nil
}
func (p *logExpression) take(s string) bool {
	if p.pos < len(p.tokens) && !p.tokens[p.pos].quoted && p.tokens[p.pos].value == s {
		p.pos++
		return true
	}
	return false
}
func (p *logExpression) or() (logPredicate, error) {
	// @名称 的范围持续到当前括号结束；顶层写法仍限定整条表达式。
	if p.pos < len(p.tokens) && !p.tokens[p.pos].quoted && strings.HasPrefix(p.tokens[p.pos].value, "@") {
		scope := strings.TrimPrefix(p.tokens[p.pos].value, "@")
		p.pos++
		if scope == "" {
			if p.pos >= len(p.tokens) || !p.tokens[p.pos].quoted || p.tokens[p.pos].value == "" {
				return nil, userError("errors.service.logSyntaxInvalid")
			}
			scope = p.tokens[p.pos].value
			p.pos++
		}
		p.scopes = append(p.scopes, scope)
		match, err := p.or()
		p.scopes = p.scopes[:len(p.scopes)-1]
		if err != nil {
			return nil, err
		}
		return func(line ServiceLogLine) bool { return line.Name != scope || match(line) }, nil
	}
	left, err := p.and()
	for err == nil && p.take("or") {
		right, e := p.and()
		err = e
		a, b := left, right
		left = func(l ServiceLogLine) bool { return a(l) || b(l) }
	}
	return left, err
}
func (p *logExpression) and() (logPredicate, error) {
	left, err := p.atom()
	for err == nil && p.take("and") {
		right, e := p.atom()
		err = e
		a, b := left, right
		left = func(l ServiceLogLine) bool { return a(l) && b(l) }
	}
	return left, err
}
func (p *logExpression) atom() (logPredicate, error) {
	if p.take("not") {
		p.negated = !p.negated
		a, e := p.atom()
		p.negated = !p.negated
		if e != nil {
			return nil, e
		}
		return func(l ServiceLogLine) bool { return !a(l) }, nil
	}
	if p.take("(") {
		a, e := p.or()
		if e != nil || !p.take(")") {
			return nil, userError("errors.service.logSyntaxInvalid")
		}
		return a, nil
	}
	if p.pos >= len(p.tokens) {
		return nil, userError("errors.service.logSyntaxInvalid")
	}
	token := p.tokens[p.pos]
	p.pos++
	if !token.quoted && (token.value == "and" || token.value == "or" || token.value == "not" || token.value == "(" || token.value == ")" || strings.HasPrefix(token.value, "@")) {
		return nil, userError("errors.service.logSyntaxInvalid")
	}
	if !p.negated && token.value != "" {
		p.highlights = append(p.highlights, logHighlightTerm{value: token.value, scopes: append([]string(nil), p.scopes...)})
	}
	return logTerm(token.value, p.filter), nil
}
func logTerm(value string, f ServiceLogFilter) logPredicate {
	needle := value
	if !f.CaseSensitive {
		needle = strings.ToLower(needle)
	}
	var word *regexp.Regexp
	if f.WholeWord {
		pattern := "\\b(?:" + regexp.QuoteMeta(value) + ")\\b"
		if !f.CaseSensitive {
			pattern = "(?i)" + pattern
		}
		word = regexp.MustCompile(pattern)
	}
	return func(l ServiceLogLine) bool {
		text := stripAnsiSequences(l.Text)

		if word != nil {
			return word.MatchString(text)
		}
		if !f.CaseSensitive {
			text = strings.ToLower(text)
		}
		return strings.Contains(text, needle)
	}
}

// 全局关键词和各作用域关键词分别生成高亮，避免标记其他对象的正文。
func logHighlightPattern(terms []string, wholeWord bool) string {
	patterns := []string{}
	seen := map[string]bool{}
	for _, term := range terms {
		if term == "" || seen[term] {
			continue
		}
		seen[term] = true
		pattern := regexp.QuoteMeta(term)
		if wholeWord {
			pattern = `\b(?:` + pattern + `)\b`
		}
		patterns = append(patterns, pattern)
	}
	sort.SliceStable(patterns, func(i, j int) bool { return len(patterns[i]) > len(patterns[j]) })
	return strings.Join(patterns, "|")
}
