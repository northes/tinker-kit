package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// JSONInspectionResult 是前端输入预览所需的轻量状态。大文本只在 Go 中解析，
// 前端仅在用户明确打开表格/Schema 预览时使用返回的标准 JSON 文本。
type JSONInspectionResult struct {
	Valid      bool   `json:"valid"`
	IsSchema   bool   `json:"isSchema"`
	HasComment bool   `json:"hasComment"`
	Text       string `json:"text,omitempty"`
}

type JSONTransformRequest struct {
	Source        string `json:"source"`
	Operation     string `json:"operation"` // format, minify, autoFormat, validate
	StripComments bool   `json:"stripComments"`
}

type JSONTransformResult struct {
	Text       string `json:"text"`
	Valid      bool   `json:"valid"`
	Changed    bool   `json:"changed"`
	Error      string `json:"error,omitempty"`
	Lines      int    `json:"lines"`
	Characters int    `json:"characters"`
	Bytes      int    `json:"bytes"`
}

type JSONValidationResult struct {
	Valid bool `json:"valid"`
}

type JSONConvertRequest struct {
	Source string `json:"source"`
	Format string `json:"format"`
}

type JSONConvertError struct {
	Code   string            `json:"code"`
	Params map[string]string `json:"params,omitempty"`
}

type JSONConvertResult struct {
	Text  string            `json:"text"`
	Error *JSONConvertError `json:"error,omitempty"`
}

// InspectJSON 在 Go 中完成输入有效性和 Schema 形状判断，避免 React render/useMemo
// 对同一份大文本重复 JSON.parse。
func (s *JSONPipelineService) InspectJSON(source string) JSONInspectionResult {
	if strings.TrimSpace(source) == "" {
		return JSONInspectionResult{}
	}
	value, err := ParseJSONComments(source)
	if err != nil {
		return JSONInspectionResult{HasComment: jsonSourceHasComments(source)}
	}
	return JSONInspectionResult{
		Valid:      true,
		IsSchema:   isJSONSchemaValue(value),
		HasComment: jsonSourceHasComments(source),
		Text:       StringifyJSON(value, ""),
	}
}

// ValidateJSON 保留“验证”动作的严格 JSON 语义，不接受注释和尾逗号。
func (s *JSONPipelineService) ValidateJSON(source string) JSONValidationResult {
	if strings.TrimSpace(source) == "" {
		return JSONValidationResult{}
	}
	_, err := ParseJSONStrict(source)
	return JSONValidationResult{Valid: err == nil}
}

// TransformJSON 将格式化、压缩和粘贴/填充自动格式化统一放到 Go 后端。
func (s *JSONPipelineService) TransformJSON(req JSONTransformRequest) JSONTransformResult {
	source := req.Source
	if strings.TrimSpace(source) == "" {
		return JSONTransformResult{Error: "invalid"}
	}
	if req.Operation == "validate" {
		valid := s.ValidateJSON(source).Valid
		return JSONTransformResult{Valid: valid, Error: ternaryString(valid, "", "invalid")}
	}

	var text string
	var err error
	if (req.Operation == "format" || req.Operation == "autoFormat") && !req.StripComments && jsonSourceHasComments(source) {
		text = formatJSONPreserveComments(source)
		_, err = ParseJSONComments(text)
	} else {
		var value *JSONValue
		if req.StripComments {
			value, err = ParseJSONComments(source)
		} else {
			value, err = ParseJSONStrict(source)
		}
		if err == nil {
			if req.Operation == "minify" {
				text = StringifyJSON(value, "")
			} else {
				text = StringifyJSON(value, "  ")
			}
		}
	}
	if err != nil {
		return JSONTransformResult{Error: "invalid"}
	}
	return jsonTransformResult(text, text != source)
}

func jsonTransformResult(text string, changed bool) JSONTransformResult {
	return JSONTransformResult{
		Text: text, Valid: true, Changed: changed,
		Lines:      strings.Count(text, "\n") + 1,
		Characters: len([]rune(text)), Bytes: len([]byte(text)),
	}
}

func ternaryString(condition bool, yes, no string) string {
	if condition {
		return yes
	}
	return no
}

