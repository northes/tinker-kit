package main

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// PipelineItem 是流水线步骤的导出模型，字段与前端 PipelineItem 一致。
type PipelineItem struct {
	ID          string `json:"id"`
	Enabled     bool   `json:"enabled"`
	Type        string `json:"type"`
	Path        string `json:"path"`
	SortMode    string `json:"sortMode"`
	Direction   string `json:"direction"`
	ArrayPath   string `json:"arrayPath"`
	ItemPath    string `json:"itemPath"`
	Operator    string `json:"operator"`
	MatchMode   string `json:"matchMode"`
	FilterValue string `json:"filterValue"`
	Template    string `json:"template"`
}

const (
	pipelineTypeExtract     = "extract"
	pipelineTypeSort        = "sort"
	pipelineTypeArraySort   = "arraySort"
	pipelineTypeFilter      = "filter"
	pipelineTypeArrayDedupe = "arrayDedupe"
	pipelineTypeArrayTrim   = "arrayTrim"
	pipelineTypeTemplate    = "template"
)

const (
	filterOperatorGT              = "gt"
	filterOperatorGTE             = "gte"
	filterOperatorEQ              = "eq"
	filterOperatorLT              = "lt"
	filterOperatorLTE             = "lte"
	filterOperatorIncludes        = "includes"
	filterOperatorExcludes        = "excludes"
	filterOperatorNotNull         = "notNull"
	filterOperatorNotEmpty        = "notEmpty"
	filterOperatorIsNull          = "isNull"
	filterOperatorIsEmpty         = "isEmpty"
	filterOperatorStringLengthGT  = "stringLengthGt"
	filterOperatorStringLengthGTE = "stringLengthGte"
	filterOperatorStringLengthEQ  = "stringLengthEq"
	filterOperatorStringLengthLT  = "stringLengthLt"
	filterOperatorStringLengthLTE = "stringLengthLte"
)

// PipelineError 与前端 jsonTool.pipeline.errors.* 的 code 对齐。
type PipelineError struct {
	Code  string `json:"code"`
	Item  *int   `json:"item,omitempty"`
	Path  string `json:"path,omitempty"`
	Index *int   `json:"index,omitempty"`
}

func pipelineError(code string, item int) *PipelineError {
	index := item
	return &PipelineError{Code: code, Item: &index}
}

func pipelinePathError(code string, item int, path string) *PipelineError {
	index := item
	return &PipelineError{Code: code, Item: &index, Path: path}
}

func validPipelineType(value string) bool {
	switch value {
	case pipelineTypeExtract, pipelineTypeSort, pipelineTypeArraySort, pipelineTypeFilter, pipelineTypeArrayDedupe, pipelineTypeArrayTrim, pipelineTypeTemplate:
		return true
	default:
		return false
	}
}

func normalizePipelineItem(item PipelineItem) PipelineItem {
	if item.Type == "" {
		item.Type = pipelineTypeExtract
	}
	if item.SortMode != "value" {
		item.SortMode = "key"
	}
	if item.Direction != "desc" {
		item.Direction = "asc"
	}
	if item.Path == "" {
		item.Path = "$"
	}
	if item.ArrayPath == "" {
		item.ArrayPath = "$"
	}
	if item.ItemPath == "" {
		item.ItemPath = "$"
	}
	item.Operator = normalizeFilterOperator(item.Operator)
	if item.MatchMode != "value" {
		item.MatchMode = "key"
	}
	return item
}

func samePipelineExecution(a, b PipelineItem) bool {
	return a.ID == b.ID &&
		a.Enabled == b.Enabled &&
		a.Type == b.Type &&
		a.Path == b.Path &&
		a.SortMode == b.SortMode &&
		a.Direction == b.Direction &&
		a.ArrayPath == b.ArrayPath &&
		a.ItemPath == b.ItemPath &&
		a.Operator == b.Operator &&
		a.MatchMode == b.MatchMode &&
		a.FilterValue == b.FilterValue &&
		a.Template == b.Template
}

