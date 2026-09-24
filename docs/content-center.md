# k-File 内容中心接入

本项目参考本地 `k-file/sdk/java` 的开放 API。对象存储、密钥和默认上传源在 k-File 侧配置；本项目不直接接触对象存储凭据。现阶段管理台支持 JPEG、PNG、WebP 图片上传，并在草稿的 `mediaObjectKeys` JSON 数组中保存 `{fileId, name, contentType}`，不保存 CDN URL。原有普通对象键字符串仍可读取。没有实现 Java SDK 的分片上传、批量删除或自动清理孤儿文件。

## 配置

1. 在 k-File 后台创建开放应用，配置默认上传源并取得应用令牌。
2. API 与 Publisher Worker 进程都设置 `CONTENT_CENTER_URL`（k-File 的基础地址）、`CONTENT_CENTER_TOKEN_REF=env:KFILE_APP_TOKEN` 和 `KFILE_APP_TOKEN`。令牌只在服务端解析，不写入数据库，也不返回浏览器。
3. 在本项目后台的“系统设置”保存图片大小上限、下载和 CDN 链接有效期。这些非敏感参数存在 `system_setting`，下次请求立即生效。上传路径固定为空，上传源使用内容中心的默认配置。
4. 默认上传源返回的预签名 PUT 地址必须能从管理员浏览器访问。OSS 或 MinIO 需要允许管理台来源跨域执行 `PUT` 并携带 `Content-Type`。k-File 的预览地址也须能从浏览器访问。

## 上传链路

管理台调用 `POST /api/v1/media/uploads/init`，API 使用应用令牌向 k-File 申请预签名地址。浏览器使用与初始化请求完全一致的 `Content-Type` 直接 PUT 图片字节，成功后调用 `POST /api/v1/media/uploads/complete`；API 让 k-File 读取对象的权威元数据并返回媒体引用。草稿自动保存该引用，删除草稿中的引用只解除关联，不删除 k-File 中的文件。预览通过 `GET /api/v1/media/:fileId/cdn-link` 获取链接；另可通过 `GET /api/v1/media/:fileId/download-link` 获取限时下载地址。这些接口均要求运营人员身份。

预签名地址会短时返回浏览器，应用令牌不会返回浏览器。请勿在日志、分析事件或错误上报中记录完整预签名 URL。图片用于资料编辑、模型识别和资料引用。
