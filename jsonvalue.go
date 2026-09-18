package main

import (
	"errors"
	"math"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// JSONValue 是有序 JSON AST：与前端 JS 语义对齐，保留对象键顺序，数值统一为
// float64，序列化结果与 JSON.stringify 保持一致。所有变换只新建节点、不修改
// 已有节点，因此任何快照都是不可变的。
type JSONValue struct {
	Kind JSONKind
	Bool bool
	Num  float64
	Str  string
	Arr  []*JSONValue
	Obj  []JSONMember
}

type JSONKind uint8

const (
	JSONNull JSONKind = iota
	JSONBool
	JSONNumber
	JSONString
	JSONArray
	JSONObject
)

type JSONMember struct {
	Key   string
	Value *JSONValue
}

func newJSONNull() *JSONValue            { return &JSONValue{Kind: JSONNull} }
func newJSONBool(v bool) *JSONValue       { return &JSONValue{Kind: JSONBool, Bool: v} }
func newJSONNumber(v float64) *JSONValue  { return &JSONValue{Kind: JSONNumber, Num: v} }
func newJSONString(v string) *JSONValue   { return &JSONValue{Kind: JSONString, Str: v} }
func newJSONArray(v []*JSONValue) *JSONValue {
	if v == nil {
		v = []*JSONValue{}
	}
	return &JSONValue{Kind: JSONArray, Arr: v}
}
func newJSONObject(v []JSONMember) *JSONValue {
	if v == nil {
		v = []JSONMember{}
	}
	return &JSONValue{Kind: JSONObject, Obj: v}
}

func (v *JSONValue) IsObject() bool { return v != nil && v.Kind == JSONObject }
func (v *JSONValue) IsArray() bool  { return v != nil && v.Kind == JSONArray }
func (v *JSONValue) IsScalar() bool {
	if v == nil {
		return false
	}
	switch v.Kind {
	case JSONNull, JSONBool, JSONNumber, JSONString:
		return true
	default:
		return false
	}
}

func (v *JSONValue) member(key string) (*JSONValue, bool) {
	if !v.IsObject() {
		return nil, false
	}
	for index := range v.Obj {
		if v.Obj[index].Key == key {
			return v.Obj[index].Value, true
		}
	}
	return nil, false
}

func (v *JSONValue) setMember(key string, value *JSONValue) *JSONValue {
	next := make([]JSONMember, 0, len(v.Obj)+1)
	replaced := false
	for index := range v.Obj {
		if v.Obj[index].Key == key {
			next = append(next, JSONMember{Key: key, Value: value})
			replaced = true
			continue
		}
		next = append(next, v.Obj[index])
	}
	if !replaced {
		next = append(next, JSONMember{Key: key, Value: value})
	}
	return newJSONObject(next)
}

// Clone 深拷贝，用于需要在计算间完全隔离时。
func (v *JSONValue) Clone() *JSONValue {
	if v == nil {
		return nil
	}
	switch v.Kind {
	case JSONArray:
		arr := make([]*JSONValue, len(v.Arr))
		for index := range v.Arr {
			arr[index] = v.Arr[index].Clone()
		}
		return newJSONArray(arr)
	case JSONObject:
		obj := make([]JSONMember, len(v.Obj))
		for index := range v.Obj {
			obj[index] = JSONMember{Key: v.Obj[index].Key, Value: v.Obj[index].Value.Clone()}
		}
		return newJSONObject(obj)
	default:
		copied := *v
		return &copied
	}
}

// JSON 序列化 -----------------------------------------------------------------

func encodeJSONString(builder jsonWriteSink, value string) {
	builder.WriteByte('"')
	for _, r := range value {
		switch r {
		case '"':
			builder.WriteString(`\"`)
		case '\\':
			builder.WriteString(`\\`)
		case '\b':
			builder.WriteString(`\b`)
		case '\f':
			builder.WriteString(`\f`)
		case '\n':
			builder.WriteString(`\n`)
		case '\r':
			builder.WriteString(`\r`)
		case '\t':
			builder.WriteString(`\t`)
		default:
			if r < 0x20 {
				const hex = "0123456789abcdef"
				builder.WriteString(`\u`)
				builder.WriteByte(hex[(r>>12)&0xF])
				builder.WriteByte(hex[(r>>8)&0xF])
				builder.WriteByte(hex[(r>>4)&0xF])
				builder.WriteByte(hex[r&0xF])
				continue
			}
			builder.WriteString(string(r))
		}
	}
	builder.WriteByte('"')
}

// formatJSONNumber 复刻 ECMAScript Number::toString(10)，与 JSON.stringify 一致。
func formatJSONNumber(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "null"
	}
	if value == 0 {
		return "0"
	}
	negative := math.Signbit(value)
	if negative {
		value = -value
	}
	// 最短往返表示：digits × 10^(exp) 形式。
	digits, exponent, err := shortestDigits(value)
	if err != nil {
		return strconv.FormatFloat(value, 'g', -1, 64)
	}
	k := len(digits)
	n := exponent + 1
	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		expPart := n - 1
		sign := "+"
		if expPart < 0 {
			sign = "-"
			expPart = -expPart
		}
		mantissa := digits[:1]
		if k > 1 {
			mantissa = digits[:1] + "." + digits[1:]
		}
		out = mantissa + "e" + sign + strconv.Itoa(expPart)
	}
	if negative {
		return "-" + out
	}
	return out
}

