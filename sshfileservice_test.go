package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func TestNormalizedRemotePath(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"", "/"},
		{"var/log", "/var/log"},
		{"//var///log/", "/var/log"},
		{"/var/../tmp", "/tmp"},
	}
	for _, test := range tests {
		if got := normalizedRemotePath(test.input); got != test.want {
			t.Errorf("normalizedRemotePath(%q) = %q, want %q", test.input, got, test.want)
		}
	}
}

func TestCopyWithProgressReportsWrittenBytes(t *testing.T) {
	source := strings.Repeat("x", 256*1024+7)
	var output bytes.Buffer
	var completed int64
	updates := 0
	err := copyWithProgress(
		context.Background(),
		&output,
		strings.NewReader(source),
		func(delta int64) {
			completed += delta
			updates++
		},
	)
	if err != nil {
		t.Fatalf("带进度复制失败: %v", err)
	}
	if output.String() != source {
		t.Fatal("带进度复制输出内容不一致")
	}
	if completed != int64(len(source)) {
		t.Fatalf("已复制字节数 = %d, want %d", completed, len(source))
	}
	if updates < 2 {
		t.Fatalf("大文件应产生多次进度更新，实际 %d 次", updates)
	}
}

func TestRemoteCopyName(t *testing.T) {
	tests := []struct {
		name    string
		isDir   bool
		attempt int
		want    string
	}{
		{name: "report.txt", want: "report_副本_1700000000.txt"},
		{name: "archive.tar.gz", want: "archive_副本_1700000000.tar.gz"},
		{name: "folder.name", isDir: true, want: "folder.name_副本_1700000000"},
		{name: ".env", want: ".env_副本_1700000000"},
		{name: "report.txt", attempt: 2, want: "report_副本_1700000000_2.txt"},
	}
	for _, test := range tests {
		if got := remoteCopyName(test.name, test.isDir, 1700000000, test.attempt); got != test.want {
			t.Errorf("remoteCopyName(%q, %t, %d) = %q, want %q", test.name, test.isDir, test.attempt, got, test.want)
		}
	}
}

func TestValidateSSHFileConfigAllowsSharedConnection(t *testing.T) {
	connections := []SSHConnection{{ID: "prod", Name: "生产", Host: "example.com", Port: 22, Username: "deploy", Password: "secret"}}
	sources := []FileSource{
		{ID: "app", Name: "应用目录", SSHConnectionID: "prod", DefaultPath: "/srv/app"},
		{ID: "logs", Name: "日志目录", SSHConnectionID: "prod", DefaultPath: "/var/log"},
	}
	if err := validateSSHFileConfig(connections, sources); err != nil {
		t.Fatalf("共享 SSH 连接的多个源不应失败: %v", err)
	}
	if connections[0].Port != 22 {
		t.Fatalf("默认端口被意外修改: %d", connections[0].Port)
	}
}

func TestValidateSSHFileConfigAllowsLocalSSHAlias(t *testing.T) {
	connections := []SSHConnection{{ID: "local", Name: "开发机", Mode: "local", Alias: "dev-box"}}
	sources := []FileSource{{ID: "home", Name: "主目录", SSHConnectionID: "local", DefaultPath: "/home/dev"}}
	if err := validateSSHFileConfig(connections, sources); err != nil {
		t.Fatalf("本地 SSH 配置不应要求重复填写凭据: %v", err)
	}
	if connections[0].Host != "dev-box" || connections[0].Mode != "local" {
		t.Fatalf("本地 SSH 配置未规范化: %#v", connections[0])
	}
}

func TestNewSystemSFTPCommandUsesSSHSubsystem(t *testing.T) {
	cmd := newSystemSFTPCommand(context.Background(), "dev-box")
	if got, want := cmd.Args, []string{"ssh", "-o", "BatchMode=yes", "-o", "RequestTTY=no", "-s", "dev-box", "sftp"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("系统 SSH SFTP 参数 = %#v, want %#v", got, want)
	}
}

