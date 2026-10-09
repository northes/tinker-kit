package main

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	jsonrepair "github.com/wokito/jsonrepair-go"
)

type JSONRepairResult struct {
	Text       string `json:"text"`
	Changed    bool   `json:"changed"`
	Lines      int    `json:"lines"`
	Characters int    `json:"characters"`
	Bytes      int    `json:"bytes"`
	Error      string `json:"error,omitempty"`
}

type JSONPathError struct {
	Code   string            `json:"code"`
	Params map[string]string `json:"params,omitempty"`
}

type JSONPathResult struct {
	Text  string         `json:"text"`
	Error *JSONPathError `json:"error,omitempty"`
}

type JSONPathCompletionRequest struct {
	Source string `json:"source"`
	Prefix string `json:"prefix"`
	Limit  int    `json:"limit"`
}

var (
	repairNumberPattern = regexp.MustCompile(`^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)`)
	repairWordPattern   = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*`)
	repairConstants     = map[string]string{
		"True": "true", "TRUE": "true", "False": "false", "FALSE": "false",
		"None": "null", "NONE": "null", "NULL": "null", "undefined": "null", "UNDEFINED": "null",
	}
)

func repairNumberBoundary(source string, index int) bool {
	if index >= len(source) {
		return true
	}
	if strings.ContainsRune(" \t\r\n{}[],:", rune(source[index])) {
		return true
	}
	return source[index] == '/' && index+1 < len(source) && (source[index+1] == '/' || source[index+1] == '*')
}

func normalizeRepairNumber(raw string) string {
	sign := ""
	value := raw
	if value[0] == '+' || value[0] == '-' {
		sign, value = value[:1], value[1:]
	}
	if strings.HasPrefix(value, "0x") || strings.HasPrefix(value, "0X") {
		parsed, err := strconv.ParseUint(value[2:], 16, 64)
		if err == nil {
			if sign == "-" {
				return "-" + strconv.FormatUint(parsed, 10)
			}
			return strconv.FormatUint(parsed, 10)
		}
	}
	if sign == "+" {
		sign = ""
	}
	for len(value) > 1 && value[0] == '0' && value[1] >= '0' && value[1] <= '9' {
		value = value[1:]
	}
	return sign + value
}

func copyRepairString(source string, start int) (string, int) {
	quote := source[start]
	index := start + 1
	for index < len(source) {
		switch source[index] {
		case '\\':
			index += 2
		case quote:
			index++
			return source[start:index], index
		case '\n', '\r':
			return source[start:index], index
		default:
			index++
		}
	}
	return source[start:index], index
}

func normalizeJSONRepairSyntax(source string) string {
	var output strings.Builder
	output.Grow(len(source))
	stack := []byte{}
	completedRoot := false
	for index := 0; index < len(source); {
		char := source[index]
		if char == '"' || char == '\'' {
			text, next := copyRepairString(source, index)
			output.WriteString(text)
			index = next
			continue
		}
		if char == '/' && index+1 < len(source) && source[index+1] == '/' {
			end := strings.IndexByte(source[index+2:], '\n')
			if end < 0 {
				output.WriteString(source[index:])
				break
			}
			end += index + 2
			output.WriteString(source[index:end])
			index = end
			continue
		}
		if char == '/' && index+1 < len(source) && source[index+1] == '*' {
			end := strings.Index(source[index+2:], "*/")
			if end < 0 {
				output.WriteString(source[index:])
				break
			}
			end += index + 4
			output.WriteString(source[index:end])
			index = end
			continue
		}
		if char == '{' || char == '[' {
			if len(stack) == 0 && completedRoot {
				output.WriteByte('\n')
			}
			if char == '{' {
				stack = append(stack, '}')
			} else {
				stack = append(stack, ']')
			}
			completedRoot = false
			output.WriteByte(char)
			index++
			continue
		}
		if char == '}' || char == ']' {
			if len(stack) > 0 {
				expected := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				output.WriteByte(expected)
			} else {
				output.WriteByte(char)
			}
			completedRoot = len(stack) == 0
			index++
			continue
		}
		if char == '=' && (index == 0 || source[index-1] != '=') && (index+1 >= len(source) || source[index+1] != '=') {
			output.WriteByte(':')
			index++
			continue
		}
		if char == ';' {
			output.WriteByte(',')
			index++
			continue
		}
		if (char >= '0' && char <= '9') || ((char == '+' || char == '-') && index+1 < len(source) && source[index+1] >= '0' && source[index+1] <= '9') {
			match := repairNumberPattern.FindString(source[index:])
			if match != "" && repairNumberBoundary(source, index+len(match)) {
				output.WriteString(normalizeRepairNumber(match))
				index += len(match)
				continue
			}
		}
		if word := repairWordPattern.FindString(source[index:]); word != "" {
			if replacement, ok := repairConstants[word]; ok {
				output.WriteString(replacement)
			} else {
				output.WriteString(word)
			}
			index += len(word)
			continue
		}
		output.WriteByte(char)
		index++
	}
	return output.String()
}

func jsonRepairResult(text string, changed bool) JSONRepairResult {
	return JSONRepairResult{
		Text: text, Changed: changed, Lines: strings.Count(text, "\n") + 1,
		Characters: utf8.RuneCountInString(text), Bytes: len(text),
	}
}

// RepairJSON 在 Go 后端完成修复与格式化，避免大文本占用 WebView 主线程。
func (s *JSONPipelineService) RepairJSON(source string) JSONRepairResult {
	if strings.TrimSpace(source) == "" {
		return JSONRepairResult{Error: "empty"}
	}
	if json.Valid([]byte(source)) {
		value, err := ParseJSONLoose(source)
		if err != nil {
			return JSONRepairResult{Error: "unrepairable"}
		}
		return jsonRepairResult(StringifyJSON(value, "  "), false)
	}
	repaired, err := jsonrepair.JSONRepair(normalizeJSONRepairSyntax(source))
	if err != nil || !json.Valid([]byte(repaired)) {
		return JSONRepairResult{Error: "unrepairable"}
	}
	value, err := ParseJSONLoose(repaired)
	if err != nil {
		return JSONRepairResult{Error: "unrepairable"}
	}
	return jsonRepairResult(StringifyJSON(value, "  "), true)
}

type jsonSourceNode struct {
	start, end int
	object     map[string]*jsonSourceNode
	array      []*jsonSourceNode
}

type jsonSourceParser struct {
	source string
	pos    int
}

func (p *jsonSourceParser) skip() error {
	for p.pos < len(p.source) {
		switch p.source[p.pos] {
		case ' ', '\t', '\r', '\n':
			p.pos++
		case '/':
			if p.pos+1 >= len(p.source) {
				return nil
			}
			if p.source[p.pos+1] == '/' {
				if end := strings.IndexByte(p.source[p.pos+2:], '\n'); end >= 0 {
					p.pos += end + 2
				} else {
					p.pos = len(p.source)
				}
			} else if p.source[p.pos+1] == '*' {
				end := strings.Index(p.source[p.pos+2:], "*/")
				if end < 0 {
					return &pathParseError{code: "unclosedComment"}
				}
				p.pos += end + 4
			} else {
				return nil
			}
		default:
			return nil
		}
	}
	return nil
}

func (p *jsonSourceParser) stringEnd() (int, error) {
	start := p.pos
	p.pos++
	for p.pos < len(p.source) {
		if p.source[p.pos] == '\\' {
			p.pos += 2
		} else if p.source[p.pos] == '"' {
			p.pos++
			return p.pos, nil
		} else {
			p.pos++
		}
	}
	p.pos = start
	return 0, &pathParseError{code: "unclosedString"}
}

func (p *jsonSourceParser) value() (*jsonSourceNode, error) {
	if err := p.skip(); err != nil {
		return nil, err
	}
	node := &jsonSourceNode{start: p.pos}
	if p.pos >= len(p.source) {
		return nil, &pathParseError{code: "unclosedNode"}
	}
	if p.source[p.pos] == '{' {
		node.object = map[string]*jsonSourceNode{}
		p.pos++
		for {
			if err := p.skip(); err != nil {
				return nil, err
			}
			if p.pos < len(p.source) && p.source[p.pos] == '}' {
				p.pos++
				node.end = p.pos
				return node, nil
			}
			if p.pos >= len(p.source) || p.source[p.pos] != '"' {
				return nil, &pathParseError{code: "invalidObjectKey"}
			}
			keyStart := p.pos
			keyEnd, err := p.stringEnd()
			if err != nil {
				return nil, err
			}
			var key string
			if json.Unmarshal([]byte(p.source[keyStart:keyEnd]), &key) != nil {
				return nil, &pathParseError{code: "invalidObjectKey"}
			}
			if err := p.skip(); err != nil {
				return nil, err
			}
			if p.pos >= len(p.source) || p.source[p.pos] != ':' {
				return nil, &pathParseError{code: "missingColon"}
			}
			p.pos++
			child, err := p.value()
			if err != nil {
				return nil, err
			}
			node.object[key] = child
			if err := p.skip(); err != nil {
				return nil, err
			}
			if p.pos < len(p.source) && p.source[p.pos] == ',' {
				p.pos++
			}
		}
	}
	if p.source[p.pos] == '[' {
		node.array = []*jsonSourceNode{}
		p.pos++
		for {
			if err := p.skip(); err != nil {
				return nil, err
			}
			if p.pos < len(p.source) && p.source[p.pos] == ']' {
				p.pos++
				node.end = p.pos
				return node, nil
			}
			child, err := p.value()
			if err != nil {
				return nil, err
			}
			node.array = append(node.array, child)
			if err := p.skip(); err != nil {
				return nil, err
			}
			if p.pos < len(p.source) && p.source[p.pos] == ',' {
				p.pos++
			}
		}
	}
	if p.source[p.pos] == '"' {
		end, err := p.stringEnd()
		if err != nil {
			return nil, err
		}
		node.end = end
		return node, nil
	}
	for p.pos < len(p.source) && !strings.ContainsRune(" \t\r\n,}]", rune(p.source[p.pos])) {
		p.pos++
	}
	node.end = p.pos
	return node, nil
}

func jsonPathFailure(code string, params map[string]string) JSONPathResult {
	return JSONPathResult{Error: &JSONPathError{Code: code, Params: params}}
}

// EvaluateJSONPath 在 Go 后端解析路径；无通配符时保留原始源码片段。
func (s *JSONPipelineService) EvaluateJSONPath(source, path string) JSONPathResult {
	root, err := ParseJSONLoose(source)
	if err != nil {
		return jsonPathFailure("pathNotFound", nil)
	}
	tokens, err := parsePipelinePath(path)
	if err != nil {
		if pathErr, ok := err.(*pathParseError); ok {
			switch pathErr.code {
			case "missingBracket":
				return jsonPathFailure("pathMissingBracket", nil)
			case "invalidSegment":
				return jsonPathFailure("pathInvalidSegment", nil)
			default:
				return jsonPathFailure("pathInvalidChar", nil)
			}
		}
		return jsonPathFailure("pathNotFound", nil)
	}
	current := root
	hasWildcard := false
	for _, token := range tokens {
		if token.Type == pathTokenAll {
			hasWildcard = true
			break
		}
		switch token.Type {
		case pathTokenIndex:
			if !current.IsArray() {
				return jsonPathFailure("notArray", nil)
			}
			index, _ := strconv.Atoi(token.Value)
			if index < 0 || index >= len(current.Arr) {
				return jsonPathFailure("indexOutOfRange", nil)
			}
			current = current.Arr[index]
		case pathTokenKey:
			if !current.IsObject() {
				return jsonPathFailure("noKeyAt", map[string]string{"key": token.Value})
			}
			next, ok := current.member(token.Value)
			if !ok {
				return jsonPathFailure("keyNotFound", map[string]string{"key": token.Value})
			}
			current = next
		}
	}
	if hasWildcard {
		matched, readErr := readTokens(root, tokens, 0)
		if readErr != nil {
			return jsonPathFailure("pathNotFound", nil)
		}
		return JSONPathResult{Text: StringifyJSON(matched, "  ")}
	}
	parser := &jsonSourceParser{source: source}
	node, err := parser.value()
	if err != nil {
		return jsonPathFailure("pathNotFound", nil)
	}
	for _, token := range tokens {
		if token.Type == pathTokenIndex {
			index, _ := strconv.Atoi(token.Value)
			if node.array == nil {
				return jsonPathFailure("notArray", nil)
			}
			if index < 0 || index >= len(node.array) {
				return jsonPathFailure("pathNotFound", nil)
			}
			node = node.array[index]
		} else {
			if node.object == nil {
				return jsonPathFailure("noKeyAt", map[string]string{"key": token.Value})
			}
			next := node.object[token.Value]
			if next == nil {
				return jsonPathFailure("pathNotFound", nil)
			}
			node = next
		}
	}
	return JSONPathResult{Text: source[node.start:node.end]}
}

// QueryJSONPathCompletion 在 Go 后端解析 Schema 路径并生成候选，避免前端为补全再次解析完整文档。
func (s *JSONPipelineService) QueryJSONPathCompletion(req JSONPathCompletionRequest) PipelineCompletionResponse {
	response := PipelineCompletionResponse{Items: []CompletionOption{}}
	root, err := ParseJSONLoose(req.Source)
	if err != nil {
		return response
	}
	split := splitCompletionPath(req.Prefix)
	node := resolveCompletionNode(root, split)
	options := completionOptionsForNode(node, split)
	limit := req.Limit
	if limit <= 0 || limit > jsonPipelineCompletionLimit {
		limit = jsonPipelineCompletionLimit
	}
	if len(options) > limit {
		options = options[:limit]
	}
	response.Items = options
	return response
}
