package main

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestFormatJSONNumberMatchesJavaScript(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{1, "1"},
		{1.5, "1.5"},
		{1e21, "1e+21"},
		{1e-7, "1e-7"},
		{0.000001, "0.000001"},
		{1e20, "100000000000000000000"},
		{0.1, "0.1"},
		{1.0 / 3.0, "0.3333333333333333"},
		{0, "0"},
		{123456789, "123456789"},
		{-2.5, "-2.5"},
	}
	for _, testCase := range cases {
		if got := formatJSONNumber(testCase.in); got != testCase.want {
			t.Fatalf("formatJSONNumber(%v) = %q, want %q", testCase.in, got, testCase.want)
		}
	}
}

func TestParseAndStringifyLooseJSON(t *testing.T) {
	parsed, err := ParseJSONLoose(`{"a":1, /* c */ "b":[1,2,], // x
	"c":{"d":"e"}}`)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if got := StringifyJSON(parsed, ""); got != `{"a":1,"b":[1,2],"c":{"d":"e"}}` {
		t.Fatalf("unexpected compact output: %s", got)
	}
	pretty := StringifyJSON(parsed, "  ")
	if !strings.Contains(pretty, "\n  \"a\": 1,") {
		t.Fatalf("unexpected pretty output: %s", pretty)
	}
}

func TestParseJSONLooseRejectsInvalid(t *testing.T) {
	if _, err := ParseJSONLoose(`{"a":}`); err == nil {
		t.Fatal("expected parse error")
	}
	if _, err := ParseJSONLoose(`[1,2`); err == nil {
		t.Fatal("expected parse error for unterminated array")
	}
}

func TestUnicodeEscapeDecoding(t *testing.T) {
	parsed, err := ParseJSONLoose(`"\u4f60\u597d\ud83d\ude00"`)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if parsed.Str != "你好😀" {
		t.Fatalf("unexpected decoded string: %q", parsed.Str)
	}
}

func pipelineItems(t *testing.T, items []PipelineItem) []PipelineItem {
	t.Helper()
	return normalizePipelineItems(items)
}

func TestRunPipelineOperations(t *testing.T) {
	doc, err := ParseJSONLoose(`{"users":[{"name":"b","age":30},{"name":"a","age":20}],"meta":{"z":1}}`)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	items := pipelineItems(t, []PipelineItem{
		{ID: "e", Enabled: true, Type: "extract", Path: "$.users"},
		{ID: "s", Enabled: true, Type: "arraySort", ArrayPath: "$", ItemPath: "$.name", Direction: "asc"},
	})
	run := runPipeline(context.Background(), doc, items, nil)
	if run.Error != nil {
		t.Fatalf("unexpected error: %#v", run.Error)
	}
	if got := StringifyJSON(run.Output, ""); got != `[{"name":"a","age":20},{"name":"b","age":30}]` {
		t.Fatalf("unexpected sorted output: %s", got)
	}
}

func TestRunPipelineFilter(t *testing.T) {
	doc, _ := ParseJSONLoose(`{"items":[{"active":true,"n":1},{"active":false,"n":2},{"active":true,"n":3}]}`)
	items := pipelineItems(t, []PipelineItem{
		{ID: "f", Enabled: true, Type: "filter", ArrayPath: "$.items", ItemPath: "$.active", FilterValue: "true"},
	})
	run := runPipeline(context.Background(), doc, items, nil)
	if run.Error != nil {
		t.Fatalf("unexpected error: %#v", run.Error)
	}
	if got := StringifyJSON(run.Output, ""); got != `{"items":[{"active":true,"n":1},{"active":true,"n":3}]}` {
		t.Fatalf("unexpected filtered output: %s", got)
	}
}

