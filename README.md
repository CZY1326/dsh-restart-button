# @czy1326/dsh-restart-button

给 DeepSeek Harness 桌面端加一个「结束进程 → 立刻拉起」的重启入口：聊天标题栏右上角的圆形箭头，
可选再往前一步，用一个小补丁把「重启」加进托盘菜单。

A restart control for the DeepSeek Harness desktop app: a circular arrow in the conversation
header that stops the process and starts it again, plus an optional patch that also adds a
"restart" entry to the tray menu.

按钮位于聊天标题栏右上角、「打开方式」选择器（文件管理器 / git bash）**左边**。

## 它做了什么 / What it does

顶栏那个圆形箭头注册在 `conversation.session.header.actions` 槽位，渲染在「打开方式」
（文件管理器 / git bash 选择器）左边，尺寸和旁边的小按钮一致（28×28、15px 图标）。

点击后按顺序尝试两条通道：

| 顺序 | 通道 | 前置条件 | 行为 |
| --- | --- | --- | --- |
| 1 | `dsh-app://app/__dsh-restart` | 打了下面的可选补丁 | Electron 自己 `app.relaunch()`，优雅重启 |
| 2 | `POST /dsh-restart-button/restart` | 无（纯插件即可） | 宿主插件派生一个脱离的 shell：等 2 秒 → 按进程映像名结束应用 → 轮询等进程真的消失 → 重新拉起 exe |

第 2 条是保险，保证「没打补丁也能用」；它不是优雅退出，正在跑的任务会被直接掐断
（会话与任务记录都已落盘，重开即可续上）。

helper 的三条安全措施：**启动前先确认 exe 还在**（不在就只记日志、什么都不杀，避免"杀完起不来"）、
**杀完轮询 `tasklist` 等映像真正消失再拉起**（最多等约 30 秒）、**每一步都写日志**到
`%TEMP%\dsh-restart-button.log`。

The header button works out of the box. The patch only upgrades path 2 to a graceful
`app.relaunch()` and adds the tray entry.

## 安装 / Install

```powershell
# 推荐：从 npm 装（发布后免构建，也不用 clone 仓库）
dsh plugin add @czy1326/dsh-restart-button

# 或者直接从 GitHub 装
dsh plugin add git+https://github.com/CZY1326/dsh-restart-button.git

# GitHub 简写（npm/pnpm 语义）
dsh plugin add github:CZY1326/dsh-restart-button
```

装完重启一次应用（或刷新页面）即可看到按钮。

> 仓库里提交的就是可直接运行的 JS（`lib/index.js`、`lib/client.js`），`package.json` 没有
> `prepare`/`postinstall` 脚本，所以安装时**不需要构建**，也不需要给 pnpm 开 `allowBuilds`。
> 如果你的网络把 `github.com` 改写到了镜像/代理而推送拉取失败，把地址写成
> `git+https://github.com:443/CZY1326/dsh-restart-button.git` 可绕过 URL 重写。

> 桌面端的 profile 由 Electron 应用独占管理，装插件前请**完全退出应用**，否则 profile 会被占用。

## 可选：打补丁，把「重启」加进托盘 / Optional tray patch

补丁直接改打包进 `app.asar` 的 `lib/main.js`（Electron 主进程），做两件事：

1. 托盘菜单在「打开」「退出」之间插入「重启 DeepSeek Harness」（与另外两项同样的格式）；
2. `dsh-app://app/__dsh-restart` 路由 → `app.relaunch(); quitWithoutConfirmation();`。

```powershell
# 关闭应用后执行；先加 --dry-run 看它要改什么
node scripts/patch-asar.cjs --dry-run
node scripts/patch-asar.cjs
```

脚本会自己找到 `app.asar`（常见安装目录、`Programs\*deepseek*`，以及正在运行的应用 exe 所在目录）；
找不到时把 `/dsh-restart-button/ping` 返回的 `asar` 传给 `--asar` 即可。

