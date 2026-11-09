package main

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestRemoteSearchResultsStreamsNulFramesInDiscoveryOrder(t *testing.T) {
	root := t.TempDir()
	paths := []string{filepath.Join(root, "z.txt"), filepath.Join(root, "a\nname.txt")}
	for _, path := range paths {
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var batches [][]RemoteFileEntry
	results := &remoteSearchResults{ctx: context.Background(), stat: os.Lstat, emit: func(batch []RemoteFileEntry) {
		batches = append(batches, batch)
	}}
	if _, err := results.Write([]byte(paths[0] + "\x00" + paths[1][:len(paths[1])/2])); err != nil {
		t.Fatal(err)
	}
	if len(batches) != 1 || batches[0][0].Path != paths[0] {
		t.Fatalf("后续输出未到达时就应发出首项: %#v", batches)
	}
	if _, err := results.Write([]byte(paths[1][len(paths[1])/2:] + "\x00" + paths[0] + "\x00\x00/\x00" + filepath.Join(root, "missing") + "\x00")); err != nil {
		t.Fatal(err)
	}
	results.flush()
	got := []string{results.entries[0].Path, results.entries[1].Path}
	if !reflect.DeepEqual(got, paths) || len(results.entries) != 2 || len(batches) != 2 {
		t.Fatalf("须保留发现顺序、跨块路径与换行，且去重并跳过已消失文件: %#v", results.entries)
	}
}

func TestRemoteSearchResultsStopsAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	results := &remoteSearchResults{ctx: ctx, stat: func(string) (os.FileInfo, error) {
		t.Fatal("取消后不应读取元数据")
		return nil, nil
	}, emit: func([]RemoteFileEntry) { t.Fatal("取消后不应推送结果") }}
	if _, err := results.Write([]byte("/file\x00")); !errors.Is(err, context.Canceled) {
		t.Fatalf("应传播取消: %v", err)
	}
}

func TestRemoteSearchResultsCancelsCommandOnMetadataError(t *testing.T) {
	ctx := context.Background()
	commandCtx, cancelCommand := context.WithCancel(ctx)
	defer cancelCommand()
	results := &remoteSearchResults{ctx: ctx, cancel: cancelCommand, stat: func(string) (os.FileInfo, error) {
		return nil, os.ErrPermission
	}}
	if _, err := results.Write([]byte("/unreadable\x00")); err == nil || results.err == nil {
		t.Fatal("元数据错误应返回给调用者")
	}
	if commandCtx.Err() == nil || ctx.Err() != nil {
		t.Fatal("元数据错误只应停止远端命令，不能伪装成用户主动取消")
	}
}