func TestRunPipelineFilterOperators(t *testing.T) {
	doc, err := ParseJSONLoose(`{"items":[{"id":"a","n":1,"s":"ab","v":null,"e":{}},{"id":"b","n":2,"s":"abc","v":"x","e":[]},{"id":"c","n":3,"s":"a","v":0,"e":""},{"id":"d","n":null,"s":"","v":false,"e":null},{"id":"e","n":4,"s":"abcd","v":"","e":"z"}]}`)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	cases := []struct {
		operator string
		itemPath string
		value    string
		want     string
	}{
		{operator: "gt", itemPath: "$.n", value: "2", want: `["c","e"]`},
		{operator: "gte", itemPath: "$.n", value: "2", want: `["b","c","e"]`},
		{operator: "eq", itemPath: "$.n", value: "2", want: `["b"]`},
		{operator: "lt", itemPath: "$.n", value: "2", want: `["a"]`},
		{operator: "lte", itemPath: "$.n", value: "2", want: `["a","b"]`},
		{operator: "notNull", itemPath: "$.v", value: "", want: `["b","c","d","e"]`},
		{operator: "notEmpty", itemPath: "$.e", value: "", want: `["e"]`},
		{operator: "isNull", itemPath: "$.v", value: "", want: `["a"]`},
		{operator: "isEmpty", itemPath: "$.v", value: "", want: `["a","e"]`},
		{operator: "stringLengthGt", itemPath: "$.s", value: "2", want: `["b","e"]`},
		{operator: "stringLengthGte", itemPath: "$.s", value: "2", want: `["a","b","e"]`},
		{operator: "stringLengthEq", itemPath: "$.s", value: "2", want: `["a"]`},
		{operator: "stringLengthLt", itemPath: "$.s", value: "2", want: `["c","d"]`},
		{operator: "stringLengthLte", itemPath: "$.s", value: "2", want: `["a","c","d"]`},
	}
	for _, testCase := range cases {
		run := runPipeline(context.Background(), doc, pipelineItems(t, []PipelineItem{
			{ID: "f", Enabled: true, Type: "filter", ArrayPath: "$.items", ItemPath: testCase.itemPath, Operator: testCase.operator, FilterValue: testCase.value},
			{ID: "e", Enabled: true, Type: "extract", Path: "$.items[*].id"},
		}), nil)
		if run.Error != nil {
			t.Fatalf("operator %s returned error: %#v", testCase.operator, run.Error)
		}
		if got := StringifyJSON(run.Output, ""); got != testCase.want {
			t.Fatalf("operator %s = %s, want %s", testCase.operator, got, testCase.want)
		}
	}
	for _, value := range []string{`"2"`, "-1", "1.5"} {
		run := runPipeline(context.Background(), doc, pipelineItems(t, []PipelineItem{
			{ID: "f", Enabled: true, Type: "filter", ArrayPath: "$.items", ItemPath: "$.s", Operator: "stringLengthEq", FilterValue: value},
		}), nil)
		if run.Error == nil || run.Error.Code != "filterLengthInvalid" {
			t.Fatalf("string length value %s: expected filterLengthInvalid, got %#v", value, run.Error)
		}
	}
}

