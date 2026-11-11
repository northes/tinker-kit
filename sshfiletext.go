package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pkg/sftp"
)

const (
	remoteTextFileLimit    = 2 << 20
	maxRemoteTextTailLines = 10000
	remoteTextTailWindow   = 64 << 10
)

type RemoteTextFile struct {
	Content   string `json:"content"`
	Revision  string `json:"revision"`
	Truncated bool   `json:"truncated"`
}

func remoteTextPath(value string) (string, error) {
	if strings.TrimSpace(value) == "" || strings.ContainsRune(value, '\x00') {
		return "", userError("errors.sshFile.textPathInvalid")
	}
	value = normalizedRemotePath(value)
	if value == "/" {
		return "", userError("errors.sshFile.textPathInvalid")
	}
	return value, nil
}

func createRemoteText(client *sftp.Client, remotePath string) error {
	if err := ensureRemotePathAbsent(client, remotePath); err != nil {
		return err
	}
	// 排他创建防止检查后目标被其他客户端建立，不截断文件或跟随同名符号链接。
	file, err := client.OpenFile(remotePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return userErrorCause("errors.sshFile.createTextFailed", err)
	}
	if err := file.Close(); err != nil {
		return userErrorCause("errors.sshFile.createTextFailed", err)
	}
	return nil
}

// CreateRemoteTextFile 创建空白纯文本文件，不覆盖已有项目，也不隐式创建父目录。
func (s *FileService) CreateRemoteTextFile(ctx context.Context, sourceID, remotePath string) error {
	remotePath, err := remoteTextPath(remotePath)
	if err != nil {
		return err
	}
	_, connection, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	session, err := s.acquirePersistentSFTP(ctx, sourceID, connection)
	if err != nil {
		return err
	}
	defer s.releasePersistentSFTP(session)
	return createRemoteText(session.sftp, remotePath)
}

func readRemoteText(client *sftp.Client, remotePath string) (RemoteTextFile, os.FileMode, error) {
	info, err := client.Lstat(remotePath)
	if err != nil {
		return RemoteTextFile{}, 0, userErrorCause("errors.sshFile.readTextFailed", err)
	}
	if !info.Mode().IsRegular() {
		return RemoteTextFile{}, 0, userError("errors.sshFile.textNotRegular")
	}
	if info.Size() > remoteTextFileLimit {
		return RemoteTextFile{}, 0, userError("errors.sshFile.textTooLarge")
	}
	file, err := client.Open(remotePath)
	if err != nil {
		return RemoteTextFile{}, 0, userErrorCause("errors.sshFile.readTextFailed", err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, remoteTextFileLimit+1))
	if err != nil {
		return RemoteTextFile{}, 0, userErrorCause("errors.sshFile.readTextFailed", err)
	}
	if len(data) > remoteTextFileLimit {
		return RemoteTextFile{}, 0, userError("errors.sshFile.textTooLarge")
	}
	if !utf8.Valid(data) || containsNul(data) {
		return RemoteTextFile{}, 0, userError("errors.sshFile.textInvalidEncoding")
	}
	sum := sha256.Sum256(data)
	return RemoteTextFile{Content: string(data), Revision: hex.EncodeToString(sum[:])}, info.Mode().Perm(), nil
}

func containsNul(data []byte) bool {
	for _, value := range data {
		if value == 0 {
			return true
		}
	}
	return false
}

