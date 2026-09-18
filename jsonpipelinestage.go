package main

import (
	"context"
	"strings"
)

// pipelineStage 记录单个步骤的输入快照与输出。所有 JSONValue 都是不可变节点，
// 因此 stage 之间会共享未变化的子树，缓存是安全且可并发读取的。
type pipelineStage struct {
	Item   PipelineItem
	Input  *JSONValue
	Output *JSONValue
	Text   bool
	Error  *PipelineError
}

// pipelineRun 是一次完整评估的不可变结果，供结果事件、分页和补全复用。
type pipelineRun struct {
	Doc    *JSONValue
	Items  []PipelineItem
	Stages []pipelineStage
	Output *JSONValue
	Text   bool
	Error  *PipelineError
}

func (run *pipelineRun) stage(index int) *pipelineStage {
	if run == nil || index < 0 || index >= len(run.Stages) {
		return nil
	}
	return &run.Stages[index]
}

// runPipeline 执行流水线，并尽量复用 previous 中未受影响的前缀 stage。
func runPipeline(ctx context.Context, doc *JSONValue, items []PipelineItem, previous *pipelineRun) *pipelineRun {
	run := &pipelineRun{Doc: doc, Items: items}
	prefix := 0
	if previous != nil && previous.Doc == doc && previous.Error == nil {
		limit := len(previous.Items)
		if len(items) < limit {
			limit = len(items)
		}
		for prefix < limit && prefix < len(previous.Stages) {
			if !samePipelineExecution(previous.Items[prefix], items[prefix]) {
				break
			}
			if previous.Stages[prefix].Error != nil {
				break
			}
			prefix++
		}
	}
	run.Stages = append(run.Stages, previous.stagesPrefix(prefix)...)

	var value *JSONValue
	text := false
	if prefix > 0 {
		last := previous.Stages[prefix-1]
		value = last.Output
		text = last.Text
	} else {
		value = doc
	}
	if value == nil {
		// 前缀失效但缺少输出，退回全量执行。
		prefix = 0
		run.Stages = run.Stages[:0]
		value = doc
		text = false
	}

	for index := prefix; index < len(items); index++ {
		if ctx != nil && ctx.Err() != nil {
			run.Error = &PipelineError{Code: "cancelled"}
			return run
		}
		item := items[index]
		stage := pipelineStage{Item: item, Input: value}
		if item.Type == pipelineTypeTemplate && item.Enabled && hasEnabledAfter(items, index) {
			stage.Error = pipelineError("templateNotLast", index)
			run.Stages = append(run.Stages, stage)
			run.Error = stage.Error
			return run
		}
		if !item.Enabled {
			stage.Output = value
			stage.Text = text
			run.Stages = append(run.Stages, stage)
			continue
		}
		result, isText, failure := executePipelineItem(value, item, index)
		if failure != nil {
			stage.Error = failure
			run.Stages = append(run.Stages, stage)
			run.Error = failure
			return run
		}
		stage.Output = result
		stage.Text = isText
		run.Stages = append(run.Stages, stage)
		value = result
		text = isText
	}
	run.Output = value
	run.Text = text
	return run
}

func (run *pipelineRun) stagesPrefix(prefix int) []pipelineStage {
	if run == nil || prefix <= 0 {
		return nil
	}
	if prefix > len(run.Stages) {
		prefix = len(run.Stages)
	}
	return run.Stages[:prefix]
}

func hasEnabledAfter(items []PipelineItem, index int) bool {
	for next := index + 1; next < len(items); next++ {
		if items[next].Enabled {
			return true
		}
	}
	return false
}

// completionRoot 返回该步骤用于路径补全的输入节点。
func (stage *pipelineStage) completionRoot() *JSONValue { return stage.Input }

// completionItemRoot 返回数组排序/筛选的数组项代表节点。
func (stage *pipelineStage) completionItemRoot() *JSONValue {
	if stage.Item.Type != pipelineTypeArraySort && stage.Item.Type != pipelineTypeFilter {
		return stage.Input
	}
	tokens, err := parsePipelinePath(stage.Item.ArrayPath)
	if err != nil {
		return nil
	}
	target, err := readTokens(stage.Input, tokens, 0)
	if err != nil || !target.IsArray() {
		return nil
	}
	var firstNonNull *JSONValue
	for _, entry := range target.Arr {
		if entry.Kind == JSONNull {
			continue
		}
		if firstNonNull == nil {
			firstNonNull = entry
		}
		if entry.IsObject() || entry.IsArray() {
			return entry
		}
	}
	return firstNonNull
}

// completionFilterValues 返回筛选值补全的标量候选（未去重）。
func (stage *pipelineStage) completionFilterValues() []*JSONValue {
	if stage.Item.Type != pipelineTypeFilter {
		return nil
	}
	tokens, err := parsePipelinePath(stage.Item.ArrayPath)
	if err != nil {
		return nil
	}
	target, err := readTokens(stage.Input, tokens, 0)
	if err != nil || !target.IsArray() {
		return nil
	}
	itemTokens := []pathToken{}
	if trimmed := strings.TrimSpace(stage.Item.ItemPath); trimmed != "" {
		itemTokens, err = parsePipelinePath(stage.Item.ItemPath)
		if err != nil {
			return nil
		}
	}
	values := make([]*JSONValue, 0, len(target.Arr))
	for _, entry := range target.Arr {
		matched, ok := readOptionalTokens(entry, itemTokens)
		if !ok || !matched.IsScalar() {
			continue
		}
		values = append(values, matched)
	}
	return values
}
