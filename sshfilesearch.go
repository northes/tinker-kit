package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"time"
)

func normalizeRemoteSearchMode(value string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case remoteFileSearchName, "filename":
		return remoteFileSearchName, nil
	case remoteFileSearchContent:
		return remoteFileSearchContent, nil
	default:
		return "", userError("errors.sshFile.searchModeInvalid")
	}
}

func normalizeRemoteSearchScope(value string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case remoteFileSearchScopeCurrent, "current-directory":
		return remoteFileSearchScopeCurrent, nil
	case remoteFileSearchScopeRecursive, "from-current":
		return remoteFileSearchScopeRecursive, nil
	default:
		return "", userError("errors.sshFile.searchScopeInvalid")
	}
}

func remoteFindFilenamePattern(query string) string {
	var pattern strings.Builder
	pattern.Grow(len(query) + 2)
	pattern.WriteByte('*')
	for _, character := range query {
		switch character {
		case '\\', '*', '?', '[', ']':
			pattern.WriteByte('\\')
		}
		pattern.WriteRune(character)
	}
	pattern.WriteByte('*')
	return pattern.String()
}

func remoteSearchDirectItems(root string, showHidden bool) string {
	items := []string{shellQuote(root) + "/*"}
	if showHidden {
		items = append(items, shellQuote(root)+"/.[!.]*", shellQuote(root)+"/..?*")
	}
	return strings.Join(items, " ")
}

func remoteSearchGrepExec(query string) string {
	script := `query=$1
shift
for file
do
  grep -qI -i -F -e "$query" "$file"
  status=$?
  if [ "$status" -eq 0 ]; then
    printf '%s\0' "$file"
  elif [ "$status" -gt 1 ]; then
    exit "$status"
  fi
done
exit 0`
	return "-exec sh -c " + shellQuote(script) + " sh " + shellQuote(query) + " {} +"
}

func remoteSearchFindCommand(query, root, searchMode, searchScope string, showHidden bool) string {
	pattern := shellQuote(remoteFindFilenamePattern(query))
	if searchScope == remoteFileSearchScopeCurrent {
		directItems := remoteSearchDirectItems(root, showHidden)
		findStatus := "findStatus=0; for item in " + directItems +
			"; do if [ -e \"$item\" ] || [ -L \"$item\" ]; then "
		if searchMode == remoteFileSearchContent {
			findStatus += "find \"$item\" -prune -type f " + remoteSearchGrepExec(query)
		} else {
			findStatus += "find \"$item\" -prune -iname " + pattern + ` -exec printf '%s\0' {} \;`
		}
		return findStatus + " || findStatus=$?; fi; done; exit \"$findStatus\""
	}

	command := "find " + shellQuote(root)
	if !showHidden {
		command += " ! -path " + shellQuote(root) + " -name '.*' -prune -o"
	}
	command += " ! -path " + shellQuote(root)
	if searchMode == remoteFileSearchContent {
		return command + " -type f " + remoteSearchGrepExec(query)
	}
	return command + " -iname " + pattern + ` -exec printf '%s\0' {} \;`
}

func remoteSearchCommand(query, root, searchMode, searchScope string, showHidden bool) string {
	recursive := searchScope == remoteFileSearchScopeRecursive
	if searchMode == remoteFileSearchName {
		fdCommand := "fd --absolute-path --ignore-case --fixed-strings --no-ignore --print0 --min-depth 1"
		if !recursive {
			fdCommand += " --max-depth 1"
		}
		if showHidden {
			fdCommand += " --hidden"
		}
		// 每项独立输出，避免 fd 在管道缓冲中积攒结果直到搜索结束。
		fdCommand += ` --exec printf '%s\0' {} ';' -- ` + shellQuote(query) + " " + shellQuote(root)
		return "if command -v fd >/dev/null 2>&1; then " + fdCommand + "; else " +
			remoteSearchFindCommand(query, root, searchMode, searchScope, showHidden) + "; fi"
	}

	rgCommand := "rg --files-with-matches --null --fixed-strings --ignore-case --no-ignore --line-buffered"
	if !recursive {
		rgCommand += " --max-depth 1"
	}
	if showHidden {
		rgCommand += " --hidden"
	}
	rgCommand += " -- " + shellQuote(query) + " " + shellQuote(root)
	rgCommand = "status=0; " + rgCommand +
		"; status=$?; if [ \"$status\" -eq 1 ]; then exit 0; fi; exit \"$status\""
	return "if command -v rg >/dev/null 2>&1; then " + rgCommand + "; else " +
		remoteSearchFindCommand(query, root, searchMode, searchScope, showHidden) + "; fi"
}

const (
	remoteSearchBatchSize     = 64
	remoteSearchBatchInterval = 80 * time.Millisecond
)

// RemoteSearchBatch 仅携带本次搜索新发现的项目，requestID 隔离不同窗口和过期搜索。
type RemoteSearchBatch struct {
	RequestID string            `json:"requestID"`
	Entries   []RemoteFileEntry `json:"entries"`
}

