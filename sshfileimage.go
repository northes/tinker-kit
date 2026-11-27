package main

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"path"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

const remoteImageFileLimit = 10 << 20

// remoteImageMIMETypes 覆盖前端 ssh-files 的 imageFileExtensions 全集，并补齐 png、jpg、jpeg。
// 浏览器无法解码的格式（如 heic、raw）仍然允许读取，由前端按解码失败展示。
var remoteImageMIMETypes = map[string]string{
	".avif": "image/avif",
	".bmp":  "image/bmp",
	".gif":  "image/gif",
	".heic": "image/heic",
	".heif": "image/heif",
	".ico":  "image/x-icon",
	".jfif": "image/jpeg",
	".jif":  "image/jpeg",
	".jpe":  "image/jpeg",
	".jpeg": "image/jpeg",
	".jpg":  "image/jpeg",
	".png":  "image/png",
	".raw":  "image/x-raw",
	".svg":  "image/svg+xml",
	".tif":  "image/tiff",
	".tiff": "image/tiff",
	".webp": "image/webp",
}

// RemoteImageFile 是可直接用于 img 的远程图片内容及元数据。
type RemoteImageFile struct {
	Name     string `json:"name"`
	MIMEType string `json:"mimeType"`
	Size     int64  `json:"size"`
	DataURL  string `json:"dataURL"`
}

// remoteImagePath 校验远程图片路径并返回规范化路径与扩展名对应的 MIME 类型。
func remoteImagePath(value string) (string, string, error) {
	if strings.TrimSpace(value) == "" || strings.ContainsRune(value, '\x00') {
		return "", "", userError("errors.sshFile.imagePathInvalid")
	}
	normalized := normalizedRemotePath(value)
	if normalized == "/" {
		return "", "", userError("errors.sshFile.imagePathInvalid")
	}
	extension := strings.ToLower(path.Ext(normalized))
	mimeType, ok := remoteImageMIMETypes[extension]
	if !ok {
		return "", "", userErrorParams("errors.sshFile.imageTypeUnsupported", map[string]any{"extension": extension})
	}
	return normalized, mimeType, nil
}

func readRemoteImage(client *sftp.Client, remotePath, mimeType string) (RemoteImageFile, error) {
	info, err := client.Lstat(remotePath)
	if err != nil {
		return RemoteImageFile{}, userErrorCause("errors.sshFile.readImageFailed", err)
	}
	if !info.Mode().IsRegular() {
		return RemoteImageFile{}, userError("errors.sshFile.imageNotRegular")
	}
	if info.Size() > remoteImageFileLimit {
		return RemoteImageFile{}, userError("errors.sshFile.imageTooLarge")
	}
	file, err := client.Open(remotePath)
	if err != nil {
		return RemoteImageFile{}, userErrorCause("errors.sshFile.readImageFailed", err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, remoteImageFileLimit+1))
	if err != nil {
		return RemoteImageFile{}, userErrorCause("errors.sshFile.readImageFailed", err)
	}
	if len(data) > remoteImageFileLimit {
		return RemoteImageFile{}, userError("errors.sshFile.imageTooLarge")
	}
	return RemoteImageFile{
		Name:     path.Base(remotePath),
		MIMEType: mimeType,
		Size:     int64(len(data)),
		DataURL:  "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data),
	}, nil
}

// ReadRemoteImageFile 通过持久 SFTP 读取远程普通图片文件，返回 data URL 与元数据。
// 单个文件上限 10 MiB；取消语义与 ReadRemoteTextFile 一致，不向已关闭的预览弹窗抛错。
func (s *FileService) ReadRemoteImageFile(ctx context.Context, sourceID, remotePath string) (file RemoteImageFile, err error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	defer func() {
		// 预览弹窗关闭会取消 Wails 调用，不能再向已取消的 Promise 返回错误。
		if errors.Is(ctx.Err(), context.Canceled) {
			file, err = RemoteImageFile{}, nil
		}
	}()
	remotePath, mimeType, err := remoteImagePath(remotePath)
	if err != nil {
		return RemoteImageFile{}, err
	}
	_, connection, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return RemoteImageFile{}, err
	}
	session, err := s.acquirePersistentSFTP(ctx, sourceID, connection)
	if err != nil {
		return RemoteImageFile{}, err
	}
	defer s.releasePersistentSFTP(session)
	result, err := readRemoteImage(session.sftp, remotePath, mimeType)
	if err != nil {
		s.dropPersistentSFTPIfLost(sourceID, session, err)
	}
	return result, err
}