func TestRunPipelineArrayTrim(t *testing.T) {
	doc, err := ParseJSONLoose(`{"items":[{"a":1,"b":2,"c":"x"},{"a":3,"d":4},"keep",["a"],{"1":"one","a":2}]}`)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	cases := []struct {
		mode  string
		value string
		want  string
	}{
		{mode: "key", value: "a,c", want: `{"items":[{"a":1,"c":"x"},{"a":3},"keep",["a"],{"a":2}]}`},
		{mode: "value", value: "1,x,4", want: `{"items":[{"a":1,"c":"x"},{"d":4},"keep",["a"],{}]}`},
		{mode: "key", value: "1", want: `{"items":[{},{}, "keep",["a"],{"1":"one"}]}`},
	}
	for _, testCase := range cases {
		run := runPipeline(context.Background(), doc, pipelineItems(t, []PipelineItem{
			{ID: "t", Enabled: true, Type: "arrayTrim", ArrayPath: "$.items", MatchMode: testCase.mode, FilterValue: testCase.value},
		}), nil)
		if run.Error != nil {
			t.Fatalf("mode %s value %q returned error: %#v", testCase.mode, testCase.value, run.Error)
		}
		got := StringifyJSON(run.Output, "")
		// 统一比较时去掉空白差异，避免手写期望中的空格影响结果。
		got = strings.ReplaceAll(got, " ", "")
		want := strings.ReplaceAll(testCase.want, " ", "")
		if got != want {
			t.Fatalf("mode %s value %q = %s, want %s", testCase.mode, testCase.value, got, want)
		}
	}
	run := runPipeline(context.Background(), doc, pipelineItems(t, []PipelineItem{
		{ID: "t", Enabled: true, Type: "arrayTrim", ArrayPath: "$.items", MatchMode: "key", FilterValue: ""},
	}), nil)
	if run.Error == nil || run.Error.Code != "filterValueRequired" {
		t.Fatalf("empty trim list: expected filterValueRequired, got %#v", run.Error)
	}
}

func TestRunPipelineExtractThenArrayTrim(t *testing.T) {
	doc, err := ParseJSONLoose(`{"Result":{"data":[{"floor_name":"L4","uuid":"a"},{"floor_name":"L2","uuid":"b"}]}}`)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	run := runPipeline(context.Background(), doc, pipelineItems(t, []PipelineItem{
		{ID: "e", Enabled: true, Type: "extract", Path: "$.Result.data"},
		{ID: "t", Enabled: true, Type: "arrayTrim", ArrayPath: "$", MatchMode: "key", FilterValue: "floor_name"},
	}), nil)
	if run.Error != nil {
		t.Fatalf("unexpected error: %#v", run.Error)
	}
	if got := StringifyJSON(run.Output, ""); got != `[{"floor_name":"L4"},{"floor_name":"L2"}]` {
		t.Fatalf("unexpected trim output: %s", got)
	}
}

func TestRunPipelineFilterIncludesExcludes(t *testing.T) {
	doc, err := ParseJSONLoose(`{"items":[{"id":"a","color":"red"},{"id":"b","color":"green"},{"id":"c","color":"blue"},{"id":"d"},{"id":"e","color":1},{"id":"f","color":"1"},{"id":"g","color":null},{"id":"h","color":{"x":1}}]}`)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	cases := []struct {
		operator string
		value    string
		want     string
	}{
		{operator: "includes", value: "red, blue", want: `["a","c"]`},
		{operator: "includes", value: "1", want: `["e"]`},
		{operator: "includes", value: `"1"`, want: `["f"]`},
		{operator: "excludes", value: "red,green", want: `["c","d","e","f","g","h"]`},
		{operator: "excludes", value: "null", want: `["a","b","c","d","e","f","h"]`},
		{operator: "excludes", value: "red,green,blue,1,\"1\",null", want: `["d","h"]`},
	}
	for _, testCase := range cases {
		run := runPipeline(context.Background(), doc, pipelineItems(t, []PipelineItem{
			{ID: "f", Enabled: true, Type: "filter", ArrayPath: "$.items", ItemPath: "$.color", Operator: testCase.operator, FilterValue: testCase.value},
			{ID: "e", Enabled: true, Type: "extract", Path: "$.items[*].id"},
		}), nil)
		if run.Error != nil {
			t.Fatalf("operator %s value %q returned error: %#v", testCase.operator, testCase.value, run.Error)
		}
		if got := StringifyJSON(run.Output, ""); got != testCase.want {
			t.Fatalf("operator %s value %q = %s, want %s", testCase.operator, testCase.value, got, testCase.want)
		}
	}
	for _, value := range []string{"", " , "} {
		run := runPipeline(context.Background(), doc, pipelineItems(t, []PipelineItem{
			{ID: "f", Enabled: true, Type: "filter", ArrayPath: "$.items", ItemPath: "$.color", Operator: "includes", FilterValue: value},
		}), nil)
		if run.Error == nil || run.Error.Code != "filterValueRequired" {
			t.Fatalf("empty list %q: expected filterValueRequired, got %#v", value, run.Error)
		}
	}
}