func jsonSourceHasComments(source string) bool {
	inString := false
	escaped := false
	for index := 0; index < len(source); index++ {
		char := source[index]
		if inString {
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				inString = false
			}
			continue
		}
		if char == '"' {
			inString = true
			continue
		}
		if char == '/' && index+1 < len(source) && (source[index+1] == '/' || source[index+1] == '*') {
			return true
		}
	}
	return false
}

type jsonFormatToken struct {
	kind      string
	value     string
	lineStart bool
}

// formatJSONPreserveComments 在后端保留 JSONC 注释并重排缩进。
func formatJSONPreserveComments(source string) string {
	tokens := make([]jsonFormatToken, 0)
	lineStart := true
	for index := 0; index < len(source); {
		char := source[index]
		switch {
		case char == '"' || char == '\'':
			start := index
			quote := char
			index++
			for index < len(source) {
				if source[index] == '\\' {
					index += 2
					continue
				}
				index++
				if source[index-1] == quote {
					break
				}
			}
			tokens = append(tokens, jsonFormatToken{"str", source[start:index], lineStart})
			lineStart = false
		case char == '/' && index+1 < len(source) && source[index+1] == '/':
			start := index
			for index < len(source) && source[index] != '\n' {
				index++
			}
			tokens = append(tokens, jsonFormatToken{"line", source[start:index], lineStart})
			lineStart = false
		case char == '/' && index+1 < len(source) && source[index+1] == '*':
			start := index
			index += 2
			for index+1 < len(source) && !(source[index] == '*' && source[index+1] == '/') {
				index++
			}
			if index+1 < len(source) {
				index += 2
			}
			tokens = append(tokens, jsonFormatToken{"block", source[start:index], lineStart})
			lineStart = false
		case strings.ContainsRune("{}[],:", rune(char)):
			tokens = append(tokens, jsonFormatToken{string(char), string(char), lineStart})
			lineStart = false
			index++
		case char == ' ' || char == '\t' || char == '\r' || char == '\n':
			if char == '\n' {
				lineStart = true
			}
			index++
		default:
			start := index
			for index < len(source) && !strings.ContainsRune(" \t\r\n{}[]:,'\"/", rune(source[index])) {
				index++
			}
			tokens = append(tokens, jsonFormatToken{"v", source[start:index], lineStart})
			lineStart = false
		}
	}

	output := ""
	depth := 0
	lineStartOutput := true
	inValue := false
	indent := func() string { return strings.Repeat("  ", depth) }
	newline := func() {
		output += "\n" + indent()
		lineStartOutput = true
	}
	for index := 0; index < len(tokens); index++ {
		token := tokens[index]
		switch token.kind {
		case "{", "[":
			close := "}"
			if token.kind == "[" {
				close = "]"
			}
			if index+1 < len(tokens) && tokens[index+1].kind == close {
				if !lineStartOutput && !inValue {
					newline()
				}
				output += token.value + close
				lineStartOutput = false
				inValue = false
				index++
				continue
			}
			if !inValue && !lineStartOutput {
				newline()
			}
			output += token.value
			depth++
			newline()
			lineStartOutput = true
			inValue = false
		case "}", "]":
			if depth > 0 {
				depth--
			}
			output = strings.TrimRightFunc(output, unicode.IsSpace)
			newline()
			output += token.value
			lineStartOutput = false
			inValue = false
		case ":":
			output += ": "
			lineStartOutput = false
			inValue = true
		case ",":
			output += ","
			newline()
			inValue = false
		case "line", "block":
			if token.lineStart {
				if !lineStartOutput {
					newline()
				}
				output += token.value
				newline()
			} else {
				if !lineStartOutput {
					output += " "
				}
				output += token.value
				if token.kind == "line" {
					newline()
				}
			}
		case "str", "v":
			if !inValue && !lineStartOutput {
				newline()
			}
			output += token.value
			lineStartOutput = false
			inValue = false
		}
	}
	return output
}