func shortestDigits(value float64) (string, int, error) {
	raw := strconv.FormatFloat(value, 'e', -1, 64)
	eIndex := strings.IndexByte(raw, 'e')
	if eIndex < 0 {
		return "", 0, errors.New("unexpected float format")
	}
	mantissa := raw[:eIndex]
	exponent, err := strconv.Atoi(raw[eIndex+1:])
	if err != nil {
		return "", 0, err
	}
	digits := strings.Replace(mantissa, ".", "", 1)
	digits = strings.TrimRight(digits, "0")
	if digits == "" {
		digits = "0"
	}
	return digits, exponent, nil
}

func writeJSONValue(builder jsonWriteSink, value *JSONValue, indent string, depth int) {
	if value == nil {
		builder.WriteString("null")
		return
	}
	switch value.Kind {
	case JSONNull:
		builder.WriteString("null")
	case JSONBool:
		if value.Bool {
			builder.WriteString("true")
		} else {
			builder.WriteString("false")
		}
	case JSONNumber:
		builder.WriteString(formatJSONNumber(value.Num))
	case JSONString:
		encodeJSONString(builder, value.Str)
	case JSONArray:
		if len(value.Arr) == 0 {
			builder.WriteString("[]")
			return
		}
		builder.WriteByte('[')
		for index, item := range value.Arr {
			if index > 0 {
				builder.WriteByte(',')
			}
			if indent != "" {
				builder.WriteByte('\n')
				builder.WriteString(strings.Repeat(indent, depth+1))
			}
			writeJSONValue(builder, item, indent, depth+1)
		}
		if indent != "" {
			builder.WriteByte('\n')
			builder.WriteString(strings.Repeat(indent, depth))
		}
		builder.WriteByte(']')
	case JSONObject:
		if len(value.Obj) == 0 {
			builder.WriteString("{}")
			return
		}
		builder.WriteByte('{')
		for index := range value.Obj {
			if index > 0 {
				builder.WriteByte(',')
			}
			if indent != "" {
				builder.WriteByte('\n')
				builder.WriteString(strings.Repeat(indent, depth+1))
			}
			encodeJSONString(builder, value.Obj[index].Key)
			builder.WriteByte(':')
			if indent != "" {
				builder.WriteByte(' ')
			}
			writeJSONValue(builder, value.Obj[index].Value, indent, depth+1)
		}
		if indent != "" {
			builder.WriteByte('\n')
			builder.WriteString(strings.Repeat(indent, depth))
		}
		builder.WriteByte('}')
	}
}