func TestRemoteTransferCommandQuotesPaths(t *testing.T) {
	if got, want := remoteTransferCommand(remoteFileOperationCopy, "/remote/O'Brien", "/target/O'Brien"), `cp -a '/remote/O'"'"'Brien' '/target/O'"'"'Brien'`; got != want {
		t.Fatalf("远程复制命令 = %q, want %q", got, want)
	}
	if got, want := remoteTransferCommand(remoteFileOperationMove, "/source", "/target"), "mv '/source' '/target'"; got != want {
		t.Fatalf("远程移动命令 = %q, want %q", got, want)
	}
}

func TestRemoteArchiveCommandsQuotePaths(t *testing.T) {
	archivePath, target := "/remote/O'Brien.tar.gz", "/target/O'Brien"
	if got, want := remoteArchiveExtractCommand("tar.gz", archivePath, target), `tar -xzf '/remote/O'"'"'Brien.tar.gz' -C '/target/O'"'"'Brien'`; got != want {
		t.Fatalf("远程解压命令 = %q, want %q", got, want)
	}
	probe := remoteArchiveProbeCommand("tar.gz", archivePath)
	if !strings.Contains(probe, "tar --numeric-owner -tvzf '/remote/O'\"'\"'Brien.tar.gz'") {
		t.Fatalf("远程解压探测命令未正确引用压缩包路径: %q", probe)
	}
	zipProbe := remoteArchiveProbeCommand("zip", "/remote/archive.zip")
	if !strings.Contains(zipProbe, "unzip -l '/remote/archive.zip'") {
		t.Fatalf("远程 ZIP 探测命令不正确: %q", zipProbe)
	}
}

func TestParseRemoteArchiveStats(t *testing.T) {
	stats, err := parseRemoteArchiveStats([]byte("12345\t7\n"))
	if err != nil {
		t.Fatalf("解析远程解压统计失败: %v", err)
	}
	if stats.total != 12345 || stats.files != 7 {
		t.Fatalf("远程解压统计 = %#v, want total=12345 files=7", stats)
	}
	for _, output := range [][]byte{
		[]byte(""),
		[]byte("12345"),
		[]byte("-1\t7"),
		[]byte("12345\t-1"),
	} {
		if _, err := parseRemoteArchiveStats(output); err == nil {
			t.Errorf("无效远程解压统计 %q 未返回错误", output)
		}
	}
}

func TestCancelFileTaskMarksConflictAsCanceled(t *testing.T) {
	service := &FileService{}
	ctx, cancel := context.WithCancel(context.Background())
	id := service.createFileTask(
		FileTask{
			Type:      remoteFileOperationCopy,
			SourceID:  "source",
			Target:    "/target",
			Paths:     []string{"/source/item"},
			Conflicts: []string{"/target/item"},
		},
		ctx,
		cancel,
	)
	service.taskMu.Lock()
	service.tasks[id].Status, service.tasks[id].Stage = fileTaskConflict, fileTaskConflict
	service.taskMu.Unlock()

	if err := service.CancelFileTask(id); err != nil {
		t.Fatalf("取消冲突任务失败: %v", err)
	}
	task := service.GetFileTasks().Tasks[0]
	if task.Status != fileTaskCanceled || task.Stage != fileTaskCanceled {
		t.Fatalf("冲突任务未标记为已取消: %#v", task)
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("取消冲突任务未取消任务上下文")
	}
}

func TestPasswordAuthMethodsAnswerKeyboardInteractivePasswordPrompt(t *testing.T) {
	methods, err := (&FileService{}).authMethods(SSHConnection{Password: "secret"})
	if err != nil {
		t.Fatalf("构造密码认证方式失败: %v", err)
	}
	if len(methods) != 2 {
		t.Fatalf("密码认证应包含 password 与 keyboard-interactive，实际有 %d 个", len(methods))
	}
	challenge, ok := methods[1].(ssh.KeyboardInteractiveChallenge)
	if !ok {
		t.Fatalf("第二个认证方式不是 keyboard-interactive: %T", methods[1])
	}
	answers, err := challenge("", "", []string{"Password:", "Verification code:"}, []bool{false, true})
	if err != nil {
		t.Fatalf("键盘交互认证回调失败: %v", err)
	}
	if want := []string{"secret", ""}; !reflect.DeepEqual(answers, want) {
		t.Fatalf("键盘交互认证回答 = %#v, want %#v", answers, want)
	}
}

