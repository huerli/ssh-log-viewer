# 更新服务器部署

## 使用方法

客户端检查接口：`https://64.81.112.231:9443/ssh-log-viewer/latest.json`。

GitHub 仓库 Actions Secret `DEPLOY_SSH_PRIVATE_KEY` 保存专用 Ed25519 私钥；服务器 root 的 `authorized_keys` 配置对应公钥。主机密钥固定在 `scripts/update-server-known-hosts`，变更时应核实服务器指纹后更新。

推送版本与 package.json 一致的 V/v 标签后，现有四平台流水线测试、构建并校验全部安装包，上传 GitHub Release 草稿资源和服务器，最后公开 GitHub Release。安装包位于 `/srv/ssh-log-viewer/releases/<tag>/`，服务器校验 SHA-256 后原子更新 `latest.json`。上传失败可重跑服务器部署任务；当前完整版本在上传期间继续可用。

HTTPS 复用 `/opt/webdav` 的 Caddy，新增只读挂载 `/srv/ssh-log-viewer`。`/ssh-log-viewer/*` 提供静态更新文件，其他路径仍交给 WebDAV。证书沿用现有 IP 证书，`webdav-ip-renew.timer` 续期并强制重载同一个 Caddy 服务。

本地服务调整前备份为 `/opt/webdav/Caddyfile.before-ssh-updates` 和 `/opt/webdav/compose.yaml.before-ssh-updates`。

客户端固定信任此 HTTPS origin 及当前版本路径，保留平台/架构、大小与 SHA-256 校验和安装前二次校验。不跳过证书验证。GitHub 发布页仍用于展示发布说明和手动下载。

旧客户端仍使用 GitHub 更新接口；需先安装含新更新源的版本，之后检查与下载均走服务器。
