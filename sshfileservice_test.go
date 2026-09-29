package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
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

func TestResolveRemoteDirectoryKeepsRequestedPath(t *testing.T) {
	got, err := resolveRemoteDirectory(nil, " /var/log ")
	if err != nil {
		t.Fatal(err)
	}
	if got != "/var/log" {
		t.Errorf("resolveRemoteDirectory() = %q, want /var/log", got)
	}
}

func TestRemoteSearchFilenameCommandUsesFDAndFindFallback(t *testing.T) {
	command := remoteSearchCommand(
		"needle's",
		"/srv/app",
		remoteFileSearchName,
		remoteFileSearchScopeCurrent,
		false,
	)
	for _, expected := range []string{
		"command -v fd",
		"fd --absolute-path --ignore-case --fixed-strings --no-ignore --print0 --min-depth 1 --max-depth 1",
		`'needle'"'"'s'`,
		"for item in '/srv/app'/*; do if [ -e \"$item\" ]",
		"-print0",
	} {
		if !strings.Contains(command, expected) {
			t.Fatalf("文件名搜索命令缺少 %q: %s", expected, command)
		}
	}
}

func TestRemoteSearchContentCommandUsesRGAndGrepFallback(t *testing.T) {
	command := remoteSearchCommand(
		"needle",
		"/srv/app",
		remoteFileSearchContent,
		remoteFileSearchScopeRecursive,
		true,
	)
	for _, expected := range []string{
		"command -v rg",
		"rg --files-with-matches --null --fixed-strings --ignore-case --no-ignore --hidden",
		"grep -lIZ -i -F",
		"find '/srv/app' ! -path '/srv/app' -type f",
	} {
		if !strings.Contains(command, expected) {
			t.Fatalf("文件内容搜索命令缺少 %q: %s", expected, command)
		}
	}
	if strings.Contains(command, "--max-depth 1") {
		t.Fatal("递归内容搜索不应限制最大深度")
	}
}

func TestParseRemoteSearchPathsUsesNulSeparators(t *testing.T) {
	got := parseRemoteSearchPaths([]byte("/srv/app/a\x00/srv/app/a\x00/srv/app/b\nname\x00"))
	want := []string{"/srv/app/a", "/srv/app/b\nname"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("解析远程搜索路径 = %#v, want %#v", got, want)
	}
}

func TestRemoteCreationTimesCommandQuotesPaths(t *testing.T) {
	command := remoteCreationTimesCommand([]string{"/remote/O'Brien", "/target/file"})
	if !strings.Contains(command, `'/remote/O'"'"'Brien'`) {
		t.Fatalf("远程路径未正确转义: %s", command)
	}
	if !strings.Contains(command, `stat -c %W -- "$item"`) {
		t.Fatalf("缺少 GNU stat 创建时间探测: %s", command)
	}
	if !strings.Contains(command, `stat -f %B "$item"`) {
		t.Fatalf("缺少 BSD stat 创建时间探测: %s", command)
	}
}