// 路径解析 -------------------------------------------------------------------

type pathTokenType uint8

const (
	pathTokenKey pathTokenType = iota
	pathTokenIndex
	pathTokenAll
)

type pathToken struct {
	Type  pathTokenType
	Value string
}

type pathParseError struct{ code string }

func (e *pathParseError) Error() string { return e.code }

func parsePipelinePath(path string) ([]pathToken, error) {
	tokens := []pathToken{}
	source := strings.TrimSpace(path)
	source = strings.TrimPrefix(source, "$")
	index := 0
	for index < len(source) {
		switch source[index] {
		case '.', '/':
			index++
			continue
		case '[':
			end := strings.IndexByte(source[index:], ']')
			if end < 0 {
				return nil, &pathParseError{code: "missingBracket"}
			}
			end += index
			inner := strings.TrimSpace(source[index+1 : end])
			switch {
			case inner == "*":
				tokens = append(tokens, pathToken{Type: pathTokenAll, Value: "*"})
			case isIntegerLiteral(inner):
				tokens = append(tokens, pathToken{Type: pathTokenIndex, Value: inner})
			case (strings.HasPrefix(inner, "'") && strings.HasSuffix(inner, "'")) ||
				(strings.HasPrefix(inner, `"`) && strings.HasSuffix(inner, `"`)):
				tokens = append(tokens, pathToken{Type: pathTokenKey, Value: inner[1 : len(inner)-1]})
			default:
				return nil, &pathParseError{code: "invalidSegment"}
			}
			index = end + 1
		default:
			ch := source[index]
			if isPathKeyChar(ch) {
				end := index
				for end < len(source) && (isPathKeyChar(source[end]) || source[end] == '-') {
					end++
				}
				tokens = append(tokens, pathToken{Type: pathTokenKey, Value: source[index:end]})
				index = end
				continue
			}
			return nil, &pathParseError{code: "invalidChar"}
		}
	}
	return tokens, nil
}

func isIntegerLiteral(value string) bool {
	if value == "" {
		return false
	}
	start := 0
	if value[0] == '-' {
		if len(value) == 1 {
			return false
		}
		start = 1
	}
	for index := start; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	return true
}

func isPathKeyChar(ch byte) bool {
	return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '$'
}

func readTokens(value *JSONValue, tokens []pathToken, offset int) (*JSONValue, error) {
	if offset >= len(tokens) {
		return value, nil
	}
	token := tokens[offset]
	switch token.Type {
	case pathTokenAll:
		var children []*JSONValue
		switch {
		case value.IsArray():
			children = value.Arr
		case value.IsObject():
			children = make([]*JSONValue, 0, len(value.Obj))
			for index := range value.Obj {
				children = append(children, value.Obj[index].Value)
			}
		default:
			return nil, &pathParseError{code: "notContainer"}
		}
		result := make([]*JSONValue, 0, len(children))
		for _, child := range children {
			next, err := readTokens(child, tokens, offset+1)
			if err != nil {
				return nil, err
			}
			result = append(result, next)
		}
		return newJSONArray(result), nil
	case pathTokenIndex:
		if !value.IsArray() {
			return nil, &pathParseError{code: "notArray"}
		}
		index := 0
		if _, err := fmt.Sscanf(token.Value, "%d", &index); err != nil {
			return nil, &pathParseError{code: "invalidSegment"}
		}
		if index < 0 || index >= len(value.Arr) {
			return nil, &pathParseError{code: "indexOutOfRange"}
		}
		return readTokens(value.Arr[index], tokens, offset+1)
	default:
		child, ok := value.member(token.Value)
		if !ok {
			return nil, &pathParseError{code: "pathNotFound"}
		}
		return readTokens(child, tokens, offset+1)
	}
}

func readOptionalTokens(value *JSONValue, tokens []pathToken) (*JSONValue, bool) {
	result, err := readTokens(value, tokens, 0)
	if err != nil {
		return nil, false
	}
	return result, true
}

