package main

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	jsonPipelineProtocolVersion = 1
	jsonPipelinePreviewBytes    = 256 * 1024
	jsonPipelineMaxResults      = 8
	jsonPipelineMaxSessions     = 24
	jsonPipelineSessionTTL      = 30 * time.Minute
	jsonPipelineMaxTextBytes    = 64 * 1024 * 1024
	jsonPipelineTablePageLimit  = 200
	jsonPipelineCompletionLimit = 100
)

// PipelinePair 是文档版本与流水线版本的组合，结果必须精确匹配它。
type PipelinePair struct {
	DocID      uint64 `json:"docID"`
	PipelineID uint64 `json:"pipelineID"`
}

type PipelineSessionInfo struct {
	SessionID       string `json:"sessionID"`
	ProtocolVersion int    `json:"protocolVersion"`
	DocID           uint64 `json:"docID"`
	PipelineID      uint64 `json:"pipelineID"`
}

type UpdatePipelineStateRequest struct {
	SessionID      string         `json:"sessionID"`
	MutationID     uint64         `json:"mutationID"`
	BaseDocID      uint64         `json:"baseDocID"`
	BasePipelineID uint64         `json:"basePipelineID"`
	Source         *string        `json:"source"`
	Pipeline       []PipelineItem `json:"pipeline"`
}

type UpdatePipelineStateResult struct {
	SessionID       string `json:"sessionID"`
	MutationID      uint64 `json:"mutationID"`
	Accepted        bool   `json:"accepted"`
	Conflict        bool   `json:"conflict"`
	MissingSession  bool   `json:"missingSession"`
	DocID           uint64 `json:"docID"`
	PipelineID      uint64 `json:"pipelineID"`
	SourceChanged   bool   `json:"sourceChanged"`
	PipelineChanged bool   `json:"pipelineChanged"`
	Error           string `json:"error,omitempty"`
}

type PipelineResultPayload struct {
	SessionID       string         `json:"sessionID"`
	MutationID      uint64         `json:"mutationID"`
	ResultID        string         `json:"resultID"`
	DocID           uint64         `json:"docID"`
	PipelineID      uint64         `json:"pipelineID"`
	Status          string         `json:"status"`
	Error           *PipelineError `json:"error,omitempty"`
	Format          string         `json:"format"`
	PreviewText     string         `json:"previewText"`
	PreviewComplete bool           `json:"previewComplete"`
	TotalBytes      int            `json:"totalBytes"`
	TotalLines      int            `json:"totalLines"`
}

type ReadPipelineResultPageRequest struct {
	ResultID string `json:"resultID"`
	Offset   int    `json:"offset"`
	Limit    int    `json:"limit"`
}

type PipelineResultPage struct {
	Text       string `json:"text"`
	NextOffset int    `json:"nextOffset"`
	Complete   bool   `json:"complete"`
	Expired    bool   `json:"expired"`
}

type QueryPipelineCompletionRequest struct {
	SessionID  string `json:"sessionID"`
	DocID      uint64 `json:"docID"`
	PipelineID uint64 `json:"pipelineID"`
	ItemID     string `json:"itemID"`
	Field      string `json:"field"`
	Prefix     string `json:"prefix"`
	Limit      int    `json:"limit"`
}

type PipelineCompletionResponse struct {
	Stale bool               `json:"stale"`
	Items []CompletionOption `json:"items"`
}

type ReadPipelineTableRequest struct {
	ResultID string `json:"resultID"`
	Offset   int    `json:"offset"`
	Limit    int    `json:"limit"`
}

type PipelineTablePage struct {
	RowsJSON   string   `json:"rowsJSON"`
	Columns    []string `json:"columns"`
	Total      int      `json:"total"`
	NextOffset int      `json:"nextOffset"`
	Complete   bool     `json:"complete"`
	Expired    bool     `json:"expired"`
	Invalid    bool     `json:"invalid"`
}

