package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/pkg/sftp"
)

func TestRemoteTextEditPreservesFileAndRejectsStaleRevision(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "notes.txt")
	if err := os.WriteFile(filePath, []byte("原内容\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	withTestSFTPClient(t, root, func(client *sftp.Client) {
		original, _, err := readRemoteText(client, filePath)
		if err != nil {
			t.Fatal(err)
		}
		revision, err := saveRemoteText(client, filePath, "更新内容\n", original.Revision)
		if err != nil {
			t.Fatal(err)
		}
		updated, mode, err := readRemoteText(client, filePath)
		if err != nil {
			t.Fatal(err)
		}
		if updated.Content != "更新内容\n" || updated.Revision != revision || mode != 0o640 {
			t.Fatalf("保存后的内容、版本或权限不正确: %#v, %o", updated, mode)
		}
		if _, err := saveRemoteText(client, filePath, "过期覆盖", original.Revision); err == nil {
			t.Fatal("旧版本不应覆盖新内容")
		}
		contents, err := os.ReadFile(filePath)
		if err != nil || string(contents) != "更新内容\n" {
			t.Fatalf("版本冲突后文件被改写: %q, %v", contents, err)
		}
	})
}

func TestKeepLastLines(t *testing.T) {
	tests := []struct {
		data    string
		lines   int
		want    string
		dropped bool
	}{
		{"a\nb\nc\n", 2, "b\nc\n", true},
		{"a\nb\nc", 2, "b\nc", true},
		{"a\nb", 5, "a\nb", false},
		{"a\n\nb\n", 2, "\nb\n", true},
		{"", 1, "", false},
	}
	for _, test := range tests {
		got, dropped := keepLastLines([]byte(test.data), test.lines)
		if string(got) != test.want || dropped != test.dropped {
			t.Fatalf("keepLastLines(%q, %d) = %q, %v", test.data, test.lines, got, dropped)
		}
	}
}

func TestTrimLeadingPartialRune(t *testing.T) {
	data := []byte("中")
	got := trimLeadingPartialRune(data[1:])
	if !utf8.Valid(got) {
		t.Fatalf("截断的 UTF-8 前缀未被移除: %q", got)
	}
	if got := trimLeadingPartialRune([]byte("完整")); string(got) != "完整" {
		t.Fatalf("完整文本被修改: %q", got)
	}
}

func TestRemoteTextTailReadsEndingWithoutWholeFile(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "service.log")
	content := strings.Repeat("x", remoteTextFileLimit) + "\n倒数第二行\n最后一行\n"
	if err := os.WriteFile(filePath, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	withTestSFTPClient(t, root, func(client *sftp.Client) {
		got, _, err := readRemoteTextTail(client, filePath, 2)
		if err != nil {
			t.Fatal(err)
		}
		if got.Content != "倒数第二行\n最后一行\n" || !got.Truncated {
			t.Fatalf("末尾内容不正确: %#v", got)
		}
		if _, _, err := readRemoteText(client, filePath); err == nil {
			t.Fatal("超过完整读取上限的文件仍应拒绝整文件打开")
		}
	})
}

func TestRemoteTextTailKeepsWholeSmallFile(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "short.log")
	content := strings.Repeat("行\n", 600)
	if err := os.WriteFile(filePath, []byte(content), 0o640); err != nil {
		t.Fatal(err)
	}
	withTestSFTPClient(t, root, func(client *sftp.Client) {
		full, mode, err := readRemoteText(client, filePath)
		if err != nil {
			t.Fatal(err)
		}
		tail, tailMode, err := readRemoteTextTail(client, filePath, 1000)
		if err != nil {
			t.Fatal(err)
		}
		if tail.Truncated || tail.Content != full.Content || tail.Revision != full.Revision || tailMode != mode {
			t.Fatalf("未超过行数的文件应返回完整内容和版本: %#v", tail)
		}
		partial, _, err := readRemoteTextTail(client, filePath, 2)
		if err != nil {
			t.Fatal(err)
		}
		if partial.Content != "行\n行\n" || !partial.Truncated || partial.Revision == full.Revision {
			t.Fatalf("部分行应截取且版本不同于完整文件: %#v", partial)
		}
	})
}

func TestRemoteTextTailRejectsInvalidRangeAndBinary(t *testing.T) {
	if err := validateRemoteTextTailLines(-1); localizedErrorKey(err) != "errors.sshFile.textTailInvalid" {
		t.Fatalf("负数行数错误 = %v", err)
	}
	if err := validateRemoteTextTailLines(maxRemoteTextTailLines + 1); err == nil {
		t.Fatal("超限行数应被拒绝")
	}
	root := t.TempDir()
	filePath := filepath.Join(root, "binary.log")
	if err := os.WriteFile(filePath, append([]byte("日志\n"), 0), 0o600); err != nil {
		t.Fatal(err)
	}
	withTestSFTPClient(t, root, func(client *sftp.Client) {
		if _, _, err := readRemoteTextTail(client, filePath, 10); localizedErrorKey(err) != "errors.sshFile.textInvalidEncoding" {
			t.Fatalf("二进制尾部错误 = %v", err)
		}
	})
}

func TestRemoteTextEditRejectsBinaryAndOversizedFiles(t *testing.T) {
	root := t.TempDir()
	binaryPath := filepath.Join(root, "binary.txt")
	largePath := filepath.Join(root, "large.txt")
	if err := os.WriteFile(binaryPath, []byte{'a', 0, 'b'}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(largePath, []byte(strings.Repeat("x", remoteTextFileLimit+1)), 0o600); err != nil {
		t.Fatal(err)
	}
	withTestSFTPClient(t, root, func(client *sftp.Client) {
		if _, _, err := readRemoteText(client, binaryPath); err == nil {
			t.Fatal("二进制文件不应进入文本编辑器")
		}
		if _, _, err := readRemoteText(client, largePath); err == nil {
			t.Fatal("超大文件不应进入文本编辑器")
		}
	})
}