func readPath(value *JSONValue, path string, allowWildcard bool, index int, kind string) (*JSONValue, *PipelineError) {
	if strings.TrimSpace(path) == "" {
		switch kind {
		case "arrayPath":
			return nil, pipelineError("arrayPathRequired", index)
		case "itemPath":
			return nil, pipelineError("itemPathRequired", index)
		default:
			return nil, pipelineError("pathRequired", index)
		}
	}
	tokens, err := parsePipelinePath(path)
	if err != nil {
		return nil, pipelineError("invalidPath", index)
	}
	if !allowWildcard {
		for _, token := range tokens {
			if token.Type == pathTokenAll {
				return nil, pipelinePathError("pathMultiple", index, path)
			}
		}
	}
	result, readErr := readTokens(value, tokens, 0)
	if readErr == nil {
		return result, nil
	}
	var parseErr *pathParseError
	if errors.As(readErr, &parseErr) {
		switch parseErr.code {
		case "notContainer", "notArray":
			code := "pathNotFound"
			if kind == "arrayPath" {
				code = "arrayPathInvalid"
			} else if kind == "itemPath" {
				code = "itemPathInvalid"
			}
			return nil, pipelinePathError(code, index, path)
		case "indexOutOfRange":
			return nil, pipelinePathError("pathIndexOutOfRange", index, path)
		default:
			code := "pathNotFound"
			if kind == "arrayPath" {
				code = "arrayPathNotFound"
			} else if kind == "template" {
				code = "templatePathNotFound"
			}
			return nil, pipelinePathError(code, index, path)
		}
	}
	return nil, pipelineError("pathNotFound", index)
}

// 排序 -----------------------------------------------------------------------

func scalarRank(value *JSONValue) int {
	switch value.Kind {
	case JSONNull:
		return 0
	case JSONBool:
		return 1
	case JSONNumber:
		return 2
	default:
		return 3
	}
}

func compareScalars(a, b *JSONValue) int {
	rankA, rankB := scalarRank(a), scalarRank(b)
	if rankA != rankB {
		return rankA - rankB
	}
	switch a.Kind {
	case JSONBool:
		if a.Bool == b.Bool {
			return 0
		}
		if !a.Bool {
			return -1
		}
		return 1
	case JSONNumber:
		switch {
		case a.Num < b.Num:
			return -1
		case a.Num > b.Num:
			return 1
		default:
			return 0
		}
	case JSONString:
		return strings.Compare(a.Str, b.Str)
	default:
		return 0
	}
}

func stableSortValues(items []*JSONValue, key func(*JSONValue) *JSONValue, direction string) []*JSONValue {
	type entry struct {
		value *JSONValue
		index int
	}
	entries := make([]entry, len(items))
	for index, item := range items {
		entries[index] = entry{value: item, index: index}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		result := compareScalars(key(entries[i].value), key(entries[j].value))
		if result == 0 {
			return entries[i].index < entries[j].index
		}
		if direction == "desc" {
			return result > 0
		}
		return result < 0
	})
	result := make([]*JSONValue, len(items))
	for index := range entries {
		result[index] = entries[index].value
	}
	return result
}

func compareKeys(a, b string) int { return strings.Compare(a, b) }

func sortKeys(value *JSONValue, direction string) *JSONValue {
	if value.IsArray() {
		items := make([]*JSONValue, len(value.Arr))
		for index := range value.Arr {
			items[index] = sortKeys(value.Arr[index], direction)
		}
		return newJSONArray(items)
	}
	if !value.IsObject() {
		return value
	}
	keys := make([]string, len(value.Obj))
	for index := range value.Obj {
		keys[index] = value.Obj[index].Key
	}
	sort.SliceStable(keys, func(i, j int) bool {
		if direction == "desc" {
			return compareKeys(keys[i], keys[j]) > 0
		}
		return compareKeys(keys[i], keys[j]) < 0
	})
	byKey := make(map[string]*JSONValue, len(value.Obj))
	for index := range value.Obj {
		byKey[value.Obj[index].Key] = value.Obj[index].Value
	}
	members := make([]JSONMember, 0, len(keys))
	for _, key := range keys {
		members = append(members, JSONMember{Key: key, Value: sortKeys(byKey[key], direction)})
	}
	return newJSONObject(members)
}

