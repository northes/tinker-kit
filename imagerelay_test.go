package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// 子进程只读测试夹具，不调用 Docker、SSH、配置或外网。
func TestImageRelayProcess(t *testing.T) {
	if os.Getenv("TK_RELAY_HELPER") != "1" {
		return
	}
	args := os.Args
	for len(args) > 0 && args[0] != "--" {
		args = args[1:]
	}
	command := strings.Join(args[1:], " ")
	log, _ := os.OpenFile(os.Getenv("TK_RELAY_COMMANDS"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if log != nil {
		_, _ = fmt.Fprintln(log, command)
		_ = log.Close()
	}
	command = strings.ReplaceAll(command, "'", "")
	mode := os.Getenv("TK_RELAY_MODE")
	if strings.Contains(command, "image pull") {
		if mode == "cancel-pull" {
			_ = os.WriteFile(os.Getenv("TK_RELAY_READY"), nil, 0600)
			time.Sleep(time.Hour)
		}
		fmt.Println("aabb: Pull complete")
		os.Exit(0)
	}
	if strings.Contains(command, "image save") {
		fmt.Fprintln(os.Stderr, "local save diagnostic")
		if mode == "save-failure" || mode == "missing-platform" || mode == "old-cli" {
			fmt.Fprintln(os.Stderr, "requested platform unavailable or unsupported")
			os.Exit(9)
		}
		if mode == "cancel-transfer" || mode == "load-failure" {
			_ = os.WriteFile(os.Getenv("TK_RELAY_READY"), nil, 0600)
			time.Sleep(time.Hour)
		}
		data, _ := os.ReadFile(os.Getenv("TK_RELAY_PAYLOAD"))
		_, err := os.Stdout.Write(data)
		if err != nil {
			os.Exit(7)
		}
		os.Exit(0)
	}
	if strings.Contains(command, "image load") {
		if mode == "load-failure" || mode == "load-failure-stream" {
			if mode == "load-failure" {
				for {
					if _, err := os.Stat(os.Getenv("TK_RELAY_READY")); err == nil {
						break
					}
					time.Sleep(time.Millisecond)
				}
			}
			fmt.Fprintln(os.Stderr, "target load denied")
			os.Exit(8)
		}
		out, err := os.Create(os.Getenv("TK_RELAY_CAPTURE"))
		if err != nil {
			os.Exit(6)
		}
		_, err = io.Copy(out, os.Stdin)
		_ = out.Close()
		if err != nil {
			os.Exit(5)
		}
		os.Exit(0)
	}
	os.Exit(4)
}

func relayProcessFixture(t *testing.T, mode string) (*ImageService, []byte, string, string) {
	t.Helper()
	dir := t.TempDir()
	payload := bytes.Repeat([]byte{0, 1, 255, '\n', '\r', 128, 42}, 600000)
	payloadPath := filepath.Join(dir, "payload")
	if err := os.WriteFile(payloadPath, payload, 0600); err != nil {
		t.Fatal(err)
	}
	capture := filepath.Join(dir, "capture")
	commands := filepath.Join(dir, "commands")
	ready := filepath.Join(dir, "ready")
	original := execCommandContext
	var processes []*exec.Cmd
	var mu sync.Mutex
	execCommandContext = func(ctx context.Context, _ string, args ...string) *exec.Cmd {
		cmd := exec.CommandContext(ctx, os.Args[0], append([]string{"-test.run=^TestImageRelayProcess$", "--"}, args...)...)
		cmd.Env = append(os.Environ(), "TK_RELAY_HELPER=1", "TK_RELAY_MODE="+mode,
			"TK_RELAY_PAYLOAD="+payloadPath, "TK_RELAY_CAPTURE="+capture,
			"TK_RELAY_READY="+ready, "TK_RELAY_COMMANDS="+commands)
		// 构造阶段可能在 save goroutine 中，回收检查放在所有调用结束后。
		mu.Lock()
		processes = append(processes, cmd)
		mu.Unlock()
		return cmd
	}
	t.Cleanup(func() {
		execCommandContext = original
		for _, cmd := range processes {
			if cmd.Process != nil && cmd.ProcessState == nil {
				t.Errorf("进程尚未 Wait 回收: %v", cmd.Args)
				_ = cmd.Process.Kill()
			}
		}
	})
	s := &ImageService{tasks: map[string]*imageTaskState{}}
	return s, payload, capture, ready
}

func cancelRelayWhenReady(t *testing.T, ctx context.Context, cancel context.CancelFunc, ready string) <-chan struct{} {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			if _, err := os.Stat(ready); err == nil {
				cancel()
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return done
}

func TestImagePullCanceledProcessIsCanceled(t *testing.T) {
	s, _, _, ready := relayProcessFixture(t, "cancel-pull")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := cancelRelayWhenReady(t, ctx, cancel, ready)
	id := s.createImageTask(imageTaskState{ImageTask: ImageTask{Type: imageTaskTypePull}})
	s.runImagePull(ctx, id, "example:latest", ImageSource{Kind: "local"}, "fake-docker", ImagePullOptions{})
	<-done
	task := s.GetImageTasks().Tasks[0]
	if task.Status != imageTaskCanceled || task.Error != "" {
		t.Fatalf("取消应为 canceled 且没有错误: %+v", task)
	}
}

func TestRelayProcessBoundaries(t *testing.T) {
	for _, mode := range []string{"success", "load-failure", "load-failure-stream", "save-failure", "cancel-transfer"} {
		t.Run(mode, func(t *testing.T) {
			s, payload, capture, ready := relayProcessFixture(t, mode)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var done <-chan struct{}
			if mode == "cancel-transfer" {
				done = cancelRelayWhenReady(t, ctx, cancel, ready)
			}
			id := s.createImageTask(imageTaskState{ImageTask: ImageTask{Type: imageTaskTypePull, Stage: "transferring", ProgressUnit: "bytes"}})
			err := s.relayImageToTarget(ctx, id, "example:latest", ImageSource{Kind: "local"}, "fake-save", ImageSource{Kind: "local"}, "fake-load")
			if done != nil {
				<-done
			}
			switch mode {
			case "success":
				data, readErr := os.ReadFile(capture)
				if err != nil || readErr != nil || !bytes.Equal(data, payload) {
					t.Fatalf("二进制流不完整或混入 stderr: err=%v read=%v bytes=%d", err, readErr, len(data))
				}
				if task := s.GetImageTasks().Tasks[0]; task.Bytes != int64(len(payload)) {
					t.Fatalf("传输字节数丢失尾部: %d != %d", task.Bytes, len(payload))
				}
			case "load-failure", "load-failure-stream":
				if err == nil || !strings.Contains(err.Error(), "target load denied") {
					t.Fatalf("目标错误被 save 取消/pipe 错误覆盖: %v", err)
				}
			case "save-failure":
				if err == nil || !strings.Contains(err.Error(), "local save diagnostic") {
					t.Fatalf("save 独立失败应保留本机 stderr: %v", err)
				}
			case "cancel-transfer":
				if !errors.Is(err, context.Canceled) || ctx.Err() != context.Canceled {
					t.Fatalf("取消没有中断传输: ctx=%v err=%v", ctx.Err(), err)
				}
			}
		})
	}
}

func TestRelayAllPlatformsRequiresExplicitCompleteExport(t *testing.T) {
	for _, mode := range []string{"success", "missing-platform", "old-cli", "load-failure", "cancel-transfer"} {
		t.Run(mode, func(t *testing.T) {
			s, payload, capture, ready := relayProcessFixture(t, mode)
			s.config = &ConfigService{path: filepath.Join(t.TempDir(), "config.json"), cfg: Config{DockerCLIPath: "fake-local-docker"}}
			s.runner = func(_ context.Context, name string, args ...string) ([]byte, error) {
				if name != "fake-local-docker" || strings.Join(args, " ") != "buildx imagetools inspect --raw example:latest" {
					t.Fatalf("中转解析应只在本机执行: %s %v", name, args)
				}
				return []byte(`{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}`), nil
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var done <-chan struct{}
			if mode == "cancel-transfer" {
				done = cancelRelayWhenReady(t, ctx, cancel, ready)
			}
			id := s.createImageTask(imageTaskState{ImageTask: ImageTask{Type: imageTaskTypePull}})
			// 系统 ssh 也被真实子进程 seam 替换；不接触真实 SSH 或应用配置。
			s.runImagePull(ctx, id, "example:latest", ImageSource{Kind: "ssh", SSHHost: "fixture.invalid", DockerCommand: "docker"}, "unused-remote-cli", ImagePullOptions{Platform: "all", Relay: true})
			if done != nil {
				<-done
			}
			task := s.GetImageTasks().Tasks[0]
			commands, err := os.ReadFile(filepath.Join(filepath.Dir(capture), "commands"))
			if err != nil || !strings.Contains(string(commands), "image save --platform linux/amd64,linux/arm64 example:latest") {
				t.Fatalf("不得默认 save 静默导出部分架构: %s, %v", commands, err)
			}
			if task.ProgressUnit != "bytes" || task.Total != 0 || task.Completed != 0 {
				t.Fatalf("中转应清空 layer 计数，保留未知总量的字节进度: %+v", task)
			}
			switch mode {
			case "success":
				data, readErr := os.ReadFile(capture)
				if task.Status != imageTaskSuccess || task.Bytes != int64(len(payload)) || readErr != nil || !bytes.Equal(data, payload) {
					t.Fatalf("完整中转未成功: %+v read=%v", task, readErr)
				}
			case "cancel-transfer":
				if task.Status != imageTaskCanceled || task.Error != "" {
					t.Fatalf("中转取消应归为 canceled: %+v", task)
				}
			case "load-failure":
				if task.Status != imageTaskFailed || !strings.Contains(task.Error, "target load denied") {
					t.Fatalf("必须保留目标 load 错误: %+v", task)
				}
			default:
				if task.Status != imageTaskFailed || !strings.Contains(task.Error, "errors.imageExport.relayPlatformsFailed") || !strings.Contains(task.Error, "local save diagnostic") {
					t.Fatalf("缺平台或旧 CLI 必须明确失败并保留诊断: %+v", task)
				}
			}
		})
	}
}

// 使用临时回环服务端验证真实 SSH 会话的关闭路径，不读取应用配置或连接用户主机。
func TestRelaySSHSessionReleasesBlockedStdin(t *testing.T) {
	for _, mode := range []string{"cancel", "load-failure"} {
		t.Run(mode, func(t *testing.T) {
			ready, remoteDone := make(chan struct{}), make(chan struct{})
			server := startTestSSHServerWithOptions(t, "fixture", "fixture", nil, "", func(channel ssh.Channel, _ string) {
				defer close(remoteDone)
				close(ready)
				if mode == "load-failure" {
					_, _ = fmt.Fprintln(channel.Stderr(), "target load denied")
					_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{1}))
					return
				}
				_, _ = io.Copy(io.Discard, channel)
			})
			client, err := ssh.Dial("tcp", server.address, testSSHClientConfig("fixture", "fixture"))
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			reader, writer := io.Pipe()
			defer writer.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			stderr := &bytes.Buffer{}
			done := make(chan error, 1)
			go func() {
				// 密码前缀必须保留底层镜像管道的关闭能力。
				stdin := imageDockerStdin(ImageSource{Kind: "ssh", SudoPassword: "fixture"}, reader)
				done <- runSSHCommandWritersLine(ctx, client, "fixture", "image load", stdin, io.Discard, stderr)
			}()
			select {
			case <-ready:
			case <-time.After(5 * time.Second):
				t.Fatal("回环 SSH 会话未开始")
			}
			if mode == "cancel" {
				cancel()
			}
			select {
			case err := <-done:
				if mode == "cancel" && !errors.Is(err, context.Canceled) {
					t.Fatalf("SSH 取消未传播: %v", err)
				}
				if mode == "load-failure" && (err == nil || !strings.Contains(stderr.String(), "target load denied")) {
					t.Fatalf("目标错误未保留: %v, %s", err, stderr)
				}
			case <-time.After(5 * time.Second):
				cancel()
				_ = reader.Close()
				t.Fatal("SSH 退出后阻塞的 stdin 未被解锁")
			}
			select {
			case <-remoteDone:
			case <-time.After(5 * time.Second):
				t.Fatal("远端会话仍未关闭")
			}
			_ = client.Close()
			awaitTestSSHServerIdle(t, server, "中转结束")
		})
	}
}
