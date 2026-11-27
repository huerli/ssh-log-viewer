# SSH Log Viewer 项目约定

## 代码提交约定

每次修改或更新代码后，必须进行 Git 提交（`git commit`），无需再次请求提交确认。

- 提交前核对变更文件，使用简洁清晰的提交信息（沿用仓库的 Conventional Commits 风格，如 `feat:`、`fix:`、`docs:`）。
- 除非用户明确要求，否则不要自动执行 `git push`。

## 打包与安装约定

用户要求每次完成应用修改后，都在本机打包并安装，无需再次请求打包或安装确认。

1. 递增补丁版本，同步更新 `package.json` 和 README 快速开始中的当前版本。
2. 运行 `pnpm run build` 和相关测试。
3. 运行 `pnpm exec electron-builder --linux deb --x64 --publish never` 生成 Linux x64 安装包。
4. 将新 DEB 的绝对路径传给 `pkcon --plain --allow-untrusted install-local`。系统要求桌面认证时让用户完成认证，并继续等待安装结果。
5. 用 `dpkg-query -W ssh-log-viewer` 和 `dpkg -V ssh-log-viewer` 核对安装版本和软件包文件。
6. 按“代码提交约定”提交本次修改。