func sortValues(value *JSONValue, direction string) *JSONValue {
	if value.IsArray() {
		next := value.Arr
		allScalar := true
		for _, item := range value.Arr {
			if !item.IsScalar() {
				allScalar = false
				break
			}
		}
		if allScalar {
			next = stableSortValues(value.Arr, func(item *JSONValue) *JSONValue { return item }, direction)
		}
		items := make([]*JSONValue, len(next))
		for index := range next {
			items[index] = sortValues(next[index], direction)
		}
		return newJSONArray(items)
	}
	if !value.IsObject() {
		return value
	}
	members := make([]JSONMember, 0, len(value.Obj))
	for index := range value.Obj {
		members = append(members, JSONMember{
			Key:   value.Obj[index].Key,
			Value: sortValues(value.Obj[index].Value, direction),
		})
	}
	return newJSONObject(members)
}

func updatePath(value *JSONValue, tokens []pathToken, offset int, update func(*JSONValue) *JSONValue) (*JSONValue, error) {
	if offset >= len(tokens) {
		return update(value), nil
	}
	token := tokens[offset]
	switch token.Type {
	case pathTokenAll:
		return nil, &pathParseError{code: "multiple"}
	case pathTokenIndex:
		if !value.IsArray() {
			return nil, &pathParseError{code: "notArray"}
		}
		index := 0
		if _, err := fmt.Sscanf(token.Value, "%d", &index); err != nil {
			return nil, &pathParseError{code: "invalidSegment"}
		}
		if index < 0 || index >= len(value.Arr) {
			return nil, &pathParseError{code: "indexOutOfRange"}
		}
		items := make([]*JSONValue, len(value.Arr))
		copy(items, value.Arr)
		next, err := updatePath(items[index], tokens, offset+1, update)
		if err != nil {
			return nil, err
		}
		items[index] = next
		return newJSONArray(items), nil
	default:
		child, ok := value.member(token.Value)
		if !ok {
			return nil, &pathParseError{code: "pathNotFound"}
		}
		next, err := updatePath(child, tokens, offset+1, update)
		if err != nil {
			return nil, err
		}
		return value.setMember(token.Value, next), nil
	}
}

func pathTokens(path string, index int, kind string) ([]pathToken, *PipelineError) {
	if strings.TrimSpace(path) == "" {
		if kind == "arrayPath" {
			return nil, pipelineError("arrayPathRequired", index)
		}
		return nil, pipelineError("itemPathRequired", index)
	}
	tokens, err := parsePipelinePath(path)
	if err != nil {
		return nil, pipelineError("invalidPath", index)
	}
	for _, token := range tokens {
		if token.Type == pathTokenAll {
			return nil, pipelinePathError("pathMultiple", index, path)
		}
	}
	return tokens, nil
}

// 执行 -----------------------------------------------------------------------