func TestRunPipelineArrayDedupe(t *testing.T) {
	doc, err := ParseJSONLoose(`{"items":[{"id":1,"name":"first"},{"id":2,"name":"second"},{"id":1,"name":"third"},{"name":"no-id"},{"id":{"a":1,"b":2},"name":"object"},{"id":{"b":2,"a":1},"name":"same-object"}]}`)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	run := runPipeline(context.Background(), doc, pipelineItems(t, []PipelineItem{
		{ID: "d", Enabled: true, Type: "arrayDedupe", ArrayPath: "$.items", ItemPath: "$.id"},
	}), nil)
	if run.Error != nil {
		t.Fatalf("unexpected error: %#v", run.Error)
	}
	want := `{"items":[{"id":1,"name":"first"},{"id":2,"name":"second"},{"name":"no-id"},{"id":{"a":1,"b":2},"name":"object"}]}`
	if got := StringifyJSON(run.Output, ""); got != want {
		t.Fatalf("unexpected deduped output: %s", got)
	}

	scalars, err := ParseJSONLoose(`[1,2,1,"1",true,true,null,null]`)
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	run = runPipeline(context.Background(), scalars, pipelineItems(t, []PipelineItem{
		{ID: "s", Enabled: true, Type: "arrayDedupe", ArrayPath: "$", ItemPath: "$"},
	}), nil)
	if run.Error != nil {
		t.Fatalf("unexpected error: %#v", run.Error)
	}
	if got := StringifyJSON(run.Output, ""); got != `[1,2,"1",true,null]` {
		t.Fatalf("unexpected scalar dedupe output: %s", got)
	}
}

func TestRunPipelineTemplate(t *testing.T) {
	doc, _ := ParseJSONLoose(`{"name":"n","token":"t"}`)
	items := pipelineItems(t, []PipelineItem{
		{ID: "t", Enabled: true, Type: "template", Template: "{$.name}?token={$.token}"},
	})
	run := runPipeline(context.Background(), doc, items, nil)
	if run.Error != nil {
		t.Fatalf("unexpected error: %#v", run.Error)
	}
	if !run.Text || run.Output.Str != "n?token=t" {
		t.Fatalf("unexpected template output: %#v", run.Output)
	}
}

func TestRunPipelineErrors(t *testing.T) {
	doc, _ := ParseJSONLoose(`{"a":1}`)
	run := runPipeline(context.Background(), doc, pipelineItems(t, []PipelineItem{
		{ID: "x", Enabled: true, Type: "extract", Path: "$.missing"},
	}), nil)
	if run.Error == nil || run.Error.Code != "pathNotFound" {
		t.Fatalf("unexpected error: %#v", run.Error)
	}
	run = runPipeline(context.Background(), doc, pipelineItems(t, []PipelineItem{
		{ID: "t", Enabled: true, Type: "template", Template: "{$.a}"},
		{ID: "e", Enabled: true, Type: "extract", Path: "$.a"},
	}), nil)
	if run.Error == nil || run.Error.Code != "templateNotLast" {
		t.Fatalf("unexpected template error: %#v", run.Error)
	}
	if _, err := ParseJSONLoose(``); err == nil {
		t.Fatal("empty source should not parse")
	}
}