func TestParseRemoteCreationTimes(t *testing.T) {
	got := parseRemoteCreationTimes([]byte("1700000000\n0\n-1\ninvalid\n"), 4)
	want := time.Unix(1700000000, 0).UTC().Format(time.RFC3339)
	if got[0] != want {
		t.Fatalf("创建时间解析结果 = %q, want %q", got[0], want)
	}
	for index, value := range got[1:] {
		if value != "" {
			t.Errorf("第 %d 个不可用创建时间应为空，实际为 %q", index+1, value)
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
	compressCommand := remoteArchiveCompressCommand("tar.gz", []string{"/remote/O'Brien"}, archivePath)
	for _, expected := range []string{
		"command -v tar >/dev/null 2>&1",
		"tar -czf '/remote/O'\"'\"'Brien.tar.gz' -C '/remote' 'O'\"'\"'Brien'",
	} {
		if !strings.Contains(compressCommand, expected) {
			t.Fatalf("远程压缩命令缺少 %q: %s", expected, compressCommand)
		}
	}
	zipCommand := remoteArchiveCompressCommand(
		"zip",
		[]string{"/remote/O'Brien", "/other/archive"},
		"/target/archive.zip",
	)
	for _, expected := range []string{
		"command -v zip >/dev/null 2>&1",
		"(cd '/remote' && zip -qr '/target/archive.zip' 'O'\"'\"'Brien')",
		"(cd '/other' && zip -qr -g '/target/archive.zip' 'archive')",
	} {
		if !strings.Contains(zipCommand, expected) {
			t.Fatalf("远程 ZIP 压缩命令缺少 %q: %s", expected, zipCommand)
		}
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

func TestRemoteDownloadSegmentsUseFixedRanges(t *testing.T) {
	files := []*remoteDownloadFile{
		{remotePath: "/large.bin", size: remoteDownloadSegmentSize*2 + 3},
		{remotePath: "/empty.bin"},
		{remotePath: "/small.bin", size: 5},
	}
	segments := remoteDownloadSegments(files)
	want := []struct {
		remote string
		offset int64
		length int
	}{
		{remote: "/large.bin", offset: 0, length: int(remoteDownloadSegmentSize)},
		{remote: "/large.bin", offset: remoteDownloadSegmentSize, length: int(remoteDownloadSegmentSize)},
		{remote: "/large.bin", offset: remoteDownloadSegmentSize * 2, length: 3},
		{remote: "/small.bin", offset: 0, length: 5},
	}
	if len(segments) != len(want) {
		t.Fatalf("远程下载分段数 = %d, want %d", len(segments), len(want))
	}
	for index, segment := range segments {
		expected := want[index]
		if segment.file.remotePath != expected.remote ||
			segment.offset != expected.offset ||
			segment.length != expected.length {
			t.Errorf("第 %d 个远程下载分段 = (%q, %d, %d), want (%q, %d, %d)",
				index,
				segment.file.remotePath,
				segment.offset,
				segment.length,
				expected.remote,
				expected.offset,
				expected.length,
			)
		}
	}
	if files[0].segmentCount != 3 || files[1].segmentCount != 0 || files[2].segmentCount != 1 {
		t.Fatalf(
			"远程文件分段计数 = (%d, %d, %d), want (3, 0, 1)",
			files[0].segmentCount,
			files[1].segmentCount,
			files[2].segmentCount,
		)
	}
}

func withTestSFTPClients(
	t *testing.T,
	remoteRoot string,
	count int,
	fn func([]*sftp.Client),
	clientOptions ...sftp.ClientOption,
) {
	t.Helper()
	if count < 1 {
		count = 1
	}
	if len(clientOptions) == 0 {
		clientOptions = remoteDownloadSFTPOptions()
	}
	clients := make([]*sftp.Client, 0, count)
	var closers []func()
	defer func() {
		for index := len(closers) - 1; index >= 0; index-- {
			closers[index]()
		}
	}()
	for range count {
		serverConn, clientConn := net.Pipe()
		server, err := sftp.NewServer(serverConn, sftp.WithServerWorkingDirectory(remoteRoot))
		if err != nil {
			t.Fatalf("创建测试 SFTP 服务失败: %v", err)
		}
		serverDone := make(chan error, 1)
		go func() { serverDone <- server.Serve() }()
		client, err := sftp.NewClientPipe(clientConn, clientConn, clientOptions...)
		if err != nil {
			_ = clientConn.Close()
			<-serverDone
			t.Fatalf("创建测试 SFTP 客户端失败: %v", err)
		}
		clients = append(clients, client)
		closers = append(closers, func() {
			_ = client.Close()
			select {
			case <-serverDone:
			case <-time.After(time.Second):
				t.Error("测试 SFTP 服务未及时退出")
			}
		})
	}
	fn(clients)
}

func withTestSFTPClient(t *testing.T, remoteRoot string, fn func(*sftp.Client)) {
	t.Helper()
	withTestSFTPClients(t, remoteRoot, 1, func(clients []*sftp.Client) {
		fn(clients[0])
	})
}

func TestRemoteDownloadConnectionWanted(t *testing.T) {
	if got := remoteDownloadConnectionWanted(nil); got != 1 {
		t.Fatalf("空文件列表连接数 = %d, want 1", got)
	}
	if got := remoteDownloadConnectionWanted([]*remoteDownloadFile{{size: 1024}}); got != 1 {
		t.Fatalf("单分片连接数 = %d, want 1", got)
	}
	if got := remoteDownloadConnectionWanted([]*remoteDownloadFile{
		{size: remoteDownloadSegmentSize*2 + 1},
	}); got != 3 {
		t.Fatalf("三分片连接数 = %d, want 3", got)
	}
	if got := remoteDownloadConnectionWanted([]*remoteDownloadFile{
		{size: remoteDownloadSegmentSize * 10},
	}); got != remoteDownloadConnectionCount {
		t.Fatalf("超大文件连接数 = %d, want %d", got, remoteDownloadConnectionCount)
	}
	if got := remoteDownloadConnectionWanted([]*remoteDownloadFile{{size: remoteDownloadSegmentSize * 10}}, 2); got != 2 {
		t.Fatalf("设置分片并发后连接数 = %d, want 2", got)
	}
}

func TestRemoteUploadTransferTuningBalancesWindowWithConcurrency(t *testing.T) {
	if got := remoteUploadTransferTuning(4, 4); got.segmentSize != 4*1024*1024 || got.writeSize != got.segmentSize {
		t.Fatalf("默认并发上传调优 = %+v, want 4 MiB 分片和写入窗口", got)
	}
	if got := remoteUploadTransferTuning(1, 1); got.segmentSize != remoteUploadMaxWindowSize {
		t.Fatalf("单连接上传窗口 = %+v, want 最大窗口 %d", got, remoteUploadMaxWindowSize)
	}
	if got := remoteUploadTransferTuning(16, 16); got.segmentSize != remoteUploadMinWindowSize {
		t.Fatalf("高并发上传窗口 = %+v, want 最小窗口 %d", got, remoteUploadMinWindowSize)
	}
}

func TestUploadLocalFileUsesParallelSegmentsAndCommitsAtomically(t *testing.T) {
	remoteRoot := t.TempDir()
	localPath := filepath.Join(t.TempDir(), "upload.bin")
	payload := make([]byte, int(remoteDownloadSegmentSize*2+123))
	for index := range payload {
		payload[index] = byte(index % 241)
	}
	if err := os.WriteFile(localPath, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(remoteRoot, "upload.bin"), []byte("old content"), 0o600); err != nil {
		t.Fatal(err)
	}
	withTestSFTPClients(t, remoteRoot, 4, func(clients []*sftp.Client) {
		service := &FileService{}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		taskID := service.createFileTask(FileTask{Type: fileTaskTypeUpload}, ctx, cancel)
		var done atomic.Int64
		var doneFiles atomic.Int32
		if err := service.uploadLocalFile(ctx, clients, localPath, "upload.bin", taskID, &done, &doneFiles); err != nil {
			t.Fatalf("并行上传失败: %v", err)
		}
		got, err := os.ReadFile(filepath.Join(remoteRoot, "upload.bin"))
		if err != nil {
			t.Fatalf("读取上传文件失败: %v", err)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("上传结果不一致: got %d bytes, want %d", len(got), len(payload))
		}
		task := service.GetFileTasks().Tasks[0]
		if task.Completed != int64(len(payload)) || task.DoneFiles != 1 {
			t.Fatalf("上传进度 = (%d, %d), want (%d, 1)", task.Completed, task.DoneFiles, len(payload))
		}
		entries, err := os.ReadDir(remoteRoot)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 || entries[0].Name() != "upload.bin" {
			t.Fatalf("上传后临时文件未清理: %#v", entries)
		}
	}, remoteUploadSFTPOptions()...)
}

func TestUploadDirectoryUsesConfiguredClientsAcrossFiles(t *testing.T) {
	remoteRoot := t.TempDir()
	localRoot := t.TempDir()
	files := map[string][]byte{
		"a.bin":        []byte("first payload"),
		"nested/b.bin": []byte("second payload"),
		"nested/c.bin": []byte("third payload"),
	}
	for name, payload := range files {
		localPath := filepath.Join(localRoot, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(localPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(localPath, payload, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	withTestSFTPClients(t, remoteRoot, 4, func(clients []*sftp.Client) {
		service := &FileService{}
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		taskID := service.createFileTask(FileTask{Type: fileTaskTypeUpload}, ctx, cancel)
		var done atomic.Int64
		var doneFiles atomic.Int32
		if err := service.uploadLocalPath(
			ctx,
			clients,
			localRoot,
			".",
			taskID,
			&done,
			&doneFiles,
			remoteUploadTransferTuning(4, 4),
		); err != nil {
			t.Fatalf("并行上传目录失败: %v", err)
		}
		for name, want := range files {
			remotePath := filepath.Join(remoteRoot, filepath.Base(localRoot), filepath.FromSlash(name))
			got, err := os.ReadFile(remotePath)
			if err != nil {
				t.Fatalf("读取上传文件 %s 失败: %v", name, err)
			}
			if !bytes.Equal(got, want) {
				t.Errorf("上传文件 %s 内容不一致", name)
			}
		}
		var expectedBytes int64
		for _, payload := range files {
			expectedBytes += int64(len(payload))
		}
		if done.Load() != expectedBytes || doneFiles.Load() != int32(len(files)) {
			t.Fatalf("目录上传进度 = (%d, %d), want (%d, %d)", done.Load(), doneFiles.Load(), expectedBytes, len(files))
		}
	}, remoteUploadSFTPOptions()...)
}

func TestDownloadRemoteFilesAssemblesSFTPSegments(t *testing.T) {
	remoteRoot := t.TempDir()
	remotePath := filepath.Join(remoteRoot, "source.bin")
	payload := make([]byte, int(remoteDownloadSegmentSize*2+123))
	for index := range payload {
		payload[index] = byte(index % 251)
	}
	if err := os.WriteFile(remotePath, payload, 0o644); err != nil {
		t.Fatal(err)
	}

	withTestSFTPClient(t, remoteRoot, func(client *sftp.Client) {
		info, err := client.Lstat("source.bin")
		if err != nil {
			t.Fatalf("读取测试远程文件信息失败: %v", err)
		}
		localPath := filepath.Join(t.TempDir(), "nested", "target.bin")
		files, err := prepareRemoteDownloadFiles([]remoteTreeItem{{
			remote: "source.bin",
			local:  localPath,
			info:   info,
		}})
		if err != nil {
			t.Fatalf("准备测试下载文件失败: %v", err)
		}
		defer cleanupRemoteDownloadFiles(files)
		service := &FileService{}
		taskContext, taskCancel := context.WithCancel(context.Background())
		defer taskCancel()
		taskID := service.createFileTask(
			FileTask{Type: fileTaskTypeDownload, Total: int64(len(payload)), Files: 1},
			taskContext,
			taskCancel,
		)
		if err := service.downloadRemoteFiles(taskContext, []*sftp.Client{client}, files, taskID); err != nil {
			t.Fatalf("执行分段下载失败: %v", err)
		}
		task := service.GetFileTasks().Tasks[0]
		if task.Completed != int64(len(payload)) || task.DoneFiles != 1 {
			t.Fatalf("下载任务进度 = (%d, %d), want (%d, 1)", task.Completed, task.DoneFiles, len(payload))
		}
		if err := finalizeRemoteDownloadFiles(files); err != nil {
			t.Fatalf("完成测试下载失败: %v", err)
		}
		got, err := os.ReadFile(localPath)
		if err != nil {
			t.Fatalf("读取测试下载结果失败: %v", err)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("分段下载结果不一致: got %d bytes, want %d", len(got), len(payload))
		}
	})
}

func TestDownloadRemoteFilesUsesMultipleSFTPClients(t *testing.T) {
	remoteRoot := t.TempDir()
	payload := make([]byte, int(remoteDownloadSegmentSize*2+123))
	for index := range payload {
		payload[index] = byte(index % 251)
	}
	if err := os.WriteFile(filepath.Join(remoteRoot, "source.bin"), payload, 0o644); err != nil {
		t.Fatal(err)
	}

	withTestSFTPClients(t, remoteRoot, 2, func(clients []*sftp.Client) {
		info, err := clients[0].Lstat("source.bin")
		if err != nil {
			t.Fatalf("读取测试远程文件信息失败: %v", err)
		}
		localPath := filepath.Join(t.TempDir(), "target.bin")
		files, err := prepareRemoteDownloadFiles([]remoteTreeItem{{
			remote: "source.bin",
			local:  localPath,
			info:   info,
		}})
		if err != nil {
			t.Fatalf("准备测试下载文件失败: %v", err)
		}
		defer cleanupRemoteDownloadFiles(files)
		if remoteDownloadConnectionWanted(files) < 2 {
			t.Fatal("测试文件应需要至少两条下载连接")
		}
		service := &FileService{}
		if err := service.downloadRemoteFiles(context.Background(), clients, files, ""); err != nil {
			t.Fatalf("多连接分段下载失败: %v", err)
		}
		if err := finalizeRemoteDownloadFiles(files); err != nil {
			t.Fatalf("完成测试下载失败: %v", err)
		}
		got, err := os.ReadFile(localPath)
		if err != nil {
			t.Fatalf("读取测试下载结果失败: %v", err)
		}
		if !bytes.Equal(got, payload) {
			t.Fatalf("多连接分段下载结果不一致: got %d bytes, want %d", len(got), len(payload))
		}
	})
}

func TestDownloadRemoteSegmentReportsPackets(t *testing.T) {
	remoteRoot := t.TempDir()
	payload := make([]byte, int(remoteDownloadPacketSize*2+123))
	for index := range payload {
		payload[index] = byte(index % 251)
	}
	if err := os.WriteFile(filepath.Join(remoteRoot, "source.bin"), payload, 0o644); err != nil {
		t.Fatal(err)
	}

	withTestSFTPClient(t, remoteRoot, func(client *sftp.Client) {
		info, err := client.Lstat("source.bin")
		if err != nil {
			t.Fatalf("读取测试远程文件信息失败: %v", err)
		}
		localPath := filepath.Join(t.TempDir(), "target.bin")
		files, err := prepareRemoteDownloadFiles([]remoteTreeItem{{
			remote: "source.bin",
			local:  localPath,
			info:   info,
		}})
		if err != nil {
			t.Fatalf("准备测试下载文件失败: %v", err)
		}
		defer cleanupRemoteDownloadFiles(files)
		if len(files) != 1 {
			t.Fatalf("测试下载文件数 = %d, want 1", len(files))
		}
		segments := remoteDownloadSegments(files)
		if len(segments) != 1 {
			t.Fatalf("测试下载分段数 = %d, want 1", len(segments))
		}

		var writesMu sync.Mutex
		var writes []int64
		var doneCount int
		if err := downloadRemoteSegment(context.Background(), client, segments[0], func(written int64, segmentDone bool) {
			writesMu.Lock()
			writes = append(writes, written)
			if segmentDone {
				doneCount++
			}
			writesMu.Unlock()
		}); err != nil {
			t.Fatalf("按包下载失败: %v", err)
		}
		if doneCount != 1 {
			t.Fatalf("分段完成回调次数 = %d, want 1", doneCount)
		}
		if len(writes) != 3 {
			t.Fatalf("进度回调次数 = %d, want 3", len(writes))
		}
		var total int64
		for _, written := range writes {
			if written <= 0 || written > remoteDownloadPacketSize {
				t.Fatalf("单次进度 = %d, want 1..%d", written, remoteDownloadPacketSize)
			}
			total += written
		}
		if total != int64(len(payload)) {
			t.Fatalf("累计进度 = %d, want %d", total, len(payload))
		}
	})
}

func TestCopySSHConfigSlicesAreIndependent(t *testing.T) {
	original := []SSHConnection{{ID: "prod", Name: "生产"}}
	copy := copySSHConnections(original)
	copy[0].Name = "changed"
	if reflect.DeepEqual(original, copy) {
		t.Fatal("复制 SSH 连接切片后修改副本不应影响原切片")
	}
}