func executeArraySort(value *JSONValue, item PipelineItem, index int) (*JSONValue, *PipelineError) {
	arrayTokens, failure := pathTokens(item.ArrayPath, index, "arrayPath")
	if failure != nil {
		return nil, failure
	}
	itemTokens, failure := pathTokens(item.ItemPath, index, "itemPath")
	if failure != nil {
		return nil, failure
	}
	target, err := readTokens(value, arrayTokens, 0)
	if err != nil {
		return nil, pipelinePathError("arrayPathNotFound", index, item.ArrayPath)
	}
	if !target.IsArray() {
		return nil, pipelinePathError("arrayPathInvalid", index, item.ArrayPath)
	}
	type slot struct {
		value *JSONValue
		index int
		key   *JSONValue
	}
	matched := make([]slot, 0, len(target.Arr))
	for position, entry := range target.Arr {
		if entry.Kind == JSONNull {
			continue
		}
		key, keyErr := readTokens(entry, itemTokens, 0)
		if keyErr != nil || !key.IsScalar() {
			continue
		}
		matched = append(matched, slot{value: entry, index: position, key: key})
	}
	sorted := make([]slot, len(matched))
	copy(sorted, matched)
	sort.SliceStable(sorted, func(i, j int) bool {
		result := compareScalars(sorted[i].key, sorted[j].key)
		if result == 0 {
			return sorted[i].index < sorted[j].index
		}
		if item.Direction == "desc" {
			return result > 0
		}
		return result < 0
	})
	result := make([]*JSONValue, len(target.Arr))
	copy(result, target.Arr)
	for position := range matched {
		result[matched[position].index] = sorted[position].value
	}
	next, err := updatePath(value, arrayTokens, 0, func(*JSONValue) *JSONValue { return newJSONArray(result) })
	if err != nil {
		return nil, pipelinePathError("arrayPathNotFound", index, item.ArrayPath)
	}
	return next, nil
}

// pipelineValueKey 生成去重用的稳定标识：对象成员按名称排序，数组保持顺序，
// 因此内容相同但键顺序不同的对象会被视为重复。
func pipelineValueKey(value *JSONValue) string {
	if value == nil {
		return "null"
	}
	switch value.Kind {
	case JSONObject:
		members := append([]JSONMember(nil), value.Obj...)
		sort.SliceStable(members, func(i, j int) bool { return members[i].Key < members[j].Key })
		var builder strings.Builder
		builder.WriteByte('{')
		for index, member := range members {
			if index > 0 {
				builder.WriteByte(',')
			}
			builder.WriteString(strconv.Quote(member.Key))
			builder.WriteByte(':')
			builder.WriteString(pipelineValueKey(member.Value))
		}
		builder.WriteByte('}')
		return builder.String()
	case JSONArray:
		var builder strings.Builder
		builder.WriteByte('[')
		for index, entry := range value.Arr {
			if index > 0 {
				builder.WriteByte(',')
			}
			builder.WriteString(pipelineValueKey(entry))
		}
		builder.WriteByte(']')
		return builder.String()
	default:
		return StringifyJSON(value, "")
	}
}

// executeArrayDedupe 按去重项路径的值保留首次出现的数组项；无法读取去重键的项
// 原样保留，避免静默丢弃数据。
func executeArrayDedupe(value *JSONValue, item PipelineItem, index int) (*JSONValue, *PipelineError) {
	arrayTokens, failure := pathTokens(item.ArrayPath, index, "arrayPath")
	if failure != nil {
		return nil, failure
	}
	itemTokens, failure := pathTokens(item.ItemPath, index, "itemPath")
	if failure != nil {
		return nil, failure
	}
	target, err := readTokens(value, arrayTokens, 0)
	if err != nil {
		return nil, pipelinePathError("arrayPathNotFound", index, item.ArrayPath)
	}
	if !target.IsArray() {
		return nil, pipelinePathError("arrayPathInvalid", index, item.ArrayPath)
	}
	seen := make(map[string]struct{}, len(target.Arr))
	deduped := make([]*JSONValue, 0, len(target.Arr))
	for _, entry := range target.Arr {
		key, keyErr := readTokens(entry, itemTokens, 0)
		if keyErr != nil {
			deduped = append(deduped, entry)
			continue
		}
		identity := pipelineValueKey(key)
		if _, exists := seen[identity]; exists {
			continue
		}
		seen[identity] = struct{}{}
		deduped = append(deduped, entry)
	}
	next, err := updatePath(value, arrayTokens, 0, func(*JSONValue) *JSONValue {
		return newJSONArray(deduped)
	})
	if err != nil {
		return nil, pipelinePathError("arrayPathNotFound", index, item.ArrayPath)
	}
	return next, nil
}