func saveRemoteText(client *sftp.Client, remotePath, content, revision string) (string, error) {
	data := []byte(content)
	if len(data) > remoteTextFileLimit {
		return "", userError("errors.sshFile.textTooLarge")
	}
	if !utf8.Valid(data) || containsNul(data) {
		return "", userError("errors.sshFile.textInvalidEncoding")
	}
	current, mode, err := readRemoteText(client, remotePath)
	if err != nil {
		return "", err
	}
	if current.Revision != revision {
		return "", userError("errors.sshFile.textChanged")
	}
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	tempPath := path.Join(path.Dir(remotePath), fmt.Sprintf(".tinkerkit-edit-%x", random))
	temp, err := client.OpenFile(tempPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return "", userErrorCause("errors.sshFile.writeTextFailed", err)
	}
	defer client.Remove(tempPath)
	if err := temp.Chmod(mode); err != nil {
		_ = temp.Close()
		return "", userErrorCause("errors.sshFile.writeTextFailed", err)
	}
	written, writeErr := temp.Write(data)
	if writeErr == nil && written != len(data) {
		writeErr = io.ErrShortWrite
	}
	closeErr := temp.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return "", userErrorCause("errors.sshFile.writeTextFailed", err)
	}
	latest, _, err := readRemoteText(client, remotePath)
	if err != nil {
		return "", err
	}
	if latest.Revision != revision {
		return "", userError("errors.sshFile.textChanged")
	}
	if err := client.PosixRename(tempPath, remotePath); err != nil {
		return "", userErrorCause("errors.sshFile.writeTextFailed", err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func validateRemoteTextTailLines(lines int) error {
	if lines < 0 || lines > maxRemoteTextTailLines {
		return userError("errors.sshFile.textTailInvalid")
	}
	return nil
}

// readRemoteTextTail 只读取文件末尾并保留最后 lines 行。返回内容不是完整文件时 Truncated 为 true，不能据此保存。
func readRemoteTextTail(client *sftp.Client, remotePath string, lines int) (RemoteTextFile, os.FileMode, error) {
	info, err := client.Lstat(remotePath)
	if err != nil {
		return RemoteTextFile{}, 0, userErrorCause("errors.sshFile.readTextFailed", err)
	}
	if !info.Mode().IsRegular() {
		return RemoteTextFile{}, 0, userError("errors.sshFile.textNotRegular")
	}
	file, err := client.Open(remotePath)
	if err != nil {
		return RemoteTextFile{}, 0, userErrorCause("errors.sshFile.readTextFailed", err)
	}
	defer file.Close()
	data, fromStart, err := readRemoteTailBytes(file, info.Size(), lines)
	if err != nil {
		return RemoteTextFile{}, 0, userErrorCause("errors.sshFile.readTextFailed", err)
	}
	if !fromStart {
		if index := bytes.IndexByte(data, '\n'); index >= 0 {
			data = data[index+1:]
		} else {
			data = trimLeadingPartialRune(data)
		}
	}
	data, dropped := keepLastLines(data, lines)
	if !utf8.Valid(data) || containsNul(data) {
		return RemoteTextFile{}, 0, userError("errors.sshFile.textInvalidEncoding")
	}
	sum := sha256.Sum256(data)
	return RemoteTextFile{
		Content:   string(data),
		Revision:  hex.EncodeToString(sum[:]),
		Truncated: !fromStart || dropped,
	}, info.Mode().Perm(), nil
}

// readRemoteTailBytes 从小窗口向文件开头扩展，直到包含足够的换行或达到完整读取上限。
func readRemoteTailBytes(file io.ReaderAt, size int64, lines int) ([]byte, bool, error) {
	if size <= 0 {
		return []byte{}, true, nil
	}
	window := int64(remoteTextTailWindow)
	for {
		if window > size {
			window = size
		}
		start := size - window
		data, err := io.ReadAll(io.NewSectionReader(file, start, window))
		if err != nil {
			return nil, false, err
		}
		fromStart := start == 0
		if fromStart || bytes.Count(data, []byte{'\n'}) > lines || window >= int64(remoteTextFileLimit) {
			return data, fromStart, nil
		}
		next := window * 2
		if next > int64(remoteTextFileLimit) {
			next = int64(remoteTextFileLimit)
		}
		if next <= window {
			return data, fromStart, nil
		}
		window = next
	}
}

func keepLastLines(data []byte, lines int) ([]byte, bool) {
	if lines <= 0 || len(data) == 0 {
		return data, false
	}
	index := len(data)
	if data[index-1] == '\n' {
		index--
	}
	found := 0
	for index > 0 {
		index--
		if data[index] != '\n' {
			continue
		}
		found++
		if found == lines {
			return data[index+1:], true
		}
	}
	return data, false
}

func trimLeadingPartialRune(data []byte) []byte {
	for dropped := 0; dropped < utf8.UTFMax && len(data) > 0 && !utf8.Valid(data); dropped++ {
		data = data[1:]
	}
	return data
}

// ReadRemoteTextFile 读取远程文本。tailLines 为 0 时读取完整文件；大于 0 时只返回末尾相应行数。
func (s *FileService) ReadRemoteTextFile(ctx context.Context, sourceID, remotePath string, tailLines int) (file RemoteTextFile, err error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	defer func() {
		// 编辑器关闭会取消 Wails 调用，不能再向已取消的 Promise 返回错误。
		if errors.Is(ctx.Err(), context.Canceled) {
			file, err = RemoteTextFile{}, nil
		}
	}()
	if err := validateRemoteTextTailLines(tailLines); err != nil {
		return RemoteTextFile{}, err
	}
	remotePath, err = remoteTextPath(remotePath)
	if err != nil {
		return RemoteTextFile{}, err
	}
	_, connection, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return RemoteTextFile{}, err
	}
	session, err := s.acquirePersistentSFTP(ctx, sourceID, connection)
	if err != nil {
		return RemoteTextFile{}, err
	}
	defer s.releasePersistentSFTP(session)
	var result RemoteTextFile
	if tailLines == 0 {
		result, _, err = readRemoteText(session.sftp, remotePath)
	} else {
		result, _, err = readRemoteTextTail(session.sftp, remotePath, tailLines)
	}
	if err != nil {
		s.invalidatePersistentSFTP(sourceID, session)
	}
	return result, err
}

func (s *FileService) SaveRemoteTextFile(ctx context.Context, sourceID, remotePath, content, revision string) (string, error) {
	remotePath, err := remoteTextPath(remotePath)
	if err != nil {
		return "", err
	}
	_, connection, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	session, err := s.acquirePersistentSFTP(ctx, sourceID, connection)
	if err != nil {
		return "", err
	}
	defer s.releasePersistentSFTP(session)
	return saveRemoteText(session.sftp, remotePath, content, revision)
}
