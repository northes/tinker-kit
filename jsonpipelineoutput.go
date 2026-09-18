package main

import "strings"

// jsonWriteSink 让序列化可以写入统计或限流目标，而不是必须构造完整字符串。
type jsonWriteSink interface {
	WriteString(string) (int, error)
	WriteByte(byte) error
}

type boundedJSONSink struct {
	builder   strings.Builder
	limit     int
	truncated bool
}

func (sink *boundedJSONSink) WriteString(value string) (int, error) {
	return sink.write(value)
}

func (sink *boundedJSONSink) WriteByte(value byte) error {
	_, err := sink.write(string(value))
	return err
}

func (sink *boundedJSONSink) write(value string) (int, error) {
	if sink.limit <= 0 {
		sink.builder.WriteString(value)
		return len(value), nil
	}
	remaining := sink.limit - sink.builder.Len()
	if remaining <= 0 {
		sink.truncated = true
		return len(value), nil
	}
	if len(value) > remaining {
		sink.builder.WriteString(value[:remaining])
		sink.truncated = true
		return len(value), nil
	}
	sink.builder.WriteString(value)
	return len(value), nil
}

type countingJSONSink struct {
	bytes int
	lines int
}

func (sink *countingJSONSink) WriteString(value string) (int, error) {
	sink.bytes += len(value)
	sink.lines += strings.Count(value, "\n")
	return len(value), nil
}

func (sink *countingJSONSink) WriteByte(value byte) error {
	sink.bytes++
	if value == '\n' {
		sink.lines++
	}
	return nil
}

// boundedJSONPreview 生成有字节预算的预览，超出预算时标记 truncated。
func boundedJSONPreview(value *JSONValue, indent string, limit int) (string, bool) {
	if limit <= 0 {
		return StringifyJSON(value, indent), false
	}
	sink := &boundedJSONSink{limit: limit}
	writeJSONValue(sink, value, indent, 0)
	return sink.builder.String(), sink.truncated
}

// measureJSON 统计完整序列化的字节数与行数，不构造完整字符串。
func measureJSON(value *JSONValue, indent string) (int, int) {
	sink := &countingJSONSink{}
	writeJSONValue(sink, value, indent, 0)
	return sink.bytes, sink.lines
}

// truncateUTF8Bytes 按 UTF-8 边界截断字符串。
func truncateUTF8Bytes(value string, limit int) (string, bool) {
	if limit <= 0 || len(value) <= limit {
		return value, false
	}
	cut := limit
	for cut > 0 && (value[cut]&0xC0) == 0x80 {
		cut--
	}
	return value[:cut], true
}
