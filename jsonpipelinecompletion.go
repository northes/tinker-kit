package main

import (
	"strconv"
	"strings"
	"unicode"
)

// CompletionOption 是后端返回的原始补全候选，前端负责渲染与插入。
type CompletionOption struct {
	Label string `json:"label"`
	Apply string `json:"apply"`
	Type  string `json:"type"`
}

type completionPathSplit struct {
	tokens        []pathToken
	partial       string
	inBracket     bool
	followedBySep bool
}

// splitCompletionPath 复刻前端 splitPathSegments：容忍不完整的路径输入。
func splitCompletionPath(input string) completionPathSplit {
	result := completionPathSplit{}
	source := strings.TrimPrefix(input, "$")
	index := 0
	for index < len(source) {
		switch source[index] {
		case '.', ' ', '/':
			index++
			continue
		case '[':
			end := strings.IndexByte(source[index:], ']')
			if end < 0 {
				result.inBracket = true
				result.partial = source[index+1:]
				return result
			}
			end += index
			inner := strings.TrimSpace(source[index+1 : end])
			switch {
			case inner == "*":
				result.tokens = append(result.tokens, pathToken{Type: pathTokenAll, Value: "*"})
			case isIntegerLiteral(inner):
				result.tokens = append(result.tokens, pathToken{Type: pathTokenIndex, Value: inner})
			case (strings.HasPrefix(inner, "'") && strings.HasSuffix(inner, "'")) ||
				(strings.HasPrefix(inner, `"`) && strings.HasSuffix(inner, `"`)):
				result.tokens = append(result.tokens, pathToken{Type: pathTokenKey, Value: inner[1 : len(inner)-1]})
			default:
				result.inBracket = true
				result.partial = inner
				return result
			}
			index = end + 1
			result.followedBySep = index < len(source) && (source[index] == '.' || source[index] == '/')
		default:
			if !isPathKeyChar(source[index]) {
				index++
				continue
			}
			end := index
			for end < len(source) && (isPathKeyChar(source[end]) || source[end] == '-') {
				end++
			}
			if end >= len(source) {
				result.partial = source[index:]
				return result
			}
			result.tokens = append(result.tokens, pathToken{Type: pathTokenKey, Value: source[index:end]})
			index = end
		}
	}
	return result
}

func normalizeCompletionText(value string) string {
	var builder strings.Builder
	for _, r := range strings.ToLower(value) {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func fuzzyCompletionMatch(value, query string) bool {
	candidate := []rune(normalizeCompletionText(value))
	needle := []rune(normalizeCompletionText(query))
	cursor := 0
	for _, target := range needle {
		found := false
		for cursor < len(candidate) {
			if candidate[cursor] == target {
				found = true
				cursor++
				break
			}
			cursor++
		}
		if !found {
			return false
		}
	}
	return true
}

// resolveCompletionNode 解析路径 tokens，返回用于取子节点的节点。
func resolveCompletionNode(root *JSONValue, split completionPathSplit) *JSONValue {
	node := root
	for index := range split.tokens {
		token := split.tokens[index]
		switch token.Type {
		case pathTokenAll:
			if index == len(split.tokens)-1 {
				switch {
				case node.IsArray():
					// 保持数组
				case node.IsObject():
					values := make([]*JSONValue, 0, len(node.Obj))
					for member := range node.Obj {
						values = append(values, node.Obj[member].Value)
					}
					node = newJSONArray(values)
				default:
					return nil
				}
				if !node.IsArray() {
					return nil
				}
				if split.followedBySep && !split.inBracket && len(node.Arr) > 0 {
					node = node.Arr[0]
				}
			} else {
				return nil
			}
		case pathTokenIndex:
			if !node.IsArray() {
				return nil
			}
			position, err := strconv.Atoi(token.Value)
			if err != nil {
				return nil
			}
			if position < 0 || position >= len(node.Arr) {
				return nil
			}
			node = node.Arr[position]
		default:
			if !node.IsObject() {
				return nil
			}
			child, ok := node.member(token.Value)
			if !ok {
				return nil
			}
			node = child
		}
		if node == nil {
			return nil
		}
	}
	return node
}

func completionOptionsForNode(node *JSONValue, split completionPathSplit) []CompletionOption {
	if node == nil || (!node.IsObject() && !node.IsArray()) {
		return nil
	}
	filter := normalizeCompletionText(strings.TrimSpace(split.partial))
	options := []CompletionOption{}
	if node.IsArray() {
		if !split.inBracket {
			var sample *JSONValue
			for _, item := range node.Arr {
				if item.IsObject() {
					sample = item
					break
				}
			}
			if sample == nil {
				return nil
			}
			for _, member := range sample.Obj {
				label := "[*]." + member.Key
				options = append(options, CompletionOption{Label: label, Apply: label, Type: "property"})
			}
			return filterCompletionOptions(options, filter)
		}
		// 通配放最前：数组很长时也不会被补全上限截断。
		options = append(options, CompletionOption{Label: "[*]", Apply: "[*]", Type: "keyword"})
		for index := range node.Arr {
			label := "[" + strconv.Itoa(index) + "]"
			options = append(options, CompletionOption{Label: label, Apply: label, Type: "keyword"})
		}
		return filterCompletionOptions(options, filter)
	}
	if split.inBracket {
		options = append(options, CompletionOption{Label: "[*]", Apply: "[*]", Type: "keyword"})
	}
	for _, member := range node.Obj {
		if split.inBracket {
			label := "['" + member.Key + "']"
			options = append(options, CompletionOption{Label: label, Apply: label, Type: "property"})
		} else {
			options = append(options, CompletionOption{Label: member.Key, Apply: member.Key, Type: "property"})
		}
	}
	return filterCompletionOptions(options, filter)
}

func filterCompletionOptions(options []CompletionOption, filter string) []CompletionOption {
	if filter == "" {
		return options
	}
	filtered := make([]CompletionOption, 0, len(options))
	for _, option := range options {
		candidate := option.Label
		if strings.HasPrefix(candidate, "[") {
			candidate = strings.Trim(candidate, "[]'")
			candidate = strings.TrimPrefix(candidate, "*.")
		}
		if fuzzyCompletionMatch(candidate, filter) {
			filtered = append(filtered, option)
		}
	}
	return filtered
}

// propertyCompletionOptions 用于对象键补全（path/template/arrayPath/itemPath）。
func propertyCompletionOptions(root *JSONValue, prefix string) []CompletionOption {
	split := splitCompletionPath(prefix)
	node := resolveCompletionNode(root, split)
	return completionOptionsForNode(node, split)
}

// valueCompletionOptions 用于筛选值补全：去重并限量。
func valueCompletionOptions(values []*JSONValue, prefix string, limit int) []CompletionOption {
	if limit <= 0 {
		limit = 100
	}
	seen := make(map[string]bool, len(values))
	options := make([]CompletionOption, 0, len(values))
	typed := strings.ToLower(prefix)
	for _, value := range values {
		if value == nil || !value.IsScalar() {
			continue
		}
		label := StringifyJSON(value, "")
		if seen[label] {
			continue
		}
		seen[label] = true
		if typed != "" && !fuzzyCompletionMatch(label, typed) {
			continue
		}
		options = append(options, CompletionOption{Label: label, Apply: label, Type: "value"})
		if len(options) >= limit {
			break
		}
	}
	return options
}