func normalizeFilterOperator(value string) string {
	switch value {
	case filterOperatorGT, filterOperatorGTE, filterOperatorEQ, filterOperatorLT, filterOperatorLTE,
		filterOperatorIncludes, filterOperatorExcludes, filterOperatorNotNull, filterOperatorNotEmpty,
		filterOperatorIsNull, filterOperatorIsEmpty,
		filterOperatorStringLengthGT, filterOperatorStringLengthGTE, filterOperatorStringLengthEQ,
		filterOperatorStringLengthLT, filterOperatorStringLengthLTE:
		return value
	default:
		return filterOperatorEQ
	}
}

func emptyJSONValue(value *JSONValue) bool {
	if value == nil {
		return true
	}
	switch value.Kind {
	case JSONNull:
		return true
	case JSONString:
		return value.Str == ""
	case JSONArray:
		return len(value.Arr) == 0
	case JSONObject:
		return len(value.Obj) == 0
	default:
		return false
	}
}

func filterComparisonMatches(comparison int, operator string) bool {
	switch operator {
	case filterOperatorGT:
		return comparison > 0
	case filterOperatorGTE:
		return comparison >= 0
	case filterOperatorLT:
		return comparison < 0
	case filterOperatorLTE:
		return comparison <= 0
	default:
		return comparison == 0
	}
}

func filterLengthBaseOperator(operator string) string {
	switch operator {
	case filterOperatorStringLengthGT:
		return filterOperatorGT
	case filterOperatorStringLengthGTE:
		return filterOperatorGTE
	case filterOperatorStringLengthLT:
		return filterOperatorLT
	case filterOperatorStringLengthLTE:
		return filterOperatorLTE
	default:
		return filterOperatorEQ
	}
}

func isFilterLengthOperator(operator string) bool {
	switch operator {
	case filterOperatorStringLengthGT, filterOperatorStringLengthGTE, filterOperatorStringLengthEQ,
		filterOperatorStringLengthLT, filterOperatorStringLengthLTE:
		return true
	default:
		return false
	}
}

func isFilterUnaryOperator(operator string) bool {
	switch operator {
	case filterOperatorNotNull, filterOperatorNotEmpty, filterOperatorIsNull, filterOperatorIsEmpty:
		return true
	default:
		return false
	}
}

func isFilterListOperator(operator string) bool {
	return operator == filterOperatorIncludes || operator == filterOperatorExcludes
}

// parseFilterList 解析英文逗号分隔的值列表。合法 JSON 标量按原类型匹配，
// 其余片段按字符串处理，便于直接输入 active,pending 这类值。
func parseFilterList(raw string, index int) ([]*JSONValue, *PipelineError) {
	if strings.TrimSpace(raw) == "" {
		return nil, pipelineError("filterValueRequired", index)
	}
	parts := strings.Split(raw, ",")
	values := make([]*JSONValue, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if value, err := ParseJSONLoose(part); err == nil && value.IsScalar() {
			values = append(values, value)
			continue
		}
		values = append(values, newJSONString(part))
	}
	if len(values) == 0 {
		return nil, pipelineError("filterValueRequired", index)
	}
	return values, nil
}

func filterListText(value *JSONValue) string {
	if value.Kind == JSONString {
		return value.Str
	}
	return StringifyJSON(value, "")
}