var jsonSchemaStructuralKeys = map[string]bool{
	"$defs": true, "$ref": true, "additionalProperties": true, "allOf": true, "anyOf": true,
	"contains": true, "dependentRequired": true, "dependentSchemas": true, "definitions": true,
	"else": true, "if": true, "items": true, "not": true, "oneOf": true, "patternProperties": true,
	"prefixItems": true, "properties": true, "propertyNames": true, "required": true, "then": true,
	"unevaluatedItems": true, "unevaluatedProperties": true,
}
var jsonSchemaConstraintKeys = map[string]bool{
	"const": true, "enum": true, "exclusiveMaximum": true, "exclusiveMinimum": true, "format": true,
	"maximum": true, "maxItems": true, "maxLength": true, "maxProperties": true, "minimum": true,
	"minItems": true, "minLength": true, "minProperties": true, "multipleOf": true, "pattern": true,
	"uniqueItems": true,
}
var jsonSchemaTypeNames = map[string]bool{
	"array": true, "boolean": true, "integer": true, "null": true, "number": true, "object": true, "string": true,
}

func isJSONSchemaValue(value *JSONValue) bool {
	if !value.IsObject() {
		return false
	}
	keys := make([]string, 0, len(value.Obj))
	for _, member := range value.Obj {
		keys = append(keys, member.Key)
	}
	hasMarker := false
	hasStructural := false
	hasConstraint := false
	validType := false
	for _, key := range keys {
		if key == "$schema" || key == "$id" || key == "$ref" {
			hasMarker = true
		}
		if jsonSchemaStructuralKeys[key] {
			hasStructural = true
		}
		if jsonSchemaConstraintKeys[key] {
			hasConstraint = true
		}
	}
	if member, ok := value.member("type"); ok {
		if member.Kind == JSONString {
			validType = jsonSchemaTypeNames[member.Str]
		} else if member.IsArray() && len(member.Arr) > 0 {
			validType = true
			for _, item := range member.Arr {
				if item == nil || item.Kind != JSONString || !jsonSchemaTypeNames[item.Str] {
					validType = false
					break
				}
			}
		}
	}
	if hasMarker || hasStructural || hasConstraint {
		return true
	}
	if !validType {
		return false
	}
	for _, key := range keys {
		if key != "type" && !jsonSchemaStructuralKeys[key] && !jsonSchemaConstraintKeys[key] && key != "$comment" && key != "$id" && key != "$schema" && key != "default" && key != "description" && key != "examples" && key != "readOnly" && key != "title" && key != "writeOnly" {
			return false
		}
	}
	return true
}

var strictJSONNumberPattern = regexp.MustCompile(`^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?`)

func unsafeJSONIntegerLiteral(literal string) bool {
	unsigned := strings.TrimPrefix(literal, "-")
	exponentMarker := strings.IndexAny(unsigned, "eE")
	mantissa := unsigned
	exponentText := ""
	if exponentMarker >= 0 {
		mantissa = unsigned[:exponentMarker]
		exponentText = unsigned[exponentMarker+1:]
	}
	dot := strings.IndexByte(mantissa, '.')
	integerPart, fractionPart := mantissa, ""
	if dot >= 0 {
		integerPart, fractionPart = mantissa[:dot], mantissa[dot+1:]
	}
	digits := integerPart + fractionPart
	if strings.Trim(digits, "0") == "" {
		return false
	}
	exponent := 0
	if exponentText != "" {
		parsed, err := strconv.Atoi(exponentText)
		if err != nil {
			return !strings.HasPrefix(exponentText, "-")
		}
		exponent = parsed
	}
	scale := len(fractionPart) - exponent
	var integerDigits string
	if scale <= 0 {
		significant := strings.TrimLeft(digits, "0")
		if len(significant)-scale > 16 {
			return true
		}
		integerDigits = significant + strings.Repeat("0", -scale)
	} else {
		if scale >= len(digits) {
			return false
		}
		split := len(digits) - scale
		if strings.Trim(digits[split:], "0") != "" {
			return false
		}
		integerDigits = digits[:split]
	}
	integerDigits = strings.TrimLeft(integerDigits, "0")
	if integerDigits == "" {
		integerDigits = "0"
	}
	return len(integerDigits) > len("9007199254740991") ||
		(len(integerDigits) == len("9007199254740991") && integerDigits > "9007199254740991")
}

