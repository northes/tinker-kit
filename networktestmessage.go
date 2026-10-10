package main

import (
	"encoding/json"
)

// 网络测试工具的后端文案约定（与 localizederror.go 一致）：我们自己写的提示与结论只返回
// 多语言 key 与插值参数，由前端 i18next 按当前语言渲染；detail 保留不翻译的外部文本
// （系统与库错误、协议原文）。
//
// 边界：协议数据原样返回，不套 key——状态行、头部、SDP、hex、体内容等属于数据；只有我们
// 自己组织的句子（结论、提示、说明、请求/响应的文字描述）使用 key。

// networkTestText 生成前端可渲染的多语言文案字符串（用于阶段的响应说明等非错误字段）。
func networkTestText(key string, params map[string]any) string {
	data, err := json.Marshal(localizedError{Key: key, Params: params})
	if err != nil {
		return key
	}
	return string(data)
}

// networkTestError 返回只带 key 的用户可见错误。
func networkTestError(key string) error {
	return userError(key)
}

// networkTestErrorf 返回带插值参数的用户可见错误：key 之后按 "name", value 成对给出参数。
func networkTestErrorf(key string, pairs ...any) error {
	params := make(map[string]any, len(pairs)/2)
	for index := 0; index+1 < len(pairs); index += 2 {
		name, ok := pairs[index].(string)
		if !ok {
			continue
		}
		params[name] = pairs[index+1]
	}
	return userErrorParams(key, params)
}

// networkTestErrorCause 返回带外部原始文本的用户可见错误；原始文本不翻译，作为 detail 展示。
func networkTestErrorCause(key string, cause error) error {
	return userErrorCause(key, cause)
}

// networkTestErrorParamsCause 返回同时带插值参数与外部原始文本的用户可见错误。
func networkTestErrorParamsCause(key string, params map[string]any, cause error) error {
	return userErrorParamsCause(key, params, cause)
}