func executeArrayTrim(value *JSONValue, item PipelineItem, index int) (*JSONValue, *PipelineError) {
	arrayTokens, failure := pathTokens(item.ArrayPath, index, "arrayPath")
	if failure != nil {
		return nil, failure
	}
	values, failure := parseFilterList(item.FilterValue, index)
	if failure != nil {
		return nil, failure
	}
	target, err := readTokens(value, arrayTokens, 0)
	if err != nil {
		return nil, pipelinePathError("arrayPathNotFound", index, item.ArrayPath)
	}
	if !target.IsArray() {
		return nil, pipelinePathError("arrayPathInvalid", index, item.ArrayPath)
	}
	matchMode := item.MatchMode
	if matchMode != "value" {
		matchMode = "key"
	}
	keys := make(map[string]bool, len(values))
	if matchMode == "key" {
		for _, candidate := range values {
			keys[filterListText(candidate)] = true
		}
	}
	trimmed := make([]*JSONValue, 0, len(target.Arr))
	for _, entry := range target.Arr {
		if !entry.IsObject() {
			trimmed = append(trimmed, entry)
			continue
		}
		kept := make([]JSONMember, 0, len(entry.Obj))
		for _, member := range entry.Obj {
			keep := false
			if matchMode == "value" {
				if member.Value.IsScalar() {
					for _, candidate := range values {
						if member.Value.Kind == candidate.Kind && compareScalars(member.Value, candidate) == 0 {
							keep = true
							break
						}
					}
				}
			} else {
				keep = keys[member.Key]
			}
			if keep {
				kept = append(kept, member)
			}
		}
		trimmed = append(trimmed, newJSONObject(kept))
	}
	next, err := updatePath(value, arrayTokens, 0, func(*JSONValue) *JSONValue {
		return newJSONArray(trimmed)
	})
	if err != nil {
		return nil, pipelinePathError("arrayPathNotFound", index, item.ArrayPath)
	}
	return next, nil
}

func parseFilterValue(raw string, index int) (*JSONValue, *PipelineError) {
	if strings.TrimSpace(raw) == "" {
		return nil, pipelineError("filterValueRequired", index)
	}
	value, err := ParseJSONLoose(raw)
	if err != nil || !value.IsScalar() {
		return nil, pipelineError("filterValueInvalid", index)
	}
	return value, nil
}

func executeFilter(value *JSONValue, item PipelineItem, index int) (*JSONValue, *PipelineError) {
	arrayTokens, failure := pathTokens(item.ArrayPath, index, "arrayPath")
	if failure != nil {
		return nil, failure
	}
	target, err := readTokens(value, arrayTokens, 0)
	if err != nil {
		return nil, pipelinePathError("arrayPathNotFound", index, item.ArrayPath)
	}
	if !target.IsArray() {
		return nil, pipelinePathError("arrayPathInvalid", index, item.ArrayPath)
	}
	itemTokens := []pathToken{}
	if strings.TrimSpace(item.ItemPath) != "" {
		itemTokens, failure = pathTokens(item.ItemPath, index, "itemPath")
		if failure != nil {
			return nil, failure
		}
	}
	operator := normalizeFilterOperator(item.Operator)
	var expected *JSONValue
	var expectedList []*JSONValue
	if isFilterListOperator(operator) {
		expectedList, failure = parseFilterList(item.FilterValue, index)
		if failure != nil {
			return nil, failure
		}
	} else if !isFilterUnaryOperator(operator) {
		expected, failure = parseFilterValue(item.FilterValue, index)
		if failure != nil {
			return nil, failure
		}
		if isFilterLengthOperator(operator) &&
			(expected.Kind != JSONNumber || expected.Num < 0 || expected.Num != math.Trunc(expected.Num)) {
			return nil, pipelineError("filterLengthInvalid", index)
		}
	}
	filtered := make([]*JSONValue, 0, len(target.Arr))
	for _, entry := range target.Arr {
		matched, ok := readOptionalTokens(entry, itemTokens)
		if !ok {
			// 排除列表不应丢弃无法读取筛选键的项；它们不可能命中被排除的值。
			if operator == filterOperatorExcludes {
				filtered = append(filtered, entry)
			}
			continue
		}
		matchedOperator := false
		switch operator {
		case filterOperatorIncludes, filterOperatorExcludes:
			included := false
			if matched.IsScalar() {
				for _, candidate := range expectedList {
					if matched.Kind == candidate.Kind && compareScalars(matched, candidate) == 0 {
						included = true
						break
					}
				}
			}
			if operator == filterOperatorIncludes {
				matchedOperator = included
			} else {
				matchedOperator = !included
			}
		case filterOperatorNotNull:
			matchedOperator = matched.Kind != JSONNull
		case filterOperatorNotEmpty:
			matchedOperator = !emptyJSONValue(matched)
		case filterOperatorIsNull:
			matchedOperator = matched.Kind == JSONNull
		case filterOperatorIsEmpty:
			matchedOperator = emptyJSONValue(matched)
		default:
			if isFilterLengthOperator(operator) {
				if matched.Kind != JSONString {
					continue
				}
				length := float64(utf8.RuneCountInString(matched.Str))
				comparison := 0
				switch {
				case length < expected.Num:
					comparison = -1
				case length > expected.Num:
					comparison = 1
				}
				matchedOperator = filterComparisonMatches(comparison, filterLengthBaseOperator(operator))
			} else {
				if !matched.IsScalar() || matched.Kind != expected.Kind {
					continue
				}
				matchedOperator = filterComparisonMatches(compareScalars(matched, expected), operator)
			}
		}
		if matchedOperator {
			filtered = append(filtered, entry)
		}
	}
	next, err := updatePath(value, arrayTokens, 0, func(*JSONValue) *JSONValue { return newJSONArray(filtered) })
	if err != nil {
		return nil, pipelinePathError("arrayPathNotFound", index, item.ArrayPath)
	}
	return next, nil
}