func validateJSONConversionSource(source string) (string, map[string]string) {
	if jsonSourceHasComments(source) {
		return "jsonComments", nil
	}
	for index := 0; index < len(source); index++ {
		if source[index] == '"' {
			index++
			for index < len(source) {
				if source[index] == '\\' {
					index += 2
					continue
				}
				if source[index] == '"' {
					break
				}
				index++
			}
			continue
		}
		if source[index] != '-' && (source[index] < '0' || source[index] > '9') {
			continue
		}
		match := strictJSONNumberPattern.FindString(source[index:])
		if match == "" {
			continue
		}
		boundary := index + len(match)
		if boundary < len(source) && !strings.ContainsRune(" \t\r\n,]}", rune(source[boundary])) {
			continue
		}
		if unsafeJSONIntegerLiteral(match) {
			return "unsafeInteger", nil
		}
		index += len(match) - 1
	}
	if _, err := ParseJSONStrict(source); err != nil {
		return "invalidJson", nil
	}
	return "", nil
}

func conversionError(code string, params map[string]string) JSONConvertResult {
	return JSONConvertResult{Error: &JSONConvertError{Code: code, Params: params}}
}

// ConvertJSON 在 Go 后端完成 JSON 到 YAML/XML/TOML/CSV 的转换。
func (s *JSONPipelineService) ConvertJSON(req JSONConvertRequest) JSONConvertResult {
	if req.Format != "yaml" && req.Format != "xml" && req.Format != "toml" && req.Format != "csv" {
		return conversionError("unsupportedFormat", nil)
	}
	if code, params := validateJSONConversionSource(req.Source); code != "" {
		return conversionError(code, params)
	}
	value, err := ParseJSONStrict(req.Source)
	if err != nil {
		return conversionError("invalidJson", nil)
	}
	var output string
	var convertErr *JSONConvertError
	switch req.Format {
	case "yaml":
		output, convertErr = jsonToYAML(value)
	case "xml":
		output, convertErr = jsonToXML(value)
	case "toml":
		output, convertErr = jsonToTOML(value)
	case "csv":
		output, convertErr = jsonToCSV(value)
	}
	if convertErr != nil {
		return JSONConvertResult{Error: convertErr}
	}
	return JSONConvertResult{Text: output}
}

func valueString(value *JSONValue) string {
	return StringifyJSON(value, "")
}

func yamlScalar(value *JSONValue) (string, *JSONConvertError) {
	if value == nil {
		return "null", nil
	}
	switch value.Kind {
	case JSONNull:
		return "null", nil
	case JSONBool, JSONNumber, JSONString:
		return valueString(value), nil
	default:
		return "", &JSONConvertError{Code: "unsupportedType"}
	}
}

func isEmptyJSONCollection(value *JSONValue) bool {
	return value != nil && ((value.IsArray() && len(value.Arr) == 0) || (value.IsObject() && len(value.Obj) == 0))
}

func yamlLines(value *JSONValue, depth int) ([]string, *JSONConvertError) {
	pad := strings.Repeat("  ", depth)
	if value == nil || value.IsScalar() {
		item, err := yamlScalar(value)
		if err != nil {
			return nil, err
		}
		return []string{pad + item}, nil
	}
	if value.IsArray() {
		if len(value.Arr) == 0 {
			return []string{pad + "[]"}, nil
		}
		lines := []string{}
		for _, item := range value.Arr {
			if item != nil && (item.IsArray() || item.IsObject()) && !isEmptyJSONCollection(item) {
				nested, err := yamlLines(item, depth+1)
				if err != nil {
					return nil, err
				}
				lines = append(lines, pad+"- "+strings.TrimLeft(nested[0], " \t"))
				lines = append(lines, nested[1:]...)
				continue
			}
			if item != nil && (item.IsArray() || item.IsObject()) {
				literal := "{}"
				if item.IsArray() {
					literal = "[]"
				}
				lines = append(lines, pad+"- "+literal)
				continue
			}
			itemText, err := yamlScalar(item)
			if err != nil {
				return nil, err
			}
			lines = append(lines, pad+"- "+itemText)
		}
		return lines, nil
	}
	if len(value.Obj) == 0 {
		return []string{pad + "{}"}, nil
	}
	lines := []string{}
	for _, member := range value.Obj {
		child := member.Value
		key := valueString(newJSONString(member.Key))
		if child != nil && (child.IsArray() || child.IsObject()) && !isEmptyJSONCollection(child) {
			nested, err := yamlLines(child, depth+1)
			if err != nil {
				return nil, err
			}
			lines = append(lines, pad+key+":")
			lines = append(lines, nested...)
		} else if child != nil && (child.IsArray() || child.IsObject()) {
			literal := "{}"
			if child.IsArray() {
				literal = "[]"
			}
			lines = append(lines, pad+key+": "+literal)
		} else {
			item, err := yamlScalar(child)
			if err != nil {
				return nil, err
			}
			lines = append(lines, pad+key+": "+item)
		}
	}
	return lines, nil
}

