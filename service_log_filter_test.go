package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestLogExpression(t *testing.T) {
	line := ServiceLogLine{Runtime: "docker", Name: "api-main", Stream: "stderr", Text: "\x1b[31mAAA timeout\x1b[0m"}
	tests := []struct {
		query string
		want  bool
	}{
		{`"AAA" or "BBB"`, true},
		{`"AAA" and "BBB"`, false},
		{`"AAA" or "BBB" and "missing"`, true},
		{`("AAA" or "BBB") and not "timeout"`, false},
		{`@api-main "AAA" and "timeout"`, true},
		{`@api-main "missing"`, false},
		{`@other "missing"`, true},
		{"AAA timeout", true},
		{`"AAA timeout"`, true},
		{`"and"`, false},
	}
	for _, tt := range tests {
		t.Run(tt.query, func(t *testing.T) {
			match, err := newLogFilter(ServiceLogFilter{Query: tt.query})
			if err != nil {
				t.Fatal(err)
			}
			if got := match(line); got != tt.want {
				t.Fatalf("got %v want %v", got, tt.want)
			}
		})
	}
	for _, query := range []string{`"AAA`, `("AAA"`, `"AAA" and`, `@ "api"`, `@stream`, `"AAA" "BBB"`, `"`, `@stream and`} {
		if _, err := newLogFilter(ServiceLogFilter{Query: query}); err == nil {
			t.Errorf("accepted invalid query %q", query)
		}
	}
	for _, f := range []ServiceLogFilter{
		{Query: "aaa", CaseSensitive: true},
		{Query: "AA", WholeWord: true},
	} {
		other := line
		match, err := newLogFilter(f)
		if err != nil {
			t.Fatal(err)
		}
		if match(other) {
			t.Errorf("unexpected match: %+v", f)
		}
	}
	for _, f := range []ServiceLogFilter{{Query: "aaa", WholeWord: true}, {Query: "A.*timeout", Regex: true}, {Query: "AAA", Regex: true, WholeWord: true}} {
		match, err := newLogFilter(f)
		if err != nil || !match(line) {
			t.Fatalf("filter %+v failed: %v", f, err)
		}
	}
}

func TestLogFilterHistory(t *testing.T) {
	s := &ConfigService{path: filepath.Join(t.TempDir(), "config.json")}
	for i := 0; i < 55; i++ {
		if _, err := s.LogFilterHistory("add", fmt.Sprint(i)); err != nil {
			t.Fatal(err)
		}
	}
	history, err := s.LogFilterHistory("list", "")
	if err != nil || len(history) != 50 || history[0] != "54" || history[49] != "5" {
		t.Fatalf("history %v: %v", history, err)
	}
	history, err = s.LogFilterHistory("add", " 10 ")
	if err != nil || len(history) != 50 || history[0] != "10" {
		t.Fatal(history, err)
	}
	history, err = s.LogFilterHistory("delete", "10")
	if err != nil || len(history) != 49 {
		t.Fatal(history, err)
	}
	restored := &ConfigService{path: s.path}
	history, err = restored.LogFilterHistory("list", "")
	if err != nil || len(history) != 49 {
		t.Fatal(history, err)
	}
	if _, err = s.LogFilterHistory("clear", ""); err != nil {
		t.Fatal(err)
	}
	history, err = restored.LogFilterHistory("list", "")
	if err != nil || len(history) != 0 {
		t.Fatal(history, err)
	}
}

func TestLogFilterHighlightPattern(t *testing.T) {
	tests := []struct {
		filter ServiceLogFilter
		want   string
	}{
		{ServiceLogFilter{Query: `"AAA" or "BBB"`}, "AAA|BBB"},
		{ServiceLogFilter{Query: `"AAA" and not "BBB"`}, "AAA"},
		{ServiceLogFilter{Query: `not ("AAA" or not "BBB")`}, "BBB"},
		{ServiceLogFilter{Query: `@api "BBB"`}, "BBB"},
		{ServiceLogFilter{Query: `@api not "AAA"`}, ""},
		{ServiceLogFilter{Query: `"a.b" or "AAA"`}, `a\.b|AAA`},
		{ServiceLogFilter{Query: `"AAA" or "BBBB"`, WholeWord: true}, `\b(?:BBBB)\b|\b(?:AAA)\b`},
		{ServiceLogFilter{Query: "plain text"}, "plain text"},
		{ServiceLogFilter{Query: `AAA|BBB`, Regex: true}, `AAA|BBB`},
		{ServiceLogFilter{Query: `AAA|BBB`, Regex: true, WholeWord: true}, `\b(?:AAA|BBB)\b`},
	}
	for _, tt := range tests {
		t.Run(tt.filter.Query, func(t *testing.T) {
			_, got, scoped, err := compileLogFilter(tt.filter)
			if strings.HasPrefix(tt.filter.Query, "@api ") {
				got = scoped["api"]
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("pattern %q want %q", got, tt.want)
			}
		})
	}
}

