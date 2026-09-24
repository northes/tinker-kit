package main

import (
	"encoding/json"
	"errors"
)

// localizedError 是返回给前端的用户可见错误。
//
// 约定：Go 只返回多语言 key 与插值参数，具体语言由前端 i18next 渲染。
// detail 保存原始外部错误（来自系统、第三方库等）的文本，原样展示、不翻译；
// cause 仅用于保留 errors.Is / errors.As 的错误链，不参与序列化。
type localizedError struct {
	Key    string         `json:"key"`
	Params map[string]any `json:"params,omitempty"`
	Detail string         `json:"detail,omitempty"`

	cause error
}

func (e *localizedError) Error() string {
	data, err := json.Marshal(e)
	if err != nil {
		return e.Key
	}
	return string(data)
}

func (e *localizedError) Unwrap() error { return e.cause }

// userError 返回只带 key 的用户可见错误，key 指向 frontend/src/locales 中的文案。
func userError(key string) error {
	return &localizedError{Key: key}
}

// userErrorParams 返回带插值参数的用户可见错误。
func userErrorParams(key string, params map[string]any) error {
	return &localizedError{Key: key, Params: params}
}

// userErrorCause 返回附带原始外部错误文本的用户可见错误；原始文本不翻译。
func userErrorCause(key string, cause error) error {
	context := &localizedError{Key: key, cause: cause}
	if cause != nil {
		context.Detail = cause.Error()
	}
	return context
}

// userErrorParamsCause 返回同时带插值参数与原始外部错误文本的用户可见错误。
func userErrorParamsCause(key string, params map[string]any, cause error) error {
	context := &localizedError{Key: key, Params: params, cause: cause}
	if cause != nil {
		context.Detail = cause.Error()
	}
	return context
}

// localizedErrorKey 返回错误链中最内层用户可见错误的 key，非用户可见错误返回空串。
// 仅用于测试断言与内部判断。
func localizedErrorKey(err error) string {
	var target *localizedError
	if errors.As(err, &target) {
		return target.Key
	}
	return ""
}