type pipelineResult struct {
	id        string
	sessionID string
	pair      PipelinePair
	run       *pipelineRun
	textMu    sync.Mutex
	text      string
	textReady bool
	textSize  int
	textErr   string
}

type pipelineSession struct {
	mu           sync.Mutex
	id           string
	docID        uint64
	pipelineID   uint64
	source       string
	doc          *JSONValue
	docError     *PipelineError
	items        []PipelineItem
	run          *pipelineRun
	cancel       context.CancelFunc
	results      map[string]*pipelineResult
	resultOrder  []string
	resultSeq    uint64
	lastMutation uint64
	lastSeen     time.Time
}

type JSONPipelineService struct {
	mu       sync.Mutex
	sessions map[string]*pipelineSession
	ctx      context.Context
	cancel   context.CancelFunc
	emit     func(string, any)
	sequence atomic.Uint64
}

func NewJSONPipelineService() *JSONPipelineService {
	ctx, cancel := context.WithCancel(context.Background())
	return &JSONPipelineService{
		sessions: map[string]*pipelineSession{},
		ctx:      ctx,
		cancel:   cancel,
	}
}

func (s *JSONPipelineService) ServiceName() string                    { return "JSONPipelineService" }
func (s *JSONPipelineService) setEventEmitter(emit func(string, any)) { s.emit = emit }
func (s *JSONPipelineService) shutdown() {
	if s == nil {
		return
	}
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, session := range s.sessions {
		session.mu.Lock()
		if session.cancel != nil {
			session.cancel()
			session.cancel = nil
		}
		session.mu.Unlock()
	}
	s.sessions = map[string]*pipelineSession{}
}

// OpenPipelineSession 为一次流水线编辑会话分配随机不可复用的 ID。
func (s *JSONPipelineService) OpenPipelineSession() PipelineSessionInfo {
	id := fmt.Sprintf("jsonpipe-%d-%d", time.Now().UnixNano(), s.sequence.Add(1))
	session := &pipelineSession{
		id:       id,
		results:  map[string]*pipelineResult{},
		lastSeen: time.Now(),
	}
	s.mu.Lock()
	s.sessions[id] = session
	s.evictSessionsLocked()
	s.mu.Unlock()
	return PipelineSessionInfo{SessionID: id, ProtocolVersion: jsonPipelineProtocolVersion}
}

func (s *JSONPipelineService) ClosePipelineSession(sessionID string) {
	s.mu.Lock()
	session := s.sessions[sessionID]
	delete(s.sessions, sessionID)
	s.mu.Unlock()
	if session == nil {
		return
	}
	session.mu.Lock()
	if session.cancel != nil {
		session.cancel()
		session.cancel = nil
	}
	session.mu.Unlock()
}

func (s *JSONPipelineService) session(sessionID string) *pipelineSession {
	s.mu.Lock()
	defer s.mu.Unlock()
	session := s.sessions[sessionID]
	if session != nil {
		session.lastSeen = time.Now()
	}
	return session
}

func (s *JSONPipelineService) evictSessionsLocked() {
	if len(s.sessions) <= jsonPipelineMaxSessions {
		return
	}
	oldestID := ""
	var oldest time.Time
	for id, session := range s.sessions {
		if oldestID == "" || session.lastSeen.Before(oldest) {
			oldestID = id
			oldest = session.lastSeen
		}
	}
	if oldestID != "" {
		delete(s.sessions, oldestID)
	}
}