// remoteSearchResults 以 NUL 分帧，跨 stdout 分块保留未完成路径；文件内容仍只在远端匹配。
type remoteSearchResults struct {
	mu       sync.Mutex
	ctx      context.Context
	cancel   context.CancelFunc
	err      error
	stat     func(string) (os.FileInfo, error)
	emit     func([]RemoteFileEntry)
	pending  []byte
	seen     map[string]struct{}
	entries  []RemoteFileEntry
	batch    []RemoteFileEntry
	lastEmit time.Time
}

func (r *remoteSearchResults) flush() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.flushLocked()
}

func (r *remoteSearchResults) flushLocked() {
	if len(r.batch) == 0 || r.ctx.Err() != nil {
		return
	}
	if r.emit != nil {
		r.emit(r.batch)
	}
	r.batch = nil
	r.lastEmit = time.Now()
}

func (r *remoteSearchResults) Write(data []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pending = append(r.pending, data...)
	for {
		if err := r.ctx.Err(); err != nil {
			return 0, err
		}
		end := bytes.IndexByte(r.pending, 0)
		if end < 0 {
			return len(data), nil
		}
		path := string(r.pending[:end])
		r.pending = r.pending[end+1:]
		if path == "" {
			continue
		}
		path = normalizedRemotePath(path)
		if path == "/" {
			continue
		}
		if r.seen == nil {
			r.seen = make(map[string]struct{})
		}
		if _, found := r.seen[path]; found {
			continue
		}
		r.seen[path] = struct{}{}
		info, err := r.stat(path)
		if err != nil {
			if isRemoteNotFound(err) {
				continue
			}
			r.err = userErrorParamsCause("errors.sshFile.readSearchResultFailed", map[string]any{"path": path}, err)
			// stdout 消费失败时同时停止远端命令，避免其输出阻塞后无法退出。
			if r.cancel != nil {
				r.cancel()
			}
			return 0, r.err
		}
		entry := remoteFileEntryFromInfo(path, info, "")
		r.entries = append(r.entries, entry)
		r.batch = append(r.batch, entry)
		// 首项立即展示；大量输出按数量和元数据读取耗时合并事件。
		if len(r.entries) == 1 || len(r.batch) >= remoteSearchBatchSize || time.Since(r.lastEmit) >= remoteSearchBatchInterval {
			r.flushLocked()
		}
	}
}

// SearchRemoteFiles 在远程文件源中使用远程 fd/find 或 rg/grep 搜索。
// searchScope 为 current（仅当前目录）或 recursive（从当前目录开始递归）。
// 搜索结果只在远端生成，当前设备不读取远程文件内容。
func (s *FileService) SearchRemoteFiles(
	ctx context.Context,
	sourceID, currentPath, query, searchMode, searchScope string,
	showHidden bool,
	requestID string,
) (entries []RemoteFileEntry, err error) {
	ctx, cancel := context.WithTimeout(ctx, remoteFileSearchTimeout)
	defer cancel()
	defer func() {
		if errors.Is(ctx.Err(), context.Canceled) {
			entries, err = nil, nil
		}
	}()
	query = strings.TrimSpace(query)
	if !validTextValue(query, 4096) {
		return nil, userError("errors.sshFile.searchQueryInvalid")
	}
	searchMode, err = normalizeRemoteSearchMode(searchMode)
	if err != nil {
		return nil, err
	}
	searchScope, err = normalizeRemoteSearchScope(searchScope)
	if err != nil {
		return nil, err
	}
	_, conn, err := s.sourceSnapshot(strings.TrimSpace(sourceID))
	if err != nil {
		return nil, err
	}
	sshClient, client, err := s.dialSFTP(ctx, conn)
	if err != nil {
		return nil, err
	}
	defer closeSSHClient(sshClient)
	defer client.Close()
	// 搜索使用独立会话；取消时关闭它，解除在途元数据读取和命令输出的阻塞。
	stopCancel := context.AfterFunc(ctx, func() {
		_ = client.Close()
		closeSSHClient(sshClient)
	})
	defer stopCancel()

	root, err := resolveRemoteDirectory(client, currentPath)
	if err != nil {
		return nil, err
	}
	commandCtx, cancelCommand := context.WithCancel(ctx)
	defer cancelCommand()
	results := &remoteSearchResults{
		ctx:    ctx,
		cancel: cancelCommand,
		stat:   client.Lstat,
		emit: func(batch []RemoteFileEntry) {
			if s.emitEvent != nil {
				s.emitEvent(remoteSearchResultsEventName, RemoteSearchBatch{RequestID: requestID, Entries: batch})
			}
		},
	}
	// 首项立即发出；后续批次也会定时刷新，避免零散结果等到下一项才出现。
	ticker := time.NewTicker(remoteSearchBatchInterval)
	defer ticker.Stop()
	stopFlush := make(chan struct{})
	flushDone := make(chan struct{})
	go func() {
		defer close(flushDone)
		for {
			select {
			case <-ticker.C:
				results.flush()
			case <-stopFlush:
				return
			}
		}
	}()
	err = runRemoteCommandToWriter(
		commandCtx,
		conn,
		sshClient,
		remoteSearchCommand(query, root, searchMode, searchScope, showHidden),
		results,
	)
	close(stopFlush)
	<-flushDone
	results.flush()
	if results.err != nil {
		return results.entries, results.err
	}
	if err != nil {
		return results.entries, userErrorCause("errors.sshFile.searchFailed", err)
	}
	return results.entries, nil
}