func TestRemoteSearchCommandsExecuteWithNulOutput(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	query := "-needle'"
	direct := filepath.Join(root, "z"+query+"\nfile")
	nested := filepath.Join(root, "nested", "a"+query)
	hidden := filepath.Join(root, ".hidden"+query)
	if err := os.Mkdir(filepath.Dir(nested), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{direct, nested, hidden} {
		if err := os.WriteFile(path, []byte(query), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	fallbackPath := t.TempDir()
	for _, name := range []string{"sh", "find", "grep", "printf"} {
		path, err := exec.LookPath(name)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(path, filepath.Join(fallbackPath, name)); err != nil {
			t.Fatal(err)
		}
	}
	for _, fallback := range []bool{false, true} {
		for _, mode := range []string{remoteFileSearchName, remoteFileSearchContent} {
			for _, scope := range []string{remoteFileSearchScopeCurrent, remoteFileSearchScopeRecursive} {
				t.Run(strconv.FormatBool(fallback)+"/"+mode+"/"+scope, func(t *testing.T) {
					ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
					defer cancel()
					command := exec.CommandContext(ctx, "sh", "-c", remoteSearchCommand(query, root, mode, scope, false))
					if fallback {
						command.Env = append(os.Environ(), "PATH="+fallbackPath)
					}
					results := &remoteSearchResults{ctx: ctx, stat: os.Lstat}
					command.Stdout = results
					if err := command.Run(); err != nil {
						t.Fatalf("搜索命令执行失败: %v", err)
					}
					got := make([]string, 0, len(results.entries))
					for _, entry := range results.entries {
						got = append(got, entry.Path)
					}
					want := []string{direct}
					if scope == remoteFileSearchScopeRecursive {
						want = append(want, nested)
					}
					sort.Strings(got)
					sort.Strings(want)
					if !reflect.DeepEqual(got, want) {
						t.Fatalf("含引号、前导横线和换行的搜索结果 = %#v, want %#v", got, want)
					}
				})
			}
		}
	}
}

func TestSearchRemoteFilesEmitsBeforeCommandFinishes(t *testing.T) {
	for _, outcome := range []string{"complete", "cancel", "failure"} {
		t.Run(outcome, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			root := t.TempDir()
			paths := []string{filepath.Join(root, "z.txt"), filepath.Join(root, "m.txt"), filepath.Join(root, "a.txt")}
			for _, path := range paths {
				if err := os.WriteFile(path, nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			resume := make(chan struct{})
			server := startTestSFTPServer(t, "user", "secret", root, func(channel ssh.Channel, _ string) {
				_, _ = channel.Write([]byte(paths[0] + "\x00" + paths[1] + "\x00"))
				select {
				case <-resume:
				case <-ctx.Done():
					return
				}
				status := uint32(0)
				if outcome == "failure" {
					_, _ = channel.Stderr().Write([]byte("search interrupted"))
					status = 1
				} else {
					_, _ = channel.Write([]byte(paths[2] + "\x00"))
				}
				_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
			})
			trustTestSSHHosts(t)
			host, portText, _ := net.SplitHostPort(server.address)
			port, _ := strconv.Atoi(portText)
			service := NewFileService(&ConfigService{cfg: normalizeConfig(Config{
				SSHProfiles: []SSHProfile{{ID: "profile", Host: host, Port: port, Username: "user", Password: "secret"}},
				FileSources: []FileSource{{ID: "source", SSHProfileID: "profile"}},
			})})
			events := make(chan RemoteSearchBatch, 8)
			service.emitEvent = func(name string, payload any) {
				if name == remoteSearchResultsEventName {
					events <- payload.(RemoteSearchBatch)
				}
			}
			type result struct {
				entries []RemoteFileEntry
				err     error
			}
			done := make(chan result, 1)
			go func() {
				entries, err := service.SearchRemoteFiles(ctx, "source", root, "txt", "name", "recursive", false, "request")
				done <- result{entries, err}
			}()
			select {
			case event := <-events:
				if event.RequestID != "request" || len(event.Entries) != 1 || event.Entries[0].Path != paths[0] {
					t.Fatalf("首批事件错误: %#v", event)
				}
			case result := <-done:
				t.Fatalf("首批事件到达前搜索已结束: %v", result.err)
			case <-ctx.Done():
				t.Fatal("搜索命令尚未结束时应发出首批结果")
			}
			select {
			case event := <-events:
				if len(event.Entries) != 1 || event.Entries[0].Path != paths[1] {
					t.Fatalf("输出暂停时仍须定时推送未满批次的结果: %#v", event)
				}
			case <-ctx.Done():
				t.Fatal("零散结果不应等待后续输出或命令结束")
			}
			if outcome == "cancel" {
				cancel()
			} else {
				close(resume)
			}
			select {
			case result := <-done:
				switch outcome {
				case "complete":
					if result.err != nil || len(result.entries) != 3 || result.entries[0].Path != paths[0] || result.entries[1].Path != paths[1] || result.entries[2].Path != paths[2] {
						t.Fatalf("最终结果应与事件发现顺序一致: %#v, %v", result.entries, result.err)
					}
				case "cancel":
					if result.err != nil {
						t.Fatalf("取消的 Wails 调用不应返回错误: %v", result.err)
					}
				case "failure":
					if result.err == nil || len(result.entries) != 2 {
						t.Fatalf("失败应保留已找到结果并返回错误: %#v, %v", result.entries, result.err)
					}
				}
			case <-time.After(3 * time.Second):
				t.Fatal("搜索结束或取消后未及时返回")
			}
		})
	}
}