func jsonToYAML(value *JSONValue) (string, *JSONConvertError) {
	lines, err := yamlLines(value, 0)
	if err != nil {
		return "", err
	}
	return strings.Join(lines, "\n") + "\n", nil
}

func tomlBareKey(key string) bool {
	if key == "" {
		return false
	}
	for _, r := range key {
		if !(r == '_' || r == '-' || r >= '0' && r <= '9' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z') {
			return false
		}
	}
	return true
}

func tomlBasicString(value string) string {
	var output strings.Builder
	output.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			output.WriteString(`\"`)
		case '\\':
			output.WriteString(`\\`)
		case '\b':
			output.WriteString(`\b`)
		case '\t':
			output.WriteString(`\t`)
		case '\n':
			output.WriteString(`\n`)
		case '\f':
			output.WriteString(`\f`)
		case '\r':
			output.WriteString(`\r`)
		default:
			if r < 0x20 || r == 0x7f || (r >= 0xd800 && r <= 0xdfff) {
				output.WriteString(fmt.Sprintf(`\u%04x`, r))
			} else {
				output.WriteRune(r)
			}
		}
	}
	output.WriteByte('"')
	return output.String()
}

func tomlKey(key string) string {
	if tomlBareKey(key) {
		return key
	}
	return tomlBasicString(key)
}

func tomlScalar(value *JSONValue) (string, *JSONConvertError) {
	if value == nil {
		return "", &JSONConvertError{Code: "unsupportedType"}
	}
	switch value.Kind {
	case JSONString:
		return tomlBasicString(value.Str), nil
	case JSONBool, JSONNumber:
		return valueString(value), nil
	default:
		return "", &JSONConvertError{Code: "unsupportedType"}
	}
}

func tomlValue(value *JSONValue) (string, *JSONConvertError) {
	if value == nil || value.Kind == JSONNull {
		return "", &JSONConvertError{Code: "tomlNull"}
	}
	if value.IsArray() {
		parts := make([]string, 0, len(value.Arr))
		for _, item := range value.Arr {
			text, err := tomlValue(item)
			if err != nil {
				return "", err
			}
			parts = append(parts, text)
		}
		return "[" + strings.Join(parts, ", ") + "]", nil
	}
	if value.IsObject() {
		parts := make([]string, 0, len(value.Obj))
		for _, member := range value.Obj {
			text, err := tomlValue(member.Value)
			if err != nil {
				return "", err
			}
			parts = append(parts, tomlKey(member.Key)+" = "+text)
		}
		return "{ " + strings.Join(parts, ", ") + " }", nil
	}
	return tomlScalar(value)
}

func jsonToTOML(value *JSONValue) (string, *JSONConvertError) {
	if !value.IsObject() {
		return "", &JSONConvertError{Code: "tomlRoot"}
	}
	lines := make([]string, 0, len(value.Obj))
	for _, member := range value.Obj {
		text, err := tomlValue(member.Value)
		if err != nil {
			return "", err
		}
		lines = append(lines, tomlKey(member.Key)+" = "+text)
	}
	if len(lines) == 0 {
		return "", nil
	}
	return strings.Join(lines, "\n") + "\n", nil
}

func isXMLNameStart(r rune) bool {
	return r == '_' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' ||
		r >= 0xc0 && r <= 0xd6 || r >= 0xd8 && r <= 0xf6 || r >= 0xf8 && r <= 0x2ff ||
		r >= 0x370 && r <= 0x37d || r >= 0x37f && r <= 0x1fff || r >= 0x200c && r <= 0x200d ||
		r >= 0x2070 && r <= 0x218f || r >= 0x2c00 && r <= 0x2fef || r >= 0x3001 && r <= 0xd7ff ||
		r >= 0xf900 && r <= 0xfdcf || r >= 0xfdf0 && r <= 0xfffd || r >= 0x10000 && r <= 0xeffff
}