// UpdatePipelineState 是唯一的状态入口：source 变化才递增 docID，流水线变化才
// 递增 pipelineID，两者在同一个锁内原子提交。
func (s *JSONPipelineService) UpdatePipelineState(req UpdatePipelineStateRequest) UpdatePipelineStateResult {
	result := UpdatePipelineStateResult{
		SessionID:  req.SessionID,
		MutationID: req.MutationID,
	}
	session := s.session(req.SessionID)
	if session == nil {
		result.MissingSession = true
		result.Error = "sessionNotFound"
		return result
	}
	session.mu.Lock()
	if req.BaseDocID != session.docID || req.BasePipelineID != session.pipelineID {
		result.Conflict = true
		result.DocID = session.docID
		result.PipelineID = session.pipelineID
		session.mu.Unlock()
		return result
	}
	normalized := normalizePipelineItems(req.Pipeline)
	sourceChanged := req.Source != nil && *req.Source != session.source
	pipelineChanged := req.Pipeline != nil && !samePipelineList(session.items, normalized)
	if !sourceChanged && !pipelineChanged && session.run != nil {
		result.Accepted = true
		result.DocID = session.docID
		result.PipelineID = session.pipelineID
		session.mu.Unlock()
		return result
	}
	if sourceChanged {
		session.source = *req.Source
		session.docID++
		session.doc, session.docError = parsePipelineDocument(session.source)
	}
	if pipelineChanged {
		session.items = normalized
		session.pipelineID++
	}
	if session.cancel != nil {
		session.cancel()
		session.cancel = nil
	}
	ctx, cancel := context.WithCancel(s.ctx)
	session.cancel = cancel
	session.lastMutation = req.MutationID
	pair := PipelinePair{DocID: session.docID, PipelineID: session.pipelineID}
	doc := session.doc
	docError := session.docError
	items := append([]PipelineItem(nil), session.items...)
	previous := session.run
	empty := strings.TrimSpace(session.source) == ""
	session.mu.Unlock()

	go s.compute(req.SessionID, req.MutationID, pair, ctx, doc, docError, items, previous, empty)

	result.Accepted = true
	result.SourceChanged = sourceChanged
	result.PipelineChanged = pipelineChanged
	result.DocID = pair.DocID
	result.PipelineID = pair.PipelineID
	return result
}

func (s *JSONPipelineService) compute(sessionID string, mutationID uint64, pair PipelinePair, ctx context.Context, doc *JSONValue, docError *PipelineError, items []PipelineItem, previous *pipelineRun, empty bool) {
	var run *pipelineRun
	switch {
	case empty:
		run = &pipelineRun{Items: items}
	case docError != nil:
		run = &pipelineRun{Items: items, Error: docError}
	default:
		run = runPipeline(ctx, doc, items, previous)
	}
	if run != nil && run.Error != nil && run.Error.Code == "cancelled" {
		return
	}
	session := s.session(sessionID)
	if session == nil {
		return
	}
	session.mu.Lock()
	if session.docID != pair.DocID || session.pipelineID != pair.PipelineID {
		session.mu.Unlock()
		return
	}
	session.run = run
	if session.cancel != nil {
		session.cancel = nil
	}
	payload, result := sessionResultPayloadLocked(session, run, pair, mutationID)
	session.mu.Unlock()
	if s.emit != nil {
		s.emit("json-pipeline:result", payload)
	}
	_ = result
}