func TestQueryLogBufferReturnsSyntaxHighlights(t *testing.T) {
	service := &ServiceManagerService{monitors: map[string]*logMonitorState{
		"api": {LogMonitor: LogMonitor{ID: "api"}, lines: []ServiceLogLine{
			{Sequence: 1, MonitorID: "api", Runtime: "docker", Name: "api", Text: "\x1b[31mAAA\x1b[0m"},
			{Sequence: 2, MonitorID: "api", Runtime: "docker", Name: "api", Text: "BBB"},
		}},
	}}
	snapshot, err := service.QueryLogBuffer(QueryLogBufferRequest{
		MonitorIDs: []string{"api"},
		Filter:     ServiceLogFilter{Query: `@api ("AAA" or "BBB") and not "ignored"`},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Lines) != 2 || snapshot.HighlightPattern != "" || snapshot.HighlightPatterns["api"] != "AAA|BBB" {
		t.Fatalf("匹配与高亮结果不一致: %#v", snapshot)
	}
}

func TestScopedLogFilterLeavesOtherResourcesUnchanged(t *testing.T) {
	for _, name := range []string{"api", "service with spaces", "服务一", "api.prod-1"} {
		query := "@" + name
		if name == "service with spaces" {
			query = `@"service with spaces"`
		}
		match, pattern, scopes, err := compileLogFilter(ServiceLogFilter{Query: query + ` "error" and not "ignored"`})
		if err != nil {
			t.Fatal(err)
		}
		if scopes[name] != "error" || pattern != "" {
			t.Fatalf("scopes=%v pattern=%q", scopes, pattern)
		}
		for _, runtime := range []string{"docker", "pm2", "systemd"} {
			for _, tt := range []struct {
				name, text string
				want       bool
			}{
				{name, "error", true}, {name, "healthy", false}, {name, "error ignored", false},
				{"other", "healthy", true}, {"other", "error ignored", true}, {name + "-extra", "healthy", true},
			} {
				if got := match(ServiceLogLine{Runtime: runtime, Name: tt.name, Text: tt.text}); got != tt.want {
					t.Fatalf("%s %s %q: got %v want %v", runtime, tt.name, tt.text, got, tt.want)
				}
			}
		}
	}
}

func TestMixedGlobalAndScopedLogFilters(t *testing.T) {
	query := `"bb" and (@api "a") and (@"worker service" "cc")`
	match, global, patterns, err := compileLogFilter(ServiceLogFilter{Query: query})
	if err != nil {
		t.Fatal(err)
	}
	if global != "bb" || patterns["api"] != "bb|a" || patterns["worker service"] != "bb|cc" {
		t.Fatalf("全局和局部高亮错误: %q %v", global, patterns)
	}
	for _, tt := range []struct {
		name, text string
		want       bool
	}{
		{"api", "a bb", true}, {"api", "bb", false}, {"api", "a", false},
		{"worker service", "bb cc", true}, {"worker service", "bb", false},
		{"other", "bb", true}, {"other", "a cc", false}, {"other", "bb a cc", true},
	} {
		if got := match(ServiceLogLine{Name: tt.name, Text: tt.text}); got != tt.want {
			t.Errorf("%s %q: got %v want %v", tt.name, tt.text, got, tt.want)
		}
	}
	for _, query := range []string{`"bb" and (@api)`, `"bb" and (@ "api")`, `"bb" and (@api "a"`} {
		if _, err := newLogFilter(ServiceLogFilter{Query: query}); err == nil {
			t.Errorf("接受了无效作用域: %s", query)
		}
	}
}

func TestScopedLogFilterNestedBoundaries(t *testing.T) {
	match, global, patterns, err := compileLogFilter(ServiceLogFilter{Query: `(@api ("a" or "b") and not "ignored") and "bb"`})
	if err != nil {
		t.Fatal(err)
	}
	if global != "bb" || patterns["api"] != "bb|a|b" {
		t.Fatal(global, patterns)
	}
	if !match(ServiceLogLine{Name: "other", Text: "bb ignored"}) {
		t.Fatal("局部排除条件影响其他对象")
	}
	if match(ServiceLogLine{Name: "api", Text: "a bb ignored"}) {
		t.Fatal("局部排除条件失效")
	}
	if !match(ServiceLogLine{Name: "api", Text: "a bb"}) {
		t.Fatal("局部组合条件失效")
	}
	_, global, patterns, err = compileLogFilter(ServiceLogFilter{Query: `@api "a" and (@other "hidden")`})
	if err != nil || global != "" || patterns["api"] != "a" || patterns["other"] != "" {
		t.Fatal(global, patterns, err)
	}
}