func isXMLNameChar(r rune) bool {
	return isXMLNameStart(r) || r == '-' || r == '.' || r == 0xb7 || r >= '0' && r <= '9' || r >= 0x300 && r <= 0x36f || r >= 0x203f && r <= 0x2040
}

func xmlName(key string) (string, *JSONConvertError) {
	if key == "" || strings.ContainsRune(key, ':') {
		return "", &JSONConvertError{Code: "xmlInvalidName", Params: map[string]string{"key": key}}
	}
	for index, r := range key {
		if (index == 0 && !isXMLNameStart(r)) || (index > 0 && !isXMLNameChar(r)) {
			return "", &JSONConvertError{Code: "xmlInvalidName", Params: map[string]string{"key": key}}
		}
	}
	return key, nil
}

func isXMLCharacter(r rune) bool {
	return r == 0x9 || r == 0xa || r == 0xd || r >= 0x20 && r <= 0xd7ff || r >= 0xe000 && r <= 0xfffd || r >= 0x10000 && r <= 0x10ffff
}

func xmlText(value string) (string, *JSONConvertError) {
	for _, r := range value {
		if !isXMLCharacter(r) {
			return "", &JSONConvertError{Code: "xmlInvalidCharacter", Params: map[string]string{"codePoint": fmt.Sprintf("U+%X", r)}}
		}
	}
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(value), nil
}

func xmlScalar(value *JSONValue) (string, *JSONConvertError) {
	if value == nil {
		return "", &JSONConvertError{Code: "unsupportedType"}
	}
	switch value.Kind {
	case JSONString:
		return xmlText(value.Str)
	case JSONBool, JSONNumber:
		return valueString(value), nil
	default:
		return "", &JSONConvertError{Code: "unsupportedType"}
	}
}

func xmlNode(value *JSONValue, key string, depth int) (string, *JSONConvertError) {
	name, err := xmlName(key)
	if err != nil {
		return "", err
	}
	pad := strings.Repeat("  ", depth)
	if value == nil || value.Kind == JSONNull {
		return pad + "<" + name + ` nil="true" />`, nil
	}
	if value.IsArray() {
		if len(value.Arr) == 0 {
			return pad + "<" + name + " />", nil
		}
		parts := make([]string, 0, len(value.Arr))
		for _, item := range value.Arr {
			text, err := xmlNode(item, key, depth)
			if err != nil {
				return "", err
			}
			parts = append(parts, text)
		}
		return strings.Join(parts, "\n"), nil
	}
	if value.IsObject() {
		if len(value.Obj) == 0 {
			return pad + "<" + name + " />", nil
		}
		children := make([]string, 0, len(value.Obj))
		for _, member := range value.Obj {
			text, err := xmlNode(member.Value, member.Key, depth+1)
			if err != nil {
				return "", err
			}
			children = append(children, text)
		}
		return pad + "<" + name + ">\n" + strings.Join(children, "\n") + "\n" + pad + "</" + name + ">", nil
	}
	text, err := xmlScalar(value)
	if err != nil {
		return "", err
	}
	return pad + "<" + name + ">" + text + "</" + name + ">", nil
}

func jsonToXML(value *JSONValue) (string, *JSONConvertError) {
	const header = `<?xml version="1.0" encoding="UTF-8"?>`
	if value == nil || value.Kind == JSONNull {
		return header + "\n<root nil=\"true\" />\n", nil
	}
	if value.IsScalar() {
		text, err := xmlScalar(value)
		if err != nil {
			return "", err
		}
		return header + "\n<root>" + text + "</root>\n", nil
	}
	if value.IsArray() {
		if len(value.Arr) == 0 {
			return header + "\n<root />\n", nil
		}
		children := make([]string, 0, len(value.Arr))
		for _, item := range value.Arr {
			text, err := xmlNode(item, "item", 1)
			if err != nil {
				return "", err
			}
			children = append(children, text)
		}
		return header + "\n<root>\n" + strings.Join(children, "\n") + "\n</root>\n", nil
	}
	if len(value.Obj) == 0 {
		return header + "\n<root />\n", nil
	}
	children := make([]string, 0, len(value.Obj))
	for _, member := range value.Obj {
		text, err := xmlNode(member.Value, member.Key, 1)
		if err != nil {
			return "", err
		}
		children = append(children, text)
	}
	return header + "\n<root>\n" + strings.Join(children, "\n") + "\n</root>\n", nil
}