// StringifyJSON 等价于 JS 的 JSON.stringify(value) / JSON.stringify(value, null, 2)。
func StringifyJSON(value *JSONValue, indent string) string {
	var builder strings.Builder
	writeJSONValue(&builder, value, indent, 0)
	return builder.String()
}

// Loose JSON 解析 -------------------------------------------------------------

type looseJSONParser struct {
	source string
	pos    int
}

var errLooseJSON = errors.New("invalid json")

// ParseJSONLoose 支持 // 与 /* */ 注释以及尾随逗号，与前端 parseJsonLoose 一致。
func ParseJSONLoose(source string) (*JSONValue, error) {
	parser := &looseJSONParser{source: source}
	parser.skipTrivia()
	value, err := parser.parseValue()
	if err != nil {
		return nil, err
	}
	parser.skipTrivia()
	if parser.pos != len(parser.source) {
		return nil, errLooseJSON
	}
	return value, nil
}

func (p *looseJSONParser) skipTrivia() {
	for p.pos < len(p.source) {
		switch p.source[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		case '/':
			if p.pos+1 >= len(p.source) {
				return
			}
			switch p.source[p.pos+1] {
			case '/':
				p.pos += 2
				for p.pos < len(p.source) && p.source[p.pos] != '\n' {
					p.pos++
				}
			case '*':
				p.pos += 2
				for p.pos+1 < len(p.source) && !(p.source[p.pos] == '*' && p.source[p.pos+1] == '/') {
					p.pos++
				}
				if p.pos+1 < len(p.source) {
					p.pos += 2
				} else {
					p.pos = len(p.source)
				}
			default:
				return
			}
		default:
			return
		}
	}
}

func (p *looseJSONParser) parseValue() (*JSONValue, error) {
	if p.pos >= len(p.source) {
		return nil, errLooseJSON
	}
	switch p.source[p.pos] {
	case '{':
		return p.parseObject()
	case '[':
		return p.parseArray()
	case '"':
		value, err := p.parseString()
		if err != nil {
			return nil, err
		}
		return newJSONString(value), nil
	case 't':
		if strings.HasPrefix(p.source[p.pos:], "true") {
			p.pos += 4
			return newJSONBool(true), nil
		}
		return nil, errLooseJSON
	case 'f':
		if strings.HasPrefix(p.source[p.pos:], "false") {
			p.pos += 5
			return newJSONBool(false), nil
		}
		return nil, errLooseJSON
	case 'n':
		if strings.HasPrefix(p.source[p.pos:], "null") {
			p.pos += 4
			return newJSONNull(), nil
		}
		return nil, errLooseJSON
	default:
		return p.parseNumber()
	}
}

func (p *looseJSONParser) parseObject() (*JSONValue, error) {
	p.pos++ // {
	members := []JSONMember{}
	p.skipTrivia()
	if p.pos < len(p.source) && p.source[p.pos] == '}' {
		p.pos++
		return newJSONObject(members), nil
	}
	for {
		p.skipTrivia()
		if p.pos >= len(p.source) || p.source[p.pos] != '"' {
			return nil, errLooseJSON
		}
		key, err := p.parseString()
		if err != nil {
			return nil, err
		}
		p.skipTrivia()
		if p.pos >= len(p.source) || p.source[p.pos] != ':' {
			return nil, errLooseJSON
		}
		p.pos++
		p.skipTrivia()
		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		members = append(members, JSONMember{Key: key, Value: value})
		p.skipTrivia()
		if p.pos >= len(p.source) {
			return nil, errLooseJSON
		}
		switch p.source[p.pos] {
		case ',':
			p.pos++
			p.skipTrivia()
			if p.pos < len(p.source) && p.source[p.pos] == '}' {
				p.pos++
				return newJSONObject(members), nil
			}
			continue
		case '}':
			p.pos++
			return newJSONObject(members), nil
		default:
			return nil, errLooseJSON
		}
	}
}

