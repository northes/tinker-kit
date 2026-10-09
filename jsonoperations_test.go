package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRepairJSON(t *testing.T) {
	service := NewJSONPipelineService()
	tests := []struct {
		name   string
		source string
		want   string
	}{
		{"keys and quotes", `{name: 'Ethan', age: 27}`, `{"name":"Ethan","age":27}`},
		{"missing comma", "{\"name\":\"Ethan\"\n\"age\":27}", `{"name":"Ethan","age":27}`},
		{"constants", `{"age": undefined, "on": True, "off": FALSE, "v": NONE}`, `{"age":null,"on":true,"off":false,"v":null}`},
		{"adjacent roots", `{}{}{}`, `[{},{},{}]`},
		{"operators", `{"name" = "Ethan"; "age" = 27;}`, `{"name":"Ethan","age":27}`},
		{"brackets", `{"users":[{"name":"Tom"],{"name":"Jerry"}]}`, `{"users":[{"name":"Tom"},{"name":"Jerry"}]}`},
		{"numbers", `{"plus": +123, "hex": 0xFF, "zero": 00123}`, `{"plus":123,"hex":255,"zero":123}`},
		{"invalid escapes", `{"a":"\x20","b":"\v"}`, `{"a":"x20","b":"v"}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := service.RepairJSON(test.source)
			if result.Error != "" {
				t.Fatalf("RepairJSON error: %s", result.Error)
			}
			var got, want any
			if err := json.Unmarshal([]byte(result.Text), &got); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(test.want), &want); err != nil {
				t.Fatal(err)
			}
			if !jsonValuesEqual(got, want) {
				t.Fatalf("got %s, want %s", result.Text, test.want)
			}
		})
	}
}

func jsonValuesEqual(left, right any) bool {
	leftJSON, _ := json.Marshal(left)
	rightJSON, _ := json.Marshal(right)
	return string(leftJSON) == string(rightJSON)
}

func TestEvaluateJSONPath(t *testing.T) {
	service := NewJSONPipelineService()
	wildcard := service.EvaluateJSONPath(`[{"result":{"id":1}},{"result":{"id":2}}]`, `$[*].result`)
	if wildcard.Error != nil || wildcard.Text != "[\n  {\n    \"id\": 1\n  },\n  {\n    \"id\": 2\n  }\n]" {
		t.Fatalf("unexpected wildcard result: %#v", wildcard)
	}
	preserved := service.EvaluateJSONPath(`{"result": { "id": 1 }}`, `$.result`)
	if preserved.Error != nil || preserved.Text != `{ "id": 1 }` {
		t.Fatalf("unexpected preserved result: %#v", preserved)
	}
}

func TestQueryJSONPathCompletionAfterWildcard(t *testing.T) {
	service := NewJSONPipelineService()
	rootResponse := service.QueryJSONPathCompletion(JSONPathCompletionRequest{
		Source: `[{"result":{"device_id":"a"}},{"result":{"dev_eui":"c"}}]`,
		Prefix: `$[*].`,
		Limit:  100,
	})
	rootLabels := make(map[string]bool, len(rootResponse.Items))
	for _, item := range rootResponse.Items {
		rootLabels[item.Label] = true
		if strings.HasPrefix(item.Label, "[*].") {
			t.Fatalf("wildcard was repeated after separator: %#v", rootResponse.Items)
		}
	}
	for _, label := range []string{"result"} {
		if !rootLabels[label] {
			t.Fatalf("missing root completion %q: %#v", label, rootResponse.Items)
		}
	}

	response := service.QueryJSONPathCompletion(JSONPathCompletionRequest{
		Source: `[{"result":{"device_id":"a","application_ids":{"application_id":"b"}}},{"result":{"dev_eui":"c"}}]`,
		Prefix: `$[*].result.`,
		Limit:  100,
	})
	labels := make(map[string]bool, len(response.Items))
	for _, item := range response.Items {
		labels[item.Label] = true
	}
	for _, label := range []string{"device_id", "application_ids", "dev_eui"} {
		if !labels[label] {
			t.Fatalf("missing completion %q: %#v", label, response.Items)
		}
	}
}

func TestLargeAdjacentJSONRepairAndSchemaEvaluation(t *testing.T) {
	service := NewJSONPipelineService()
	source := strings.Repeat(`{"result":{"id":1}}`, 701)
	repaired := service.RepairJSON(source)
	if repaired.Error != "" || !repaired.Changed {
		t.Fatalf("unexpected repair result: %#v", repaired)
	}
	result := service.EvaluateJSONPath(repaired.Text, `$[*].result`)
	if result.Error != nil {
		t.Fatalf("unexpected schema error: %#v", result.Error)
	}
	value, err := ParseJSONLoose(result.Text)
	if err != nil {
		t.Fatal(err)
	}
	if !value.IsArray() || len(value.Arr) != 701 {
		t.Fatalf("unexpected schema item count: %d", len(value.Arr))
	}
}

func TestJSONInspectionAndTransforms(t *testing.T) {
	service := NewJSONPipelineService()
	inspection := service.InspectJSON(`{
  // name
  "type": "object",
  "properties": {}
}`)
	if !inspection.Valid || !inspection.IsSchema || !inspection.HasComment {
		t.Fatalf("unexpected inspection: %#v", inspection)
	}
	if inspection.Text != `{"type":"object","properties":{}}` {
		t.Fatalf("unexpected inspection text: %s", inspection.Text)
	}

	formatted := service.TransformJSON(JSONTransformRequest{Source: `{"name":"Ethan"}`, Operation: "format"})
	if formatted.Error != "" || !formatted.Changed || formatted.Text != "{\n  \"name\": \"Ethan\"\n}" {
		t.Fatalf("unexpected formatted result: %#v", formatted)
	}
	unchanged := service.TransformJSON(JSONTransformRequest{
		Source:    "{\n  \"name\": \"Ethan\"\n}",
		Operation: "format",
	})
	if unchanged.Error != "" || unchanged.Changed {
		t.Fatalf("unexpected unchanged result: %#v", unchanged)
	}
	minified := service.TransformJSON(JSONTransformRequest{
		Source:        "{\n // comment\n \"name\": \"Ethan\"\n}",
		Operation:     "minify",
		StripComments: true,
	})
	if minified.Error != "" || minified.Text != `{"name":"Ethan"}` {
		t.Fatalf("unexpected minified result: %#v", minified)
	}
	auto := service.TransformJSON(JSONTransformRequest{
		Source:    "{\n // comment\n \"name\": \"Ethan\"\n}",
		Operation: "autoFormat",
	})
	if auto.Error != "" || !strings.Contains(auto.Text, "// comment") {
		t.Fatalf("unexpected auto format result: %#v", auto)
	}
	autoNumber := service.TransformJSON(JSONTransformRequest{Source: `{"value":1e3}`, Operation: "autoFormat"})
	if autoNumber.Error != "" || !strings.Contains(autoNumber.Text, `"value": 1000`) {
		t.Fatalf("unexpected auto format number result: %#v", autoNumber)
	}
	if !service.ValidateJSON(`{"name":"Ethan"}`).Valid || service.ValidateJSON(`{"name":}`).Valid {
		t.Fatal("unexpected validation result")
	}
}

func TestConvertJSON(t *testing.T) {
	service := NewJSONPipelineService()
	source := `{"name":"Ethan","items":[1,true,null]}`
	tests := []struct {
		format string
		want   string
	}{
		{"yaml", "\"name\": \"Ethan\"\n\"items\":\n  - 1\n  - true\n  - null\n"},
		{"xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<root>\n  <name>Ethan</name>\n  <items>1</items>\n  <items>true</items>\n  <items nil=\"true\" />\n</root>\n"},
		{"toml", "name = \"Ethan\"\nitems = [1, true]\n"},
		{"csv", "name,items\r\nEthan,\"[1,true,null]\"\r\n"},
	}
	for _, test := range tests {
		t.Run(test.format, func(t *testing.T) {
			input := source
			if test.format == "toml" {
				input = `{"name":"Ethan","items":[1,true]}`
			}
			result := service.ConvertJSON(JSONConvertRequest{Source: input, Format: test.format})
			if result.Error != nil || result.Text != test.want {
				t.Fatalf("unexpected conversion: %#v want %q", result, test.want)
			}
		})
	}
	if result := service.ConvertJSON(JSONConvertRequest{Source: `{"id":9007199254740992}`, Format: "csv"}); result.Error == nil || result.Error.Code != "unsafeInteger" {
		t.Fatalf("expected unsafe integer error: %#v", result)
	}
	if result := service.ConvertJSON(JSONConvertRequest{Source: "{\"id\":1 // comment\n}", Format: "csv"}); result.Error == nil || result.Error.Code != "jsonComments" {
		t.Fatalf("expected comment error: %#v", result)
	}
}