func csvEscape(value string) string {
	if strings.ContainsAny(value, "\",\r\n") {
		return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
	}
	return value
}

func csvCell(value *JSONValue) (string, *JSONConvertError) {
	if value == nil || value.Kind == JSONNull {
		return "", nil
	}
	if value.IsArray() || value.IsObject() {
		return csvEscape(valueString(value)), nil
	}
	if value.Kind == JSONString {
		return csvEscape(value.Str), nil
	}
	if value.Kind == JSONBool || value.Kind == JSONNumber {
		return valueString(value), nil
	}
	return "", &JSONConvertError{Code: "unsupportedType"}
}

func jsonToCSV(value *JSONValue) (string, *JSONConvertError) {
	if value == nil || value.IsScalar() {
		cell, err := csvCell(value)
		if err != nil {
			return "", err
		}
		return cell + "\r\n", nil
	}
	if value.IsObject() {
		if len(value.Obj) == 0 {
			return "\r\n", nil
		}
		keys := make([]string, 0, len(value.Obj))
		for _, member := range value.Obj {
			keys = append(keys, member.Key)
		}
		cells := make([]string, 0, len(keys))
		for _, key := range keys {
			cells = append(cells, csvEscape(key))
		}
		values := make([]string, 0, len(keys))
		for _, key := range keys {
			member, _ := value.member(key)
			cell, err := csvCell(member)
			if err != nil {
				return "", err
			}
			values = append(values, cell)
		}
		return strings.Join(cells, ",") + "\r\n" + strings.Join(values, ",") + "\r\n", nil
	}
	if len(value.Arr) == 0 {
		return "", nil
	}
	allObjects, allScalars, allArrays := true, true, true
	for _, item := range value.Arr {
		allObjects = allObjects && item != nil && item.IsObject()
		allScalars = allScalars && (item == nil || item.IsScalar())
		allArrays = allArrays && item != nil && item.IsArray()
	}
	if allObjects {
		keys := []string{}
		seen := map[string]bool{}
		for _, row := range value.Arr {
			for _, member := range row.Obj {
				if !seen[member.Key] {
					seen[member.Key] = true
					keys = append(keys, member.Key)
				}
			}
		}
		lines := []string{}
		header := make([]string, 0, len(keys))
		for _, key := range keys {
			header = append(header, csvEscape(key))
		}
		lines = append(lines, strings.Join(header, ","))
		for _, row := range value.Arr {
			cells := make([]string, 0, len(keys))
			for _, key := range keys {
				member, _ := row.member(key)
				cell, err := csvCell(member)
				if err != nil {
					return "", err
				}
				cells = append(cells, cell)
			}
			lines = append(lines, strings.Join(cells, ","))
		}
		return strings.Join(lines, "\r\n") + "\r\n", nil
	}
	if allScalars {
		lines := make([]string, 0, len(value.Arr))
		for _, item := range value.Arr {
			cell, err := csvCell(item)
			if err != nil {
				return "", err
			}
			lines = append(lines, cell)
		}
		return strings.Join(lines, "\r\n") + "\r\n", nil
	}
	if allArrays {
		width := 0
		for _, row := range value.Arr {
			if len(row.Arr) > width {
				width = len(row.Arr)
			}
		}
		lines := make([]string, 0, len(value.Arr))
		for _, row := range value.Arr {
			cells := make([]string, width)
			for index := range row.Arr {
				cell, err := csvCell(row.Arr[index])
				if err != nil {
					return "", err
				}
				cells[index] = cell
			}
			lines = append(lines, strings.Join(cells, ","))
		}
		return strings.Join(lines, "\r\n") + "\r\n", nil
	}
	return "", &JSONConvertError{Code: "csvMixedRows"}
}