// sessionResultPayloadLocked 生成事件负载并注册结果句柄，调用方需持有 session 锁。
func sessionResultPayloadLocked(session *pipelineSession, run *pipelineRun, pair PipelinePair, mutationID uint64) (PipelineResultPayload, *pipelineResult) {
	payload := PipelineResultPayload{
		SessionID:  session.id,
		MutationID: mutationID,
		DocID:      pair.DocID,
		PipelineID: pair.PipelineID,
		Status:     "ok",
		Format:     "json",
	}
	if run != nil && run.Error != nil {
		payload.Status = "error"
		payload.Error = run.Error
	}
	resultID := fmt.Sprintf("%s:%d:%d:%d", session.id, pair.DocID, pair.PipelineID, session.resultSeq)
	session.resultSeq++
	result := &pipelineResult{id: resultID, sessionID: session.id, pair: pair, run: run}
	if run != nil && run.Error == nil {
		if run.Output == nil {
			// 空输入没有可序列化的结果，预览为空而不是 "null"。
			payload.PreviewComplete = true
		} else if run.Text {
			payload.Format = "text"
			full := ""
			if run.Output != nil {
				full = run.Output.Str
			}
			preview, truncated := truncateUTF8Bytes(full, jsonPipelinePreviewBytes)
			payload.PreviewText = preview
			payload.PreviewComplete = !truncated
			payload.TotalBytes = len(full)
			payload.TotalLines = countLines(full)
		} else {
			preview, truncated := boundedJSONPreview(run.Output, "  ", jsonPipelinePreviewBytes)
			bytes, lines := measureJSON(run.Output, "  ")
			payload.PreviewText = preview
			payload.PreviewComplete = !truncated
			payload.TotalBytes = bytes
			payload.TotalLines = lines
		}
	}
	payload.ResultID = resultID
	session.results[resultID] = result
	session.resultOrder = append(session.resultOrder, resultID)
	for len(session.resultOrder) > jsonPipelineMaxResults {
		oldest := session.resultOrder[0]
		session.resultOrder = session.resultOrder[1:]
		delete(session.results, oldest)
	}
	return payload, result
}

func (s *JSONPipelineService) findResult(resultID string) *pipelineResult {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, session := range s.sessions {
		session.mu.Lock()
		result := session.results[resultID]
		session.mu.Unlock()
		if result != nil {
			return result
		}
	}
	return nil
}

// GetPipelineResultText 显式读取完整结果文本，用于复制、导出与历史记录。
func (s *JSONPipelineService) GetPipelineResultText(resultID string) (string, error) {
	result := s.findResult(resultID)
	if result == nil {
		return "", fmt.Errorf("resultExpired")
	}
	return result.fullText()
}

func (result *pipelineResult) fullText() (string, error) {
	result.textMu.Lock()
	defer result.textMu.Unlock()
	if result.textReady {
		if result.textErr != "" {
			return "", fmt.Errorf("%s", result.textErr)
		}
		return result.text, nil
	}
	run := result.run
	if run == nil || run.Error != nil {
		result.textReady = true
		result.textErr = "resultUnavailable"
		return "", fmt.Errorf("resultUnavailable")
	}
	var text string
	if run.Output == nil {
		text = ""
	} else if run.Text {
		text = run.Output.Str
	} else {
		text = StringifyJSON(run.Output, "  ")
	}
	if len(text) > jsonPipelineMaxTextBytes {
		result.textReady = true
		result.textErr = "resultTooLarge"
		return "", fmt.Errorf("resultTooLarge")
	}
	result.text = text
	result.textSize = len(text)
	result.textReady = true
	return text, nil
}

// ReadPipelineResultPage 按 UTF-8 安全边界分页返回结果文本。
func (s *JSONPipelineService) ReadPipelineResultPage(req ReadPipelineResultPageRequest) PipelineResultPage {
	result := s.findResult(req.ResultID)
	if result == nil {
		return PipelineResultPage{Expired: true, Complete: true}
	}
	text, err := result.fullText()
	if err != nil {
		return PipelineResultPage{Expired: true, Complete: true}
	}
	limit := req.Limit
	if limit <= 0 || limit > 1<<20 {
		limit = 64 * 1024
	}
	offset := req.Offset
	if offset < 0 {
		offset = 0
	}
	if offset >= len(text) {
		return PipelineResultPage{Text: "", NextOffset: len(text), Complete: true}
	}
	end := offset + limit
	if end > len(text) {
		end = len(text)
	}
	for end < len(text) && end > offset && (text[end]&0xC0) == 0x80 {
		end--
	}
	return PipelineResultPage{
		Text:       text[offset:end],
		NextOffset: end,
		Complete:   end >= len(text),
	}
}