func TestIncrementalReuseMatchesFullRun(t *testing.T) {
	doc, _ := ParseJSONLoose(`{"items":[{"k":3},{"k":1},{"k":2}]}`)
	first := pipelineItems(t, []PipelineItem{
		{ID: "a", Enabled: true, Type: "extract", Path: "$.items"},
		{ID: "b", Enabled: true, Type: "arraySort", ArrayPath: "$", ItemPath: "$.k", Direction: "asc"},
	})
	run1 := runPipeline(context.Background(), doc, first, nil)
	second := append([]PipelineItem(nil), first...)
	second[1].Direction = "desc"
	incremental := runPipeline(context.Background(), doc, second, run1)
	full := runPipeline(context.Background(), doc, second, nil)
	if StringifyJSON(incremental.Output, "") != StringifyJSON(full.Output, "") {
		t.Fatalf("incremental output %s != full %s", StringifyJSON(incremental.Output, ""), StringifyJSON(full.Output, ""))
	}
	if incremental.Stages[0].Output != run1.Stages[0].Output {
		t.Fatal("expected prefix stage to be reused")
	}
}

func TestUpdatePipelineStateVersioning(t *testing.T) {
	service := NewJSONPipelineService()
	t.Cleanup(service.shutdown)
	events := make(chan PipelineResultPayload, 8)
	service.setEventEmitter(func(_ string, data any) {
		if payload, ok := data.(PipelineResultPayload); ok {
			events <- payload
		}
	})
	info := service.OpenPipelineSession()
	source := `{"a":1}`
	first := service.UpdatePipelineState(UpdatePipelineStateRequest{
		SessionID:  info.SessionID,
		MutationID: 1,
		Source:     &source,
		Pipeline: []PipelineItem{
			{ID: "e", Enabled: true, Type: "extract", Path: "$.a"},
		},
	})
	if !first.Accepted || first.DocID != 1 || first.PipelineID != 1 {
		t.Fatalf("unexpected first update: %#v", first)
	}
	payload := waitForResult(t, events)
	if payload.Status != "ok" || payload.PreviewText != "1" {
		t.Fatalf("unexpected payload: %#v", payload)
	}
	// 相同内容不递增版本
	second := service.UpdatePipelineState(UpdatePipelineStateRequest{
		SessionID: info.SessionID, MutationID: 2, BaseDocID: 1, BasePipelineID: 1,
		Source: &source,
		Pipeline: []PipelineItem{
			{ID: "e", Enabled: true, Type: "extract", Path: "$.a"},
		},
	})
	if !second.Accepted || second.DocID != 1 || second.PipelineID != 1 || second.SourceChanged || second.PipelineChanged {
		t.Fatalf("expected unchanged versions: %#v", second)
	}
	// base 冲突
	conflict := service.UpdatePipelineState(UpdatePipelineStateRequest{
		SessionID: info.SessionID, MutationID: 3, BaseDocID: 0, BasePipelineID: 0, Source: &source,
	})
	if !conflict.Conflict {
		t.Fatalf("expected conflict: %#v", conflict)
	}
}

func TestQueryPipelineCompletion(t *testing.T) {
	service := NewJSONPipelineService()
	t.Cleanup(service.shutdown)
	events := make(chan PipelineResultPayload, 8)
	service.setEventEmitter(func(_ string, data any) {
		if payload, ok := data.(PipelineResultPayload); ok {
			events <- payload
		}
	})
	info := service.OpenPipelineSession()
	source := `{"user":{"name":"n","age":1}}`
	update := service.UpdatePipelineState(UpdatePipelineStateRequest{
		SessionID: info.SessionID, MutationID: 1, Source: &source,
		Pipeline: []PipelineItem{{ID: "e", Enabled: true, Type: "extract", Path: "$"}},
	})
	if !update.Accepted {
		t.Fatalf("update rejected: %#v", update)
	}
	waitForResult(t, events)
	response := service.QueryPipelineCompletion(QueryPipelineCompletionRequest{
		SessionID: info.SessionID, DocID: update.DocID, PipelineID: update.PipelineID,
		ItemID: "e", Field: "path", Prefix: "$.user.",
	})
	labels := map[string]bool{}
	for _, option := range response.Items {
		labels[option.Label] = true
	}
	if !labels["name"] || !labels["age"] {
		t.Fatalf("unexpected completion options: %#v", response.Items)
	}
	stale := service.QueryPipelineCompletion(QueryPipelineCompletionRequest{
		SessionID: info.SessionID, DocID: 0, PipelineID: 0, ItemID: "e", Field: "path",
	})
	if !stale.Stale {
		t.Fatal("expected stale response for old pair")
	}
}