type testSSHPublicKey string

func (key testSSHPublicKey) Type() string {
	return string(key)
}

func (key testSSHPublicKey) Marshal() []byte {
	return []byte(key)
}

func (key testSSHPublicKey) Verify([]byte, *ssh.Signature) error {
	return nil
}

func TestSSHHostKeyAlgorithmsFollowKnownRSAKeyType(t *testing.T) {
	algorithms := sshHostKeyAlgorithmsForKnownKeys([]knownhosts.KnownKey{
		{Key: testSSHPublicKey(ssh.KeyAlgoRSA)},
	})
	if want := []string{ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSA}; !reflect.DeepEqual(algorithms, want) {
		t.Fatalf("RSA 主机密钥算法 = %#v, want %#v", algorithms, want)
	}
}

func TestSSHKnownHostStoreTrustsAndReplacesHostKey(t *testing.T) {
	keyPair := func() ssh.PublicKey {
		_, private, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatalf("生成测试主机密钥失败: %v", err)
		}
		key, err := ssh.NewPublicKey(private.Public())
		if err != nil {
			t.Fatalf("构造测试主机公钥失败: %v", err)
		}
		return key
	}
	firstKey, secondKey := keyPair(), keyPair()
	store := &sshKnownHostStore{
		path: filepath.Join(t.TempDir(), "known_hosts"),
		prompt: func(_ string, _ string, _ ssh.PublicKey, _ []knownhosts.KnownKey) bool {
			return true
		},
	}
	callback, err := store.callback("zh-CN")
	if err != nil {
		t.Fatalf("创建应用 known_hosts 回调失败: %v", err)
	}
	host := sshHostAddress("example.test:22")
	err = callback(string(host), host, firstKey)
	var firstError *sshHostKeyError
	if !errors.As(err, &firstError) || len(firstError.want) != 0 {
		t.Fatalf("首次连接应返回未知主机挑战，实际错误: %v", err)
	}
	if accepted, err := store.confirm(context.Background(), firstError); err != nil || !accepted {
		t.Fatalf("接受未知主机失败: accepted=%t err=%v", accepted, err)
	}
	callback, err = store.callback("zh-CN")
	if err != nil {
		t.Fatalf("重新加载应用 known_hosts 失败: %v", err)
	}
	if err := callback(string(host), host, firstKey); err != nil {
		t.Fatalf("已信任的主机密钥不应失败: %v", err)
	}

	err = callback(string(host), host, secondKey)
	var changedError *sshHostKeyError
	if !errors.As(err, &changedError) || len(changedError.want) != 1 {
		t.Fatalf("密钥变更应返回变更挑战，实际错误: %v", err)
	}
	if accepted, err := store.confirm(context.Background(), changedError); err != nil || !accepted {
		t.Fatalf("更新主机密钥失败: accepted=%t err=%v", accepted, err)
	}
	content, err := os.ReadFile(store.path)
	if err != nil {
		t.Fatalf("读取应用 known_hosts 失败: %v", err)
	}
	firstLine := knownhosts.Line([]string{string(host)}, firstKey)
	secondLine := knownhosts.Line([]string{string(host)}, secondKey)
	if strings.Contains(string(content), firstLine) || !strings.Contains(string(content), secondLine) {
		t.Fatalf("更新后 known_hosts 未替换旧指纹: %s", content)
	}
	callback, err = store.callback("zh-CN")
	if err != nil {
		t.Fatalf("再次加载应用 known_hosts 失败: %v", err)
	}
	if err := callback(string(host), host, secondKey); err != nil {
		t.Fatalf("更新后的主机密钥不应失败: %v", err)
	}
}