// ReadPipelineTablePage 返回结构化表格分页，避免前端解析完整输出字符串。
func (s *JSONPipelineService) ReadPipelineTablePage(req ReadPipelineTableRequest) PipelineTablePage {
	result := s.findResult(req.ResultID)
	if result == nil {
		return PipelineTablePage{Expired: true, Complete: true}
	}
	run := result.run
	if run == nil || run.Error != nil || run.Text || run.Output == nil || !run.Output.IsArray() {
		return PipelineTablePage{Invalid: true, Complete: true}
	}
	rows := run.Output.Arr
	total := len(rows)
	offset := req.Offset
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}
	limit := req.Limit
	if limit <= 0 || limit > jsonPipelineTablePageLimit {
		limit = jsonPipelineTablePageLimit
	}
	end := offset + limit
	if end > total {
		end = total
	}
	columns := []string{}
	seen := map[string]bool{}
	for _, row := range rows {
		if row.IsObject() {
			for _, member := range row.Obj {
				if !seen[member.Key] {
					seen[member.Key] = true
					columns = append(columns, member.Key)
				}
			}
		}
	}
	page := newJSONArray(rows[offset:end])
	return PipelineTablePage{
		RowsJSON:   StringifyJSON(page, ""),
		Columns:    columns,
		Total:      total,
		NextOffset: end,
		Complete:   end >= total,
	}
}

// QueryPipelineCompletion 基于缓存的 stage 输入回答补全查询，不回传完整 AST。
func (s *JSONPipelineService) QueryPipelineCompletion(req QueryPipelineCompletionRequest) PipelineCompletionResponse {
	response := PipelineCompletionResponse{Items: []CompletionOption{}}
	session := s.session(req.SessionID)
	if session == nil {
		response.Stale = true
		return response
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.docID != req.DocID || session.pipelineID != req.PipelineID {
		response.Stale = true
		return response
	}
	run := session.run
	if run == nil {
		return response
	}
	limit := req.Limit
	if limit <= 0 || limit > jsonPipelineCompletionLimit {
		limit = jsonPipelineCompletionLimit
	}
	var stage *pipelineStage
	for index := range run.Stages {
		if run.Stages[index].Item.ID == req.ItemID {
			stage = &run.Stages[index]
			break
		}
	}
	// 步骤自身报错（例如筛选值未填）不应阻止其输入路径的补全，只要输入快照存在。
	if stage == nil || stage.Input == nil {
		return response
	}
	switch req.Field {
	case "filterValue":
		options := valueCompletionOptions(stage.completionFilterValues(), req.Prefix, limit)
		response.Items = options
	default:
		root := stage.completionRoot()
		if req.Field == "itemPath" {
			root = stage.completionItemRoot()
		}
		options := propertyCompletionOptions(root, req.Prefix)
		if len(options) > limit {
			options = options[:limit]
		}
		response.Items = options
	}
	return response
}

// pipelineForCompletion 仅供测试使用，返回当前 run。
func (session *pipelineSession) pipelineForCompletion() *pipelineRun {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.run
}

func normalizePipelineItems(items []PipelineItem) []PipelineItem {
	if items == nil {
		return nil
	}
	normalized := make([]PipelineItem, len(items))
	for index, item := range items {
		normalized[index] = normalizePipelineItem(item)
	}
	return normalized
}

func samePipelineList(a, b []PipelineItem) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if !samePipelineExecution(a[index], b[index]) {
			return false
		}
	}
	return true
}

func parsePipelineDocument(source string) (*JSONValue, *PipelineError) {
	if strings.TrimSpace(source) == "" {
		return nil, nil
	}
	value, err := ParseJSONLoose(source)
	if err != nil {
		return nil, &PipelineError{Code: "invalidJson"}
	}
	return value, nil
}

func countLines(value string) int {
	if value == "" {
		return 0
	}
	return strings.Count(value, "\n") + 1
}