- **等长原地补丁**：asar 是一个带 JSON 索引的大文件，长度一变后面所有条目都要整体搬家。
  所以补丁把插入的字节数从旁边的文档注释里原样抠回来（注释改写到完全相同的宽度），
  文件长度、索引偏移、其他条目全部不变。
- **版本相关**：脚本内置对 `lib/main.js` 的 sha256 指纹，只认它写过的那几个版本。
  版本对不上就拒绝执行（不会写坏文件），此时顶栏按钮照常可用。
- **可还原**：原始字节写在 `<app.asar>.dsh-restart-button.bak`，清单在同名 `.json` 里。

```powershell
node scripts/restore-asar.cjs --check   # 看状态：original / patched / unknown
node scripts/restore-asar.cjs           # 还原（应用需先退出）
```

打了补丁后，应用升级会覆盖 `app.asar`，托盘那项会消失，需要重新打补丁。

### 当前支持的版本 / Supported builds

| 应用版本 | 状态 |
| --- | --- |
| 0.2.1-rc.2 | ✅ 已内置指纹 |
| 0.2.1-rc.3 | ✅ 已内置指纹（`lib/main.js` 与 rc.2 只差版本号字符串） |

其他版本：脚本会打印 `sha256`，提 issue 附上即可加进来。

> 自定义安装目录（例如装在 `D:\Tools\...`）时脚本的自动探测找不到 `app.asar`，
> 把 `/dsh-restart-button/ping` 返回的 `asar` 传给 `--asar` 即可。

## 卸载 / Uninstall

```powershell
dsh plugin remove @czy1326/dsh-restart-button
node scripts/restore-asar.cjs   # 只在你打过补丁时需要
```

## 实现说明 / How it works

```
dsh-restart-button/
├── lib/index.js       宿主半边：注册 /ping 与 /restart 两条路由，派生脱离的重启 shell
├── lib/client.js      界面半边：顶栏圆形箭头（slot: conversation.session.header.actions）
├── cordis.patch.yml   bundle 补丁：把这个包插进 profile 的插件列表
└── scripts/           可选的 asar 补丁与还原
```

- 宿主侧不依赖 Electron API，所以「纯插件」也能重启：`spawn(cmd.exe, ["/c", helper.cmd], { detached: true, stdio: "ignore" })`，
  helper 先 `taskkill /F /IM "<exe>"`，轮询到映像消失后 `start "" "<exe>"`；它自己的映像名是 `cmd.exe`，不会被自己杀掉。
  （注意 `cmd.exe` 不吃 Node 的 MSVCRT 引号转义：给 `spawn` 传单个脚本路径而不是带引号的内联命令。）
- `/restart` 只接受 `POST` 且要求 `x-dsh-restart: 1` 头，避免爬虫或别的标签页误触发。
- 按钮在非桌面壳（普通浏览器里的 `http://127.0.0.1:<port>`）不渲染：`location.protocol !== "dsh-app:"` 时直接返回。

### 自检 / Self-test

```powershell
# 宿主是否认出桌面端、重启目标是谁、app.asar 在哪
curl http://127.0.0.1:<port>/dsh-restart-button/ping
# → {"ok":true,"desktop":true,"exe":"…\\DeepSeek Harness.exe","resources":"…","asar":"…\\resources\\app.asar"}

# 只跑「派生 helper」这一段，不杀任何进程，结果写进 %TEMP%\dsh-restart-button-probe.txt
curl -X POST -H "x-dsh-restart: 1" "http://127.0.0.1:<port>/dsh-restart-button/restart?probe=1"
```

第二条能写出一行 `probe exe=… image=…`，就说明宿主能正常派生脱离的 helper；
真正点按钮时只是把它换成 `taskkill` + `start`。

## 已知限制 / Limits

- 托盘那一项**只能**靠补丁：托盘菜单在 Electron 主进程里，插件运行在宿主进程，够不到。
  长期正解是给上游提 PR / issue（`DeepSeek Harness` 桌面端）。
- 纯插件模式是硬退出，不是优雅退出。
- 补丁是版本相关的等长改写，不是通用补丁器。

## License

MIT