func (p *looseJSONParser) parseArray() (*JSONValue, error) {
	p.pos++ // [
	items := []*JSONValue{}
	p.skipTrivia()
	if p.pos < len(p.source) && p.source[p.pos] == ']' {
		p.pos++
		return newJSONArray(items), nil
	}
	for {
		p.skipTrivia()
		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		items = append(items, value)
		p.skipTrivia()
		if p.pos >= len(p.source) {
			return nil, errLooseJSON
		}
		switch p.source[p.pos] {
		case ',':
			p.pos++
			p.skipTrivia()
			if p.pos < len(p.source) && p.source[p.pos] == ']' {
				p.pos++
				return newJSONArray(items), nil
			}
			continue
		case ']':
			p.pos++
			return newJSONArray(items), nil
		default:
			return nil, errLooseJSON
		}
	}
}

func (p *looseJSONParser) parseString() (string, error) {
	p.pos++ // opening quote
	var builder strings.Builder
	for p.pos < len(p.source) {
		ch := p.source[p.pos]
		switch {
		case ch == '"':
			p.pos++
			return builder.String(), nil
		case ch == '\\':
			p.pos++
			if p.pos >= len(p.source) {
				return "", errLooseJSON
			}
			escape := p.source[p.pos]
			switch escape {
			case '"':
				builder.WriteByte('"')
			case '\\':
				builder.WriteByte('\\')
			case '/':
				builder.WriteByte('/')
			case 'b':
				builder.WriteByte('\b')
			case 'f':
				builder.WriteByte('\f')
			case 'n':
				builder.WriteByte('\n')
			case 'r':
				builder.WriteByte('\r')
			case 't':
				builder.WriteByte('\t')
			case 'u':
				r, err := p.parseUnicodeEscape()
				if err != nil {
					return "", err
				}
				builder.WriteRune(r)
			default:
				return "", errLooseJSON
			}
			p.pos++
		case ch < 0x20:
			return "", errLooseJSON
		default:
			builder.WriteByte(ch)
			p.pos++
		}
	}
	return "", errLooseJSON
}

func (p *looseJSONParser) parseUnicodeEscape() (rune, error) {
	// p.pos 指向 'u'
	first, err := p.readHex4(p.pos + 1)
	if err != nil {
		return 0, err
	}
	p.pos += 4 // 移到最后一个 hex 位（外层会再 ++）
	if utf16.IsSurrogate(rune(first)) && p.pos+2 < len(p.source) && p.source[p.pos+1] == '\\' && p.source[p.pos+2] == 'u' {
		second, err := p.readHex4(p.pos + 3)
		if err == nil {
			combined := utf16.DecodeRune(rune(first), rune(second))
			if combined != utf8.RuneError {
				p.pos += 6
				return combined, nil
			}
		}
	}
	return rune(first), nil
}

func (p *looseJSONParser) readHex4(start int) (uint32, error) {
	if start+4 > len(p.source) {
		return 0, errLooseJSON
	}
	value, err := strconv.ParseUint(p.source[start:start+4], 16, 32)
	if err != nil {
		return 0, errLooseJSON
	}
	return uint32(value), nil
}

func (p *looseJSONParser) parseNumber() (*JSONValue, error) {
	start := p.pos
	if p.pos < len(p.source) && (p.source[p.pos] == '-' || p.source[p.pos] == '+') {
		p.pos++
	}
	for p.pos < len(p.source) {
		ch := p.source[p.pos]
		if (ch >= '0' && ch <= '9') || ch == '.' || ch == 'e' || ch == 'E' || ch == '+' || ch == '-' {
			p.pos++
			continue
		}
		break
	}
	if p.pos == start {
		return nil, errLooseJSON
	}
	value, err := strconv.ParseFloat(p.source[start:p.pos], 64)
	if err != nil {
		return nil, errLooseJSON
	}
	return newJSONNumber(value), nil
}