func waitForResult(t *testing.T, events <-chan PipelineResultPayload) PipelineResultPayload {
	t.Helper()
	select {
	case payload := <-events:
		return payload
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for pipeline result")
		return PipelineResultPayload{}
	}
}

func TestEmptySourceFirstUpdateEmitsResult(t *testing.T) {
	service := NewJSONPipelineService()
	t.Cleanup(service.shutdown)
	events := make(chan PipelineResultPayload, 4)
	service.setEventEmitter(func(_ string, data any) {
		if payload, ok := data.(PipelineResultPayload); ok {
			events <- payload
		}
	})
	info := service.OpenPipelineSession()
	empty := ""
	update := service.UpdatePipelineState(UpdatePipelineStateRequest{
		SessionID: info.SessionID, MutationID: 1, Source: &empty, Pipeline: []PipelineItem{},
	})
	if !update.Accepted || update.DocID != 0 || update.PipelineID != 0 {
		t.Fatalf("unexpected update: %#v", update)
	}
	payload := waitForResult(t, events)
	if payload.Status != "ok" || payload.PreviewText != "" || !payload.PreviewComplete {
		t.Fatalf("unexpected empty payload: %#v", payload)
	}
}

func TestQueryPipelineCompletionOnErroredFilterStage(t *testing.T) {
	service := NewJSONPipelineService()
	t.Cleanup(service.shutdown)
	events := make(chan PipelineResultPayload, 4)
	service.setEventEmitter(func(_ string, data any) {
		if payload, ok := data.(PipelineResultPayload); ok {
			events <- payload
		}
	})
	info := service.OpenPipelineSession()
	source := `{"items":[{"active":true,"name":"a"}]}`
	update := service.UpdatePipelineState(UpdatePipelineStateRequest{
		SessionID: info.SessionID, MutationID: 1, Source: &source,
		Pipeline: []PipelineItem{{ID: "f", Enabled: true, Type: "filter", ArrayPath: "$.items", ItemPath: "$", FilterValue: ""}},
	})
	if !update.Accepted {
		t.Fatalf("update rejected: %#v", update)
	}
	payload := waitForResult(t, events)
	if payload.Status != "error" || payload.Error == nil || payload.Error.Code != "filterValueRequired" {
		t.Fatalf("expected filterValueRequired error: %#v", payload)
	}
	array := service.QueryPipelineCompletion(QueryPipelineCompletionRequest{
		SessionID: info.SessionID, DocID: update.DocID, PipelineID: update.PipelineID,
		ItemID: "f", Field: "arrayPath", Prefix: "$.",
	})
	labels := map[string]bool{}
	for _, option := range array.Items {
		labels[option.Label] = true
	}
	if !labels["items"] {
		t.Fatalf("arrayPath completion missing items: %#v", array.Items)
	}
	item := service.QueryPipelineCompletion(QueryPipelineCompletionRequest{
		SessionID: info.SessionID, DocID: update.DocID, PipelineID: update.PipelineID,
		ItemID: "f", Field: "itemPath", Prefix: "$.",
	})
	labels = map[string]bool{}
	for _, option := range item.Items {
		labels[option.Label] = true
	}
	if !labels["active"] || !labels["name"] {
		t.Fatalf("itemPath completion missing keys: %#v", item.Items)
	}
}

