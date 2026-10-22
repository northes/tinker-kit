package main

import (
	"bytes"
	"context"
	"sort"
	"strings"

	"github.com/pkg/sftp"
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
  grep -lIZ -i -F -e "$query" "$file"
  status=$?
  if [ "$status" -gt 1 ]; then
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
			findStatus += "find \"$item\" -prune -iname " + pattern + " -print0"
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
	return command + " -iname " + pattern + " -print0"
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
		fdCommand += " -- " + shellQuote(query) + " " + shellQuote(root)
		return "if command -v fd >/dev/null 2>&1; then " + fdCommand + "; else " +
			remoteSearchFindCommand(query, root, searchMode, searchScope, showHidden) + "; fi"
	}

	rgCommand := "rg --files-with-matches --null --fixed-strings --ignore-case --no-ignore"
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

func parseRemoteSearchPaths(output []byte) []string {
	paths := make([]string, 0)
	seen := make(map[string]struct{})
	for _, rawPath := range bytes.Split(output, []byte{0}) {
		if len(rawPath) == 0 {
			continue
		}
		remotePath := normalizedRemotePath(string(rawPath))
		if remotePath == "/" {
			continue
		}
		if _, ok := seen[remotePath]; ok {
			continue
		}
		seen[remotePath] = struct{}{}
		paths = append(paths, remotePath)
	}
	return paths
}

// remoteSearchEntries 只读取远程搜索结果的元数据，不参与文件内容匹配。
func remoteSearchEntries(ctx context.Context, client *sftp.Client, output []byte) ([]RemoteFileEntry, error) {
	paths := parseRemoteSearchPaths(output)
	result := make([]RemoteFileEntry, 0, len(paths))
	for _, remotePath := range paths {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		info, err := client.Lstat(remotePath)
		if err != nil {
			if isRemoteNotFound(err) {
				continue
			}
			return nil, userErrorParamsCause("errors.sshFile.readSearchResultFailed", map[string]any{"path": remotePath}, err)
		}
		result = append(result, remoteFileEntryFromInfo(remotePath, info, ""))
	}
	sort.SliceStable(result, func(i, j int) bool {
		left, right := strings.ToLower(result[i].Path), strings.ToLower(result[j].Path)
		if left == right {
			return result[i].Path < result[j].Path
		}
		return left < right
	})
	return result, nil
}

// SearchRemoteFiles 在远程文件源中使用远程 fd/find 或 rg/grep 搜索。
// searchScope 为 current（仅当前目录）或 recursive（从当前目录开始递归）。
// 搜索结果只在远端生成，当前设备不读取远程文件内容。
func (s *FileService) SearchRemoteFiles(
	ctx context.Context,
	sourceID, currentPath, query, searchMode, searchScope string,
	showHidden bool,
) ([]RemoteFileEntry, error) {
	query = strings.TrimSpace(query)
	if !validTextValue(query, 4096) {
		return nil, userError("errors.sshFile.searchQueryInvalid")
	}
	searchMode, err := normalizeRemoteSearchMode(searchMode)
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
	ctx, cancel := context.WithTimeout(ctx, remoteFileSearchTimeout)
	defer cancel()
	sshClient, client, err := s.dialSFTP(ctx, conn)
	if err != nil {
		return nil, err
	}
	defer closeSSHClient(sshClient)
	defer client.Close()

	root, err := resolveRemoteDirectory(client, currentPath)
	if err != nil {
		return nil, err
	}
	output, err := runRemoteCommandOutput(
		ctx,
		conn,
		sshClient,
		remoteSearchCommand(query, root, searchMode, searchScope, showHidden),
	)
	if err != nil {
		return nil, userErrorCause("errors.sshFile.searchFailed", err)
	}
	return remoteSearchEntries(ctx, client, output)
}