func TestSSHKnownHostStoreManagesExistingEntries(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("生成测试主机密钥失败: %v", err)
	}
	key, err := ssh.NewPublicKey(private.Public())
	if err != nil {
		t.Fatalf("构造测试主机公钥失败: %v", err)
	}
	_, secondPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("生成第二个测试主机密钥失败: %v", err)
	}
	secondKey, err := ssh.NewPublicKey(secondPrivate.Public())
	if err != nil {
		t.Fatalf("构造第二个测试主机公钥失败: %v", err)
	}
	store := &sshKnownHostStore{path: filepath.Join(t.TempDir(), "known_hosts")}
	data := []byte(
		knownhosts.Line([]string{"example.test:2222"}, key) + " first\n" +
			knownhosts.Line([]string{"other.test:22"}, secondKey) + "\n",
	)
	if err := os.WriteFile(store.path, data, 0o600); err != nil {
		t.Fatalf("写入测试 known_hosts 失败: %v", err)
	}
	entries, err := store.list()
	if err != nil {
		t.Fatalf("读取应用 known_hosts 记录失败: %v", err)
	}
	if len(entries) != 2 || entries[0].Hosts != "[example.test]:2222" ||
		entries[0].KeyType != ssh.KeyAlgoED25519 || entries[0].Comment != "first" {
		t.Fatalf("解析应用 known_hosts 记录异常: %#v", entries)
	}
	updated := entries[0]
	updated.Hosts = "[updated.test]:2222"
	updated.Comment = "updated"
	normalized, err := store.update(updated)
	if err != nil {
		t.Fatalf("更新应用 known_hosts 记录失败: %v", err)
	}
	if normalized.Hosts != "[updated.test]:2222" || normalized.Comment != "updated" ||
		normalized.Fingerprint != entries[0].Fingerprint {
		t.Fatalf("规范化后的 SSH 主机记录异常: %#v", normalized)
	}
	entries, err = store.list()
	if err != nil {
		t.Fatalf("更新后读取应用 known_hosts 记录失败: %v", err)
	}
	if len(entries) != 2 || entries[0].ID != normalized.ID {
		t.Fatalf("更新后的应用 known_hosts 记录异常: %#v", entries)
	}
	if err := store.delete(normalized.ID); err != nil {
		t.Fatalf("删除应用 known_hosts 记录失败: %v", err)
	}
	entries, err = store.list()
	if err != nil {
		t.Fatalf("删除后读取应用 known_hosts 记录失败: %v", err)
	}
	if len(entries) != 1 || entries[0].Hosts != "other.test" {
		t.Fatalf("删除后的应用 known_hosts 记录异常: %#v", entries)
	}
	if _, err := store.update(SSHKnownHost{Hosts: "new.test", PublicKey: entries[0].PublicKey}); err == nil {
		t.Fatal("没有记录 ID 时不应创建新的 known_hosts 记录")
	}
}

func TestValidateSSHFileConfigRejectsDanglingSource(t *testing.T) {
	err := validateSSHFileConfig(
		[]SSHConnection{{ID: "prod", Name: "生产", Host: "example.com", Username: "deploy", Password: "secret"}},
		[]FileSource{{ID: "logs", Name: "日志目录", SSHConnectionID: "missing", DefaultPath: "/var/log"}},
	)
	if err == nil {
		t.Fatal("引用不存在 SSH 连接的文件源应被拒绝")
	}
}

func TestLocalTreeCountsRegularFilesAndBytes(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "first.txt")
	nested := filepath.Join(root, "nested", "second.bin")
	if err := os.MkdirAll(filepath.Dir(nested), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(first, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(nested, []byte{1, 2, 3}, 0o644); err != nil {
		t.Fatal(err)
	}
	total, files, err := localTree(context.Background(), []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if total != 8 || files != 2 {
		t.Fatalf("localTree() = (%d, %d), want (8, 2)", total, files)
	}
}

func TestCopySSHConfigSlicesAreIndependent(t *testing.T) {
	original := []SSHConnection{{ID: "prod", Name: "生产"}}
	copy := copySSHConnections(original)
	copy[0].Name = "changed"
	if reflect.DeepEqual(original, copy) {
		t.Fatal("复制 SSH 连接切片后修改副本不应影响原切片")
	}
}