var templatePathPattern = regexp.MustCompile(`\{(\$[^{}]*)\}`)

func executeTemplate(value *JSONValue, template string, index int) (*JSONValue, *PipelineError) {
	if strings.TrimSpace(template) == "" {
		return nil, pipelineError("templateRequired", index)
	}
	if !value.IsObject() {
		return nil, pipelineError("templateRequiresObject", index)
	}
	var failure *PipelineError
	rendered := templatePathPattern.ReplaceAllStringFunc(template, func(match string) string {
		if failure != nil {
			return match
		}
		path := match[1 : len(match)-1]
		matched, err := readPath(value, path, true, index, "template")
		if err != nil {
			failure = err
			return match
		}
		if matched.IsArray() {
			failure = pipelinePathError("templateArrayValue", index, path)
			return match
		}
		if matched.Kind == JSONString {
			return matched.Str
		}
		return StringifyJSON(matched, "")
	})
	if failure != nil {
		return nil, failure
	}
	return newJSONString(rendered), nil
}

func executePipelineItem(value *JSONValue, item PipelineItem, index int) (*JSONValue, bool, *PipelineError) {
	switch item.Type {
	case pipelineTypeExtract:
		result, failure := readPath(value, item.Path, true, index, "path")
		return result, false, failure
	case pipelineTypeSort:
		if !value.IsArray() && !value.IsObject() {
			return nil, false, pipelineError("sortRequiresContainer", index)
		}
		if item.SortMode == "value" {
			return sortValues(value, item.Direction), false, nil
		}
		return sortKeys(value, item.Direction), false, nil
	case pipelineTypeArraySort:
		result, failure := executeArraySort(value, item, index)
		return result, false, failure
	case pipelineTypeFilter:
		result, failure := executeFilter(value, item, index)
		return result, false, failure
	case pipelineTypeArrayDedupe:
		result, failure := executeArrayDedupe(value, item, index)
		return result, false, failure
	case pipelineTypeArrayTrim:
		result, failure := executeArrayTrim(value, item, index)
		return result, false, failure
	default:
		result, failure := executeTemplate(value, item.Template, index)
		return result, true, failure
	}
}

func validateTemplatePlacement(items []PipelineItem) *PipelineError {
	for index := range items {
		if items[index].Type != pipelineTypeTemplate || !items[index].Enabled {
			continue
		}
		for next := index + 1; next < len(items); next++ {
			if items[next].Enabled {
				return pipelineError("templateNotLast", index)
			}
		}
	}
	return nil
}