func TestQueryPipelineCompletionForArrayTrim(t *testing.T) {
	source := `{"items":[{"a":1,"b":"x"},{"b":"y","c":2}]}`
	cases := []struct {
		mode   string
		prefix string
		want   []string
	}{
		{mode: "key", prefix: "", want: []string{"a", "b", "c"}},
		{mode: "key", prefix: "b", want: []string{"b"}},
		{mode: "value", prefix: "", want: []string{`1`, `"x"`, `"y"`, `2`}},
	}
	for _, testCase := range cases {
		service := NewJSONPipelineService()
		t.Cleanup(service.shutdown)
		events := make(chan PipelineResultPayload, 8)
		service.setEventEmitter(func(_ string, data any) {
			if payload, ok := data.(PipelineResultPayload); ok {
				events <- payload
			}
		})
		info := service.OpenPipelineSession()
		update := service.UpdatePipelineState(UpdatePipelineStateRequest{
			SessionID: info.SessionID, MutationID: 1, Source: &source,
			Pipeline: []PipelineItem{
				{ID: "e", Enabled: true, Type: "extract", Path: "$.items"},
				{ID: "t", Enabled: true, Type: "arrayTrim", ArrayPath: "$", MatchMode: testCase.mode, FilterValue: "a"},
			},
		})
		if !update.Accepted {
			t.Fatalf("update rejected: %#v", update)
		}
		waitForResult(t, events)
		response := service.QueryPipelineCompletion(QueryPipelineCompletionRequest{
			SessionID: info.SessionID, DocID: update.DocID, PipelineID: update.PipelineID,
			ItemID: "t", Field: "filterValue", Prefix: testCase.prefix,
		})
		labels := map[string]bool{}
		for _, option := range response.Items {
			labels[option.Label] = true
		}
		for _, want := range testCase.want {
			if !labels[want] {
				t.Fatalf("mode %s prefix %q missing %q: %#v", testCase.mode, testCase.prefix, want, response.Items)
			}
		}
	}
}

func TestQueryPipelineCompletionOffersWildcard(t *testing.T) {
	// 数组根节点元素数超过补全上限，通配不能被截断。
	parts := make([]string, 200)
	for index := range parts {
		parts[index] = strconv.Itoa(index)
	}
	arrayItems := completionLabelsFor(t, "["+strings.Join(parts, ",")+"]", "$[")
	if !hasCompletionLabel(arrayItems, "[*]") {
		t.Fatalf("array bracket completion missing [*]: %d items", len(arrayItems))
	}
	if !hasCompletionLabel(arrayItems, "[0]") {
		t.Fatal("array bracket completion missing [0]")
	}

	// 对象根节点同样支持按通配展开值。
	objectItems := completionLabelsFor(t, `{"a":1,"b":2}`, "$[")
	if !hasCompletionLabel(objectItems, "[*]") {
		t.Fatalf("object bracket completion missing [*]: %#v", objectItems)
	}
	if !hasCompletionLabel(objectItems, "['a']") {
		t.Fatalf("object bracket completion missing ['a']: %#v", objectItems)
	}
}

func completionLabelsFor(t *testing.T, source, prefix string) []CompletionOption {
	t.Helper()
	service := NewJSONPipelineService()
	t.Cleanup(service.shutdown)
	events := make(chan PipelineResultPayload, 8)
	service.setEventEmitter(func(_ string, data any) {
		if payload, ok := data.(PipelineResultPayload); ok {
			events <- payload
		}
	})
	info := service.OpenPipelineSession()
	update := service.UpdatePipelineState(UpdatePipelineStateRequest{
		SessionID: info.SessionID, MutationID: 1, Source: &source,
		Pipeline: []PipelineItem{{ID: "e", Enabled: true, Type: "extract", Path: "$"}},
	})
	if !update.Accepted {
		t.Fatalf("update rejected: %#v", update)
	}
	waitForResult(t, events)
	response := service.QueryPipelineCompletion(QueryPipelineCompletionRequest{
		SessionID: info.SessionID, DocID: update.DocID, PipelineID: update.PipelineID,
		ItemID: "e", Field: "path", Prefix: prefix,
	})
	return response.Items
}

func hasCompletionLabel(items []CompletionOption, label string) bool {
	for _, item := range items {
		if item.Label == label {
			return true
		}
	}
	return false
}
